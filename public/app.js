// Tucat frontend. Walang API key dito — lahat ng AI request ay dumadaan sa sarili nating backend.
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

const CSS_LOOK = {
  none: '', cinematic: 'contrast(1.12) saturate(.88) brightness(.97)', warm: 'sepia(.28) saturate(1.25)',
  cool: 'saturate(1.05) hue-rotate(-12deg) brightness(1.02)', bw: 'grayscale(1) contrast(1.15)',
  vintage: 'sepia(.5) contrast(.94) saturate(.8)', vivid: 'saturate(1.45) contrast(1.08)',
};
const LOOKS = [
  ['none', 'Orihinal', 'linear-gradient(135deg,#3a4152,#1d2029)'], ['cinematic', 'Cinematic', 'linear-gradient(135deg,#0f3b46,#c7742e)'],
  ['warm', 'Warm', 'linear-gradient(135deg,#f6a43c,#b3402a)'], ['cool', 'Cool', 'linear-gradient(135deg,#3aa0ff,#1b2a6b)'],
  ['bw', 'B&W', 'linear-gradient(135deg,#e6e6e6,#1a1a1a)'], ['vintage', 'Vintage', 'linear-gradient(135deg,#c9a66b,#5b3d2e)'],
  ['vivid', 'Vivid', 'linear-gradient(135deg,#ff3d81,#ffd23d 50%,#22d3a5)'],
];
const AI_CARDS = [
  ['Auto highlights', '30s best parts', 'linear-gradient(135deg,#c8f31d,#128a5a)', 'Gawing 30 segundong highlights reel ang video'],
  ['Alis dead air', 'Jump cuts', 'linear-gradient(135deg,#8b5cf6,#2a1a6b)', 'Alisin ang lahat ng dead air at mahahabang katahimikan'],
  ['Pang-TikTok', '9:16 + punchy', 'linear-gradient(135deg,#ff3d81,#5b1bd1)', 'Gawing pang-TikTok: 9:16, highlights na 20 segundo, vivid look, at normalize ang audio'],
  ['Cinematic vlog', 'Look + fades', 'linear-gradient(135deg,#0f3b46,#c7742e)', 'Gawing cinematic ang buong vlog: cinematic look, fade in at fade out, normalize audio'],
];
const SUGGEST = ['Alisin ang dead air', '30s highlights', 'Cinematic look', 'Pang-TikTok 9:16', 'Bilisan ng 1.5x', 'Lagyan ng title "My Vlog"'];
const TRANS = [['none', 'Wala'], ['fade', 'Fade'], ['dissolve', 'Dissolve'], ['wipeleft', 'Wipe'], ['slideleft', 'Slide'], ['circleopen', 'Circle'], ['fadeblack', 'Dip to black']];

let P = null; // project view mula sa server
let sel = null; // napiling clip id
let t = 0; // timeline time ng playhead
let cur = 0; // index ng clip na tumutugtog
let playing = false;
let busy = false;
let tlZoom = 1;
let pps = 50;

const video = $('video');

