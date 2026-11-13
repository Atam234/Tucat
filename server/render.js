// EDL → ffmpeg filter graph → MP4. Lahat ng argumento ay ipinapasa bilang array (walang shell),
// at ang text overlays ay dumadaan sa textfile kaya walang filter injection mula sa user/AI text.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { dirs } from './config.js';
import { clipDur, computeLayout } from './edit.js';

const FONT = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
].find((f) => fs.existsSync(f));

const LOOKS = {
  none: '',
  cinematic: 'eq=contrast=1.12:saturation=0.9:brightness=-0.02,colorbalance=rs=-0.06:bs=0.08:rh=0.06:bh=-0.06,vignette=PI/5',
  warm: 'colorbalance=rs=0.08:bs=-0.08:rm=0.05:bm=-0.05,eq=saturation=1.1',
  cool: 'colorbalance=rs=-0.07:bs=0.09:rm=-0.04:bm=0.05',
  bw: 'hue=s=0,eq=contrast=1.15',
  vintage: 'curves=preset=vintage,eq=saturation=0.8,vignette=PI/4.5',
  vivid: 'eq=saturation=1.45:contrast=1.08',
};
const RATIOS = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5 };
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

export function outputSize(source, aspect, quality = 720) {
  const ratio = RATIOS[aspect] || source.width / source.height;
  const short = Math.min(quality, aspect === 'source' ? Math.min(source.width, source.height) : quality);
  return ratio >= 1 ? { w: even(short * ratio), h: even(short) } : { w: even(short), h: even(short / ratio) };
}

function atempo(speed) {
  const parts = [];
  let s = speed;
  while (s > 2) { parts.push('atempo=2'); s /= 2; }
  while (s < 0.5) { parts.push('atempo=0.5'); s /= 0.5; }
  if (Math.abs(s - 1) > 1e-3) parts.push(`atempo=${s.toFixed(4)}`);
  return parts;
}

function wrapText(text, maxChars) {
  const lines = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && (line + ' ' + word).length > maxChars) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
    }
    if (line) lines.push(line);
  }
  return lines.slice(0, 6);
}

