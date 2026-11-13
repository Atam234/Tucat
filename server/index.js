import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, config, dirs } from './config.js';
import { analyze, probe } from './analysis.js';
import { agentMode, runAgent } from './agent.js';
import { computeLayout, freshEdit } from './edit.js';
import { limit, usageSummary } from './limits.js';
import { getJob, startRender } from './render.js';
import { TOOL_DEFS, describeStep, runTool } from './tools.js';

const app = express();
if (config.trustProxy) app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.use('/media', express.static(dirs.uploads, { maxAge: '1d' }));
app.use('/renders', express.static(dirs.renders));

// ---------- project store (memory + JSON sa disk) ----------
const projects = new Map();
const analyses = new Map(); // id → Promise<analysis>
const busy = new Set(); // isang agent run kada project
const ID_RE = /^[0-9a-f-]{36}$/;
const MAX_HISTORY = 30;

function persist(p) {
  fs.writeFile(path.join(dirs.projects, `${p.id}.json`), JSON.stringify(p), () => {});
}

function load(id) {
  if (!ID_RE.test(id)) return null;
  if (projects.has(id)) return projects.get(id);
  try {
    const p = JSON.parse(fs.readFileSync(path.join(dirs.projects, `${id}.json`), 'utf8'));
    projects.set(id, p);
    return p;
  } catch { return null; }
}

function analysisFor(p) {
  if (!analyses.has(p.id)) {
    const job = analyze(p.source.file, p.source).then((an) => { p.envelope = an.envelope; p.scenes = an.scenes; persist(p); return an; });
    job.catch((e) => { console.error('analysis failed:', e.message); analyses.delete(p.id); });
    analyses.set(p.id, job);
  }
  return analyses.get(p.id);
}

function view(p, ip) {
  const layout = computeLayout(p.edit);
  return {
    id: p.id, name: p.name,
    source: { url: p.source.url, duration: p.source.duration, width: p.source.width, height: p.source.height, hasAudio: p.source.hasAudio },
    edit: p.edit, layout,
    envelope: p.envelope || null, scenes: p.scenes || [],
    chat: p.chat,
    canUndo: p.undo.length > 0, canRedo: p.redo.length > 0,
    mode: agentMode(), usage: usageSummary(ip),
  };
}

/** Patakbuhin ang mutation; i-save ang snapshot para sa undo kung may nabago. */
async function mutate(p, fn) {
  const before = JSON.stringify(p.edit);
  try { return await fn(); } finally {
    if (JSON.stringify(p.edit) !== before) {
      p.undo.push(before);
      if (p.undo.length > MAX_HISTORY) p.undo.shift();
      p.redo = [];
    }
    persist(p);
  }
}

const withProject = (req, res, next) => {
  req.project = load(req.params.id);
  if (!req.project) return res.status(404).json({ error: 'Hindi makita ang project.' });
  next();
};
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e);
  if (!res.headersSent) res.status(e.status || 500).json({ error: e.status ? e.message : 'May error sa server.' });
});
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

// ---------- upload ----------
const EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv']);
const upload = multer({
  storage: multer.diskStorage({
    destination: dirs.uploads,
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, EXT.has(path.extname(file.originalname).toLowerCase())),
}).single('video');

app.post('/api/projects', limit('upload', { perMinute: 4, perDay: config.uploadsPerDay }), (req, res) => {
  upload(req, res, (err) => wrap(async () => {
    if (err) throw bad(err.code === 'LIMIT_FILE_SIZE' ? `Masyadong malaki ang file (max ${config.maxUploadMb} MB).` : 'Nabigo ang upload.');
    if (!req.file) throw bad('Mag-upload ng video file (.mp4, .mov, .webm, .mkv).');
    let meta;
    try {
      meta = await probe(req.file.path);
      if (meta.duration > config.maxVideoMinutes * 60) throw new Error(`Masyadong mahaba ang video (max ${config.maxVideoMinutes} minuto).`);
    } catch (e) {
      fs.rm(req.file.path, { force: true }, () => {});
      throw bad(e.message.startsWith('ffprobe') ? 'Hindi mabasa ang video file.' : e.message);
    }
    const p = {
      id: crypto.randomUUID(),
      name: path.basename(req.file.originalname, path.extname(req.file.originalname)).slice(0, 60),
      source: { ...meta, file: req.file.path, url: `/media/${req.file.filename}` },
      edit: freshEdit(meta.duration),
      chat: [], undo: [], redo: [],
    };
    projects.set(p.id, p);
    persist(p);
    analysisFor(p); // sa background; hihintayin ng tools kung kailangan
    res.json(view(p, req.ip));
  })(req, res));
});

app.get('/api/projects/:id', withProject, (req, res) => {
  if (!req.project.envelope) analysisFor(req.project);
  res.json(view(req.project, req.ip));
});

// ---------- AI agent ----------
app.post('/api/projects/:id/chat', withProject, limit('chat', { perMinute: config.chatPerMinute, perDay: config.chatPerDay }), wrap(async (req, res) => {
  const p = req.project;
  const text = String(req.body?.message ?? '').trim().slice(0, 1000);
  if (!text) throw bad('Walang laman ang mensahe.');
  if (busy.has(p.id)) throw bad('May tumatakbo pang edit. Hintayin munang matapos.', 409);
  busy.add(p.id);
  try {
    const ctx = { analysis: () => analysisFor(p) };
    let out;
    try {
      out = await mutate(p, () => runAgent(p, text, ctx));
    } catch (e) {
      out = { reply: e.message, steps: [], failed: true };
    }
    p.chat.push({ role: 'user', text }, { role: 'assistant', text: out.reply, steps: out.steps, failed: out.failed });
    if (p.chat.length > 60) p.chat.splice(0, p.chat.length - 60);
    persist(p);
    res.json(view(p, req.ip));
  } finally { busy.delete(p.id); }
}));

// ---------- direktang tools mula sa UI (walang LLM, walang gastos) ----------
const UI_TOOLS = new Set(TOOL_DEFS.map((t) => t.function.name));
app.post('/api/projects/:id/op', withProject, limit('op', { perMinute: 120 }), wrap(async (req, res) => {
  const p = req.project;
  const { op, args } = req.body || {};
  if (busy.has(p.id)) throw bad('May tumatakbo pang edit.', 409);
  if (op === 'undo' || op === 'redo') {
    const [from, to] = op === 'undo' ? [p.undo, p.redo] : [p.redo, p.undo];
    if (from.length) { to.push(JSON.stringify(p.edit)); p.edit = JSON.parse(from.pop()); persist(p); }
    return res.json(view(p, req.ip));
  }
  if (!UI_TOOLS.has(op)) throw bad('Hindi kilalang operation.');
  const result = await mutate(p, () => runTool(p, op, args, { analysis: () => analysisFor(p) }));
  res.json({ ...view(p, req.ip), result: describeStep(op, args || {}, result), failed: Boolean(result.error) });
}));

// ---------- export ----------
app.post('/api/projects/:id/render', withProject, limit('render', { perMinute: 3, perDay: config.rendersPerDay }), wrap(async (req, res) => {
  const quality = Number(req.body?.quality) === 1080 ? 1080 : 720;
  let job;
  try { job = startRender(req.project, quality); } catch (e) { throw bad(e.message, 503); }
  res.json(job);
}));

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Hindi makita ang render job.' });
  res.json(job);
});

app.listen(config.port, () => {
  console.log(`Tucat → http://localhost:${config.port}  (AI mode: ${agentMode()}${agentMode() === 'ai' ? `, model ${config.model}` : ' — walang OPENROUTER_API_KEY'})`);
});