// ---------- API ----------
async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}
let toastTimer;
function toast(msg, isErr) {
  const n = $('toast');
  n.textContent = msg; n.className = `show${isErr ? ' err' : ''}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { n.className = ''; }, isErr ? 5000 : 2200);
}
async function op(name, args) {
  if (busy) return;
  try {
    const data = await api(`/api/projects/${P.id}/op`, { op: name, args });
    setProject(data);
    if (data.result) toast(data.result, data.failed);
  } catch (e) { toast(e.message, true); }
}

// ---------- project state ----------
const items = () => P.layout.items;
const clipById = (id) => P.edit.clips.find((c) => c.id === id);
const targetIds = () => (sel ? [sel] : undefined);

function setProject(data) {
  const first = !P || P.id !== data.id;
  P = data;
  if (first) {
    document.body.dataset.view = 'editor';
    location.hash = P.id;
    video.src = P.source.url;
    t = 0; sel = null;
    $('pname').textContent = P.name;
  }
  if (sel && !clipById(sel)) sel = null;
  t = clamp(t, 0, Math.max(0, P.layout.total - 0.01));
  renderAll();
  seek(t);
  if (!P.envelope) pollAnalysis(P.id);
}

async function pollAnalysis(id) {
  for (let i = 0; i < 300 && P?.id === id && !P.envelope; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const d = await api(`/api/projects/${id}`);
      if (P?.id === id && d.envelope) { P.envelope = d.envelope; P.scenes = d.scenes; drawTimeline(); }
    } catch { /* susubukan ulit */ }
  }
}

// ---------- preview player (non-destructive: source video + EDL) ----------
function applyClip() {
  const it = items()[cur], c = clipById(it.id);
  video.playbackRate = c.speed;
  video.style.filter = CSS_LOOK[c.filter] || '';
  video.style.transform = c.zoom > 1 ? `scale(${c.zoom})` : '';
  video.muted = P.edit.audio.mute;
  video.volume = clamp(c.volume * P.edit.audio.volume, 0, 1);
}
function seek(time) {
  t = clamp(time, 0, Math.max(0, P.layout.total - 0.01));
  const list = items();
  cur = Math.max(0, list.findIndex((it) => t >= it.tStart && t < it.tEnd));
  const it = list[cur];
  const src = it.srcStart + (t - it.tStart) * it.speed;
  if (Math.abs(video.currentTime - src) > 0.03) video.currentTime = src;
  applyClip();
  updatePlayUI();
}
function setPlaying(on) {
  playing = on;
  $('play').textContent = on ? '❚❚' : '▶';
  if (on) { if (t >= P.layout.total - 0.05) seek(0); video.play().catch(() => setPlaying(false)); requestAnimationFrame(tick); } else video.pause();
}
function tick() {
  if (!playing || !P) return;
  const list = items(), it = list[cur];
  if (!video.seeking) {
    if (video.currentTime >= it.srcEnd - 0.02 || video.ended) {
      if (cur + 1 >= list.length) { setPlaying(false); t = P.layout.total; updatePlayUI(); return; }
      cur += 1;
      const next = list[cur];
      if (Math.abs(video.currentTime - next.srcStart) > 0.05) video.currentTime = next.srcStart;
      applyClip();
      if (video.paused) video.play().catch(() => {});
      t = next.tStart;
    } else {
      t = clamp(it.tStart + (video.currentTime - it.srcStart) / it.speed, it.tStart, it.tEnd);
    }
    updatePlayUI();
  }
  requestAnimationFrame(tick);
}
function updatePlayUI() {
  const total = P.layout.total;
  $('time').textContent = `${fmt(t)} / ${fmt(total)}`;
  $('playhead').style.left = `${t * pps}px`;
  const e = P.edit;
  let dim = 0;
  if (e.fadeIn > 0 && t < e.fadeIn) dim = 1 - t / e.fadeIn;
  if (e.fadeOut > 0 && t > total - e.fadeOut) dim = Math.max(dim, 1 - (total - t) / e.fadeOut);
  $('fade').style.opacity = dim;
  for (const n of $('texts').children) n.hidden = !(t >= Number(n.dataset.s) && t <= Number(n.dataset.e));
  if (playing) { // panatilihing kita ang playhead
    const sc = $('tlScroll'), x = t * pps;
    if (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth - 40) sc.scrollLeft = x - 40;
  }
}

// ---------- rendering ----------
function fitFrame() {
  if (!P) return;
  const stage = $('stage'), frame = $('frame');
  const [aw, ah] = P.edit.aspect === 'source' ? [P.source.width, P.source.height] : P.edit.aspect.split(':').map(Number);
  const W = stage.clientWidth - 24, H = stage.clientHeight - 54 - 16;
  const s = Math.min(W / aw, H / ah);
  frame.style.width = `${Math.floor(aw * s)}px`; frame.style.height = `${Math.floor(ah * s)}px`;
  frame.style.marginTop = frame.style.marginBottom = 'auto';
}

function renderTexts() {
  const box = $('texts');
  box.replaceChildren();
  const portrait = $('frame').clientWidth < $('frame').clientHeight;
  const size = { small: 4, medium: 6, large: 9 };
  for (const x of P.edit.texts) {
    const n = el('div', `ov ${x.style} pos-${x.position}`);
    n.append(el('span', '', x.text));
    n.style.color = x.color;
    n.style.fontSize = portrait ? `${size[x.size] * 0.75}cqh` : `${size[x.size]}cqw`;
    n.dataset.s = x.start; n.dataset.e = x.end;
    box.append(n);
  }
  updatePlayUI();
}

function drawTimeline() {
  const sc = $('tlScroll'), inner = $('tlInner'), total = P.layout.total;
  const base = (sc.clientWidth - 24) / Math.max(total, 0.1);
  pps = base * tlZoom;
  const width = Math.max(sc.clientWidth - 24, total * pps);
  inner.style.width = `${width}px`;

  // ruler
  const ruler = $('ruler');
  ruler.replaceChildren();
  const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => s * pps >= 64) || 600;
  for (let s = 0; s <= total; s += step) {
    const k = el('div', 'tick', step < 1 ? fmt(s) : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);
    k.style.left = `${s * pps}px`;
    ruler.append(k);
  }

  // clips
  const track = $('clipTrack');
  [...track.querySelectorAll('.clip')].forEach((n) => n.remove());
  items().forEach((it, i) => {
    const c = P.edit.clips[i];
    const n = el('div', `clip${c.id === sel ? ' sel' : ''}`);
    n.style.left = `${it.tStart * pps}px`;
    n.style.width = `${Math.max(2, (it.tEnd - it.tStart) * pps - 1)}px`;
    n.dataset.id = c.id;
    if ((it.tEnd - it.tStart) * pps > 34) {
      n.append(el('span', 'tag', c.id));
      if (c.speed !== 1) n.append(el('span', 'tag', `${c.speed}×`));
      if (c.filter !== 'none') n.append(el('span', 'tag', c.filter));
      if (c.zoom > 1) n.append(el('span', 'tag', `🔍${c.zoom}`));
    }
    track.append(n);
  });

  // waveform sa ilalim ng clips
  const cv = $('wave'), dpr = Math.min(2, window.devicePixelRatio || 1), h = track.clientHeight;
  const cw = Math.min(width, 16000 / dpr);
  cv.width = cw * dpr; cv.height = h * dpr; cv.style.width = `${cw}px`;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  g.fillStyle = '#7fb4ff';
  const env = P.envelope;
  if (env?.length) {
    for (const it of items()) {
      const x0 = it.tStart * pps, x1 = Math.min(cw, it.tEnd * pps);
      for (let x = Math.ceil(x0); x < x1 - 1; x += 2) {
        const src = it.srcStart + ((x - x0) / pps) * it.speed;
        const v = env[Math.min(env.length - 1, Math.floor((src / P.source.duration) * env.length))] || 0;
        const bar = Math.max(1, v * v * (h - 22));
        g.globalAlpha = 0.75;
        g.fillRect(x, h - 4 - bar, 1.2, bar);
      }
    }
  }

  // text track
  const tt = $('textTrack');
  tt.replaceChildren();
  const lanes = []; // dulo ng huling text sa bawat lane, para hindi magpatong
  for (const x of [...P.edit.texts].sort((a, b) => a.start - b.start)) {
    let lane = lanes.findIndex((end) => end <= x.start);
    if (lane < 0) lane = Math.min(lanes.length, 2);
    lanes[lane] = x.end;
    const n = el('div', 'tclip', `T  ${x.text}`);
    n.style.left = `${x.start * pps}px`; n.style.width = `${Math.max(18, (x.end - x.start) * pps)}px`; n.style.top = `${lane * 26}px`;
    const rm = el('button', '', '✕'); rm.title = 'Alisin ang text';
    rm.onclick = (ev) => { ev.stopPropagation(); op('remove_text', { text_ids: [x.id] }); };
    n.append(rm);
    tt.append(n);
  }
  tt.style.height = `${Math.max(1, lanes.length) * 26}px`;
  $('tlInfo').textContent = `${P.edit.clips.length} clip · ${fmt(total)}${P.envelope ? '' : ' · sinusuri ang audio…'}`;
  $('playhead').style.left = `${t * pps}px`;
}

function renderChat(pending) {
  const box = $('msgs');
  box.replaceChildren();
  if (!P.chat.length && !pending) {
    const e = el('div', 'empty');
    e.append(el('b', '', 'Anong edit ang gusto mo?'), document.createTextNode('I-type lang, hal. “alisin ang dead air tapos gawing cinematic”. Ako na ang bahala sa cuts at effects.'));
    box.append(e);
  }
  for (const m of pending ? [...P.chat, { role: 'user', text: pending }] : P.chat) {
    const n = el('div', `msg ${m.role}${m.failed ? ' failed' : ''}`);
    if (m.steps?.length) { const s = el('div', 'steps'); m.steps.forEach((x) => s.append(el('div', 'step', x))); n.append(s); }
    n.append(document.createTextNode(m.text));
    box.append(n);
  }
  if (pending) { const n = el('div', 'msg assistant dots'); n.append(el('i'), el('i'), el('i')); box.append(n); }
  box.scrollTop = box.scrollHeight;
}

function renderControls() {
  const e = P.edit, c = sel ? clipById(sel) : null;
  $('undo').disabled = !P.canUndo; $('redo').disabled = !P.canRedo;
  $('aspect').value = e.aspect;
  $('normalize').checked = e.audio.normalize; $('mute').checked = e.audio.mute;
  $('fades').checked = e.fadeIn > 0 || e.fadeOut > 0;
  $('del').disabled = !c || e.clips.length < 2;
  $('speed').value = String((c || e.clips[0]).speed); $('zoom').value = String((c || e.clips[0]).zoom);
  $('lookScope').textContent = c ? `→ ${c.id}` : '→ lahat';
  $('clipInfo').textContent = c ? `${c.id} · ${fmt(c.start)}–${fmt(c.end)}` : '';
  const active = c ? c.filter : (e.clips.every((x) => x.filter === e.clips[0].filter) ? e.clips[0].filter : null);
  for (const n of $('lookCards').children) n.classList.toggle('on', n.dataset.v === active);
  for (const n of $('transChips').children) n.classList.toggle('on', n.dataset.v === e.transition.type);
  $('mode').textContent = P.mode === 'ai' ? '' : 'demo mode';
  $('quota').textContent = `${P.usage.chatUsedToday}/${P.usage.chatPerDay} ngayong araw`;
}

function renderAll() { fitFrame(); renderTexts(); drawTimeline(); renderChat(); renderControls(); }

// ---------- chat ----------
async function send(text) {
  text = text.trim();
  if (!text || busy || !P) return;
  busy = true; $('send').disabled = true;
  setPlaying(false);
  renderChat(text);
  try {
    setProject(await api(`/api/projects/${P.id}/chat`, { message: text }));
  } catch (e) {
    toast(e.message, true); renderChat();
  } finally { busy = false; $('send').disabled = false; }
}
$('form').onsubmit = (ev) => { ev.preventDefault(); const i = $('input'); send(i.value); i.value = ''; i.style.height = ''; };
$('input').onkeydown = (ev) => { if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); $('form').requestSubmit(); } };
$('input').oninput = (ev) => { ev.target.style.height = ''; ev.target.style.height = `${Math.min(110, ev.target.scrollHeight)}px`; };

// ---------- static UI ----------
for (const [title, sub, g, prompt] of AI_CARDS) {
  const b = el('button', 'card'); b.style.setProperty('--g', g);
  const s = el('span', '', title); s.append(el('small', '', sub));
  b.append(el('i', 'ai', '✦ AI'), s);
  b.onclick = () => { document.body.dataset.tab = 'ai'; send(prompt); };
  $('aiCards').append(b);
}
for (const [v, label, g] of LOOKS) {
  const b = el('button', 'card'); b.style.setProperty('--g', g); b.dataset.v = v;
  b.append(el('span', '', label));
  b.onclick = () => op('apply_filter', { filter: v, clip_ids: targetIds() });
  $('lookCards').append(b);
}
for (const [v, label] of TRANS) {
  const b = el('button', 'chip', label); b.dataset.v = v;
  b.onclick = () => op('set_transition', { type: v });
  $('transChips').append(b);
}
for (const s of SUGGEST) { const b = el('button', '', s); b.type = 'button'; b.onclick = () => send(s); $('suggest').append(b); }

$('play').onclick = () => setPlaying(!playing);
$('undo').onclick = () => op('undo');
$('redo').onclick = () => op('redo');
$('aspect').onchange = (e) => op('set_aspect', { aspect: e.target.value });
$('normalize').onchange = (e) => op('set_audio', { normalize: e.target.checked });
$('mute').onchange = (e) => op('set_audio', { mute: e.target.checked });
$('fades').onchange = (e) => op('set_fades', e.target.checked ? { fade_in: 0.6, fade_out: 0.8 } : { fade_in: 0, fade_out: 0 });
$('split').onclick = () => op('split_at', { timeline_time: t });
$('del').onclick = () => sel && op('delete_clips', { clip_ids: [sel] });
$('speed').onchange = (e) => op('set_speed', { speed: Number(e.target.value), clip_ids: targetIds() });
$('zoom').onchange = (e) => op('set_zoom', { zoom: Number(e.target.value), clip_ids: targetIds() });
$('tlZoom').oninput = (e) => { tlZoom = Number(e.target.value); drawTimeline(); };
$('homeBtn').onclick = () => { if (confirm('Magsimula ng bagong project? Naka-save ang kasalukuyan sa link na ito.')) { setPlaying(false); history.replaceState(null, '', location.pathname); location.reload(); } };
for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => { document.body.dataset.tab = b.dataset.tab; };

// timeline: click = seek + select, drag = scrub
{
  const inner = $('tlInner');
  let drag = false, moved = false, downX = 0;
  const timeAt = (ev) => (ev.clientX - inner.getBoundingClientRect().left) / pps;
  inner.addEventListener('pointerdown', (ev) => {
    if (ev.target.closest('.tclip button')) return;
    drag = true; moved = false; downX = ev.clientX;
    inner.setPointerCapture(ev.pointerId);
    setPlaying(false); seek(timeAt(ev));
  });
  inner.addEventListener('pointermove', (ev) => { if (!drag) return; if (Math.abs(ev.clientX - downX) > 4) moved = true; seek(timeAt(ev)); });
  inner.addEventListener('pointerup', (ev) => {
    if (!drag) return;
    drag = false;
    if (!moved) {
      const y = ev.clientY - $('clipTrack').getBoundingClientRect().top;
      const id = y >= 0 && y <= $('clipTrack').clientHeight ? items()[cur]?.id : null;
      sel = id && id !== sel ? id : null;
      drawTimeline(); renderControls();
    }
  });
  inner.addEventListener('pointercancel', () => { drag = false; });
}

document.addEventListener('keydown', (ev) => {
  if (!P || /INPUT|TEXTAREA|SELECT/.test(ev.target.tagName) || !$('modal').hidden) return;
  const mod = ev.ctrlKey || ev.metaKey;
  if (ev.code === 'Space') { ev.preventDefault(); setPlaying(!playing); }
  else if (mod && ev.key.toLowerCase() === 'z') { ev.preventDefault(); op(ev.shiftKey ? 'redo' : 'undo'); }
  else if (ev.key.toLowerCase() === 's' && !mod) $('split').click();
  else if (ev.key === 'Delete' || ev.key === 'Backspace') $('del').click();
  else if (ev.key === 'ArrowLeft') seek(t - (ev.shiftKey ? 1 : 0.1));
  else if (ev.key === 'ArrowRight') seek(t + (ev.shiftKey ? 1 : 0.1));
});
new ResizeObserver(() => { if (P) { fitFrame(); renderTexts(); drawTimeline(); } }).observe($('stage'));

// ---------- export ----------
let renderPoll = 0;
function modalState(state, job) {
  $('mTitle').textContent = { idle: 'I-export ang video', running: `Nire-render… ${Math.round((job?.progress || 0) * 100)}%`, done: 'Tapos na ang video mo 🎉', error: 'Nabigo ang export' }[state];
  $('mBar').hidden = state !== 'running';
  $('mBar').firstElementChild.style.width = `${(job?.progress || 0) * 100}%`;
  $('mStart').hidden = state === 'running' || state === 'done';
  $('quality').hidden = state !== 'idle' && state !== 'error';
  $('mDownload').hidden = $('mVideo').hidden = state !== 'done';
  if (state === 'done') { $('mVideo').src = job.url; $('mDownload').href = job.url; $('mDownload').download = `${P.name || 'tucat'}-edit.mp4`; }
}
$('export').onclick = () => { setPlaying(false); modalState('idle'); $('modal').hidden = false; };
$('mClose').onclick = () => { $('modal').hidden = true; $('mVideo').pause(); };
$('mStart').onclick = async () => {
  const run = ++renderPoll;
  try {
    let job = await api(`/api/projects/${P.id}/render`, { quality: Number($('quality').value) });
    while (run === renderPoll) {
      modalState(job.status, job);
      if (job.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 700));
      job = await api(`/api/jobs/${job.id}`);
    }
    if (job.status === 'error') toast(job.error, true);
  } catch (e) { modalState('error'); toast(e.message, true); }
};

// ---------- upload ----------
function upload(file) {
  if (!file) return;
  const bar = $('upBar');
  bar.hidden = false; $('dropTitle').textContent = `Ina-upload ang ${file.name}…`;
  const fd = new FormData(); fd.append('video', file);
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/projects');
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) { bar.firstElementChild.style.width = `${(e.loaded / e.total) * 100}%`; if (e.loaded === e.total) $('dropTitle').textContent = 'Binabasa ang video…'; } };
  const fail = (msg) => { bar.hidden = true; $('dropTitle').textContent = 'I-drop ang video dito o i-tap para pumili'; toast(msg, true); };
  xhr.onload = () => {
    let data = {}; try { data = JSON.parse(xhr.responseText); } catch { /* hindi JSON */ }
    if (xhr.status === 200) setProject(data); else fail(data.error || 'Nabigo ang upload.');
  };
  xhr.onerror = () => fail('Naputol ang koneksyon habang nag-a-upload.');
  xhr.send(fd);
}
$('file').onchange = (e) => upload(e.target.files[0]);
const drop = $('drop');
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); upload(e.dataTransfer.files[0]); };

// balikan ang project mula sa link
if (/^#[0-9a-f-]{36}$/.test(location.hash)) {
  api(`/api/projects/${location.hash.slice(1)}`).then(setProject).catch(() => history.replaceState(null, '', location.pathname));
}