export function buildArgs(project, outFile, { quality = 720, textDir }) {
  const { edit, source } = project;
  const layout = computeLayout(edit);
  const { w, h } = outputSize(source, edit.aspect, quality);
  const n = edit.clips.length;
  const args = ['-y', '-v', 'error', '-nostdin', '-progress', 'pipe:1'];
  const graph = [];

  edit.clips.forEach((c, i) => {
    args.push('-ss', c.start.toFixed(3), '-t', (c.end - c.start).toFixed(3), '-i', source.file);
    const v = [`setpts=(PTS-STARTPTS)/${c.speed}`];
    if (c.zoom > 1) v.push(`crop=iw/${c.zoom}:ih/${c.zoom}`);
    v.push(`scale=${w}:${h}:force_original_aspect_ratio=increase`, `crop=${w}:${h}`);
    if (LOOKS[c.filter]) v.push(LOOKS[c.filter]);
    v.push('fps=30', 'format=yuv420p', 'setsar=1', 'settb=AVTB');
    graph.push(`[${i}:v:0]${v.join(',')}[v${i}]`);

    const fmt = 'aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo';
    if (source.hasAudio) {
      const a = ['asetpts=PTS-STARTPTS', ...atempo(c.speed)];
      if (c.volume !== 1) a.push(`volume=${c.volume}`);
      graph.push(`[${i}:a:0]${a.join(',')},${fmt}[a${i}]`);
    } else {
      graph.push(`anullsrc=r=44100:cl=stereo,atrim=duration=${clipDur(c).toFixed(3)},${fmt}[a${i}]`);
    }
  });

  let vLast = 'v0', aLast = 'a0';
  if (n > 1 && layout.xfade) {
    for (let i = 1; i < n; i++) {
      graph.push(`[${vLast}][v${i}]xfade=transition=${edit.transition.type}:duration=${layout.xfade}:offset=${layout.items[i].tStart.toFixed(3)}[xv${i}]`);
      graph.push(`[${aLast}][a${i}]acrossfade=d=${layout.xfade}[xa${i}]`);
      vLast = `xv${i}`; aLast = `xa${i}`;
    }
  } else if (n > 1) {
    graph.push(`${edit.clips.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${n}:v=1:a=1[cv][ca]`);
    vLast = 'cv'; aLast = 'ca';
  }

  const total = layout.total;
  const post = [];
  const sizes = { small: 0.04, medium: 0.06, large: 0.09 };
  edit.texts.forEach((t, i) => {
    if (!FONT) return;
    const fs_ = Math.round(Math.max(w, h) * sizes[t.size] * (w < h ? 0.75 : 1));
    const lines = wrapText(t.text, Math.max(6, Math.floor((w * 0.9) / (fs_ * 0.62))));
    const lh = Math.round(fs_ * 1.3);
    const top = { top: h * 0.08, center: (h - lines.length * lh) / 2, bottom: h * 0.86 - lines.length * lh }[t.position];
    const look = t.style === 'box' ? `box=1:boxcolor=black@0.55:boxborderw=${Math.round(fs_ * 0.3)}` : `borderw=${Math.max(2, Math.round(fs_ * 0.07))}:bordercolor=black@0.85`;
    lines.forEach((line, j) => { // drawtext ay hindi nagra-wrap, kaya isang drawtext kada linya (naka-center ang bawat isa)
      const file = path.join(textDir, `t${i}_${j}.txt`);
      fs.writeFileSync(file, line);
      post.push(`drawtext=fontfile='${FONT}':textfile='${file}':expansion=none:fontsize=${fs_}:fontcolor=0x${t.color.slice(1)}:x=(w-text_w)/2:y=${Math.round(top + j * lh)}:${look}:enable='between(t,${t.start},${t.end})'`);
    });
  });
  if (edit.fadeIn > 0) post.push(`fade=t=in:st=0:d=${Math.min(edit.fadeIn, total / 2)}`);
  if (edit.fadeOut > 0) { const d = Math.min(edit.fadeOut, total / 2); post.push(`fade=t=out:st=${(total - d).toFixed(3)}:d=${d}`); }
  graph.push(`[${vLast}]${post.length ? post.join(',') : 'null'}[vout]`);

  const ap = [];
  if (edit.audio.mute) ap.push('volume=0');
  else {
    if (edit.audio.volume !== 1) ap.push(`volume=${edit.audio.volume}`);
    if (edit.audio.normalize && source.hasAudio) ap.push('loudnorm=I=-14:TP=-1.5:LRA=11', 'aresample=44100');
  }
  if (edit.fadeIn > 0) ap.push(`afade=t=in:st=0:d=${Math.min(edit.fadeIn, total / 2)}`);
  if (edit.fadeOut > 0) { const d = Math.min(edit.fadeOut, total / 2); ap.push(`afade=t=out:st=${(total - d).toFixed(3)}:d=${d}`); }
  graph.push(`[${aLast}]${ap.length ? ap.join(',') : 'anull'}[aout]`);

  args.push('-filter_complex', graph.join(';'), '-map', '[vout]', '-map', '[aout]',
    '-t', total.toFixed(3),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', outFile);
  return { args, total };
}

const jobs = new Map();
let running = 0;
const MAX_CONCURRENT = 2;

export const getJob = (id) => jobs.get(id);

export function startRender(project, quality) {
  if (running >= MAX_CONCURRENT) throw new Error('Abala pa ang renderer. Subukan ulit maya-maya.');
  const id = crypto.randomUUID();
  const outFile = path.join(dirs.renders, `${id}.mp4`);
  const textDir = fs.mkdtempSync(path.join(dirs.tmp, 'txt-'));
  const { args, total } = buildArgs(project, outFile, { quality, textDir });
  const job = { id, status: 'running', progress: 0, url: null, error: null };
  jobs.set(id, job);
  running += 1;

  const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  p.stdout.on('data', (d) => {
    const m = [...String(d).matchAll(/out_time_us=(\d+)/g)].pop();
    if (m) job.progress = Math.min(0.99, Number(m[1]) / 1e6 / total);
  });
  p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
  const done = (code) => {
    if (job.status !== 'running') return;
    running -= 1;
    fs.rm(textDir, { recursive: true, force: true }, () => {});
    if (code === 0) Object.assign(job, { status: 'done', progress: 1, url: `/renders/${id}.mp4` });
    else {
      console.error('render failed:', err);
      Object.assign(job, { status: 'error', error: 'Nabigo ang render. Tingnan ang server log.' });
      fs.rm(outFile, { force: true }, () => {});
    }
    setTimeout(() => jobs.delete(id), 6 * 3600 * 1000).unref();
  };
  p.on('error', () => done(1));
  p.on('close', done);
  return job;
}
