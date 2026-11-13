// Mga tool na pwedeng tawagin ng AI agent (at ng UI nang direkta — walang LLM cost).
// Lahat ng argumento ay vina-validate at kina-clamp dito; hindi pinagkakatiwalaan ang output ng model.
import { autoThreshold, computeHighlights, detectSilence, keepRanges } from './analysis.js';
import { ASPECTS, FILTERS, TRANSITIONS, clipDur, computeLayout, freshEdit, intersectClips, newClip, round } from './edit.js';

const clipIds = { type: 'array', items: { type: 'string' }, description: 'Clip ids (hal. ["c2","c5"]). Iwanang blangko para sa LAHAT ng clips.' };
const fn = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});

export const TOOL_DEFS = [
  fn('get_timeline', 'Kunin ang kasalukuyang timeline: clips (id, source range, posisyon), texts, at settings.'),
  fn('analyze_video', 'Suriin ang source video: mga katahimikan (dead air), scene changes, at highlight candidates na may score. Tawagin muna ito bago magdesisyon batay sa laman ng video.'),
  fn('remove_silence', 'Awtomatikong alisin ang dead air / mahahabang katahimikan sa buong timeline (jump cuts).', {
    min_silence: { type: 'number', description: 'Pinakamaikling katahimikan na aalisin, segundo. Default 0.6' },
    threshold_db: { type: 'number', description: 'Opsyonal. Lakas (dBFS) na ituturing na tahimik. Default: adaptive batay sa video.' },
    padding: { type: 'number', description: 'Segundong ititira sa magkabilang gilid ng salita. Default 0.12' },
  }),
  fn('make_highlights', 'Palitan ang timeline ng highlight reel: pinaka-exciting na mga bahagi (lakas ng audio, biglang ingay, scene changes).', {
    target_duration: { type: 'number', description: 'Kabuuang haba ng reel sa segundo. Default 30' },
    segment_length: { type: 'number', description: 'Opsyonal. Haba ng bawat highlight segment, segundo.' },
  }),
  fn('set_timeline', 'Palitan ang buong timeline ng mga ibinigay na source ranges, ayon sa pagkakasunod.', {
    ranges: { type: 'array', items: { type: 'object', properties: { start: { type: 'number' }, end: { type: 'number' } }, required: ['start', 'end'] }, description: 'Source time ranges sa segundo.' },
  }, ['ranges']),
  fn('trim_clip', 'Baguhin ang simula/dulo ng isang clip (source time, segundo).', {
    clip_id: { type: 'string' }, start: { type: 'number' }, end: { type: 'number' },
  }, ['clip_id']),
  fn('split_at', 'Hatiin ang clip sa isang punto ng timeline.', { timeline_time: { type: 'number', description: 'Segundo sa final timeline.' } }, ['timeline_time']),
  fn('cut_range', 'Tanggalin ang isang bahagi ng timeline (mula start hanggang end, timeline seconds).', {
    start: { type: 'number' }, end: { type: 'number' },
  }, ['start', 'end']),
  fn('delete_clips', 'Burahin ang mga clip.', { clip_ids: { ...clipIds, description: 'Clip ids na buburahin.' } }, ['clip_ids']),
  fn('reorder_clips', 'Ayusin muli ang pagkakasunod ng clips.', { order: { type: 'array', items: { type: 'string' }, description: 'Lahat ng clip ids sa bagong ayos.' } }, ['order']),
  fn('set_speed', 'Bilis ng clips: 0.25 (slow-mo) hanggang 4 (fast).', { clip_ids: clipIds, speed: { type: 'number' } }, ['speed']),
  fn('apply_filter', 'Color grade / look ng clips.', { clip_ids: clipIds, filter: { type: 'string', enum: FILTERS } }, ['filter']),
  fn('set_zoom', 'Punch-in zoom sa clips: 1 (wala) hanggang 3.', { clip_ids: clipIds, zoom: { type: 'number' } }, ['zoom']),
  fn('set_volume', 'Lakas ng audio ng clips: 0 hanggang 3 (1 = orihinal).', { clip_ids: clipIds, volume: { type: 'number' } }, ['volume']),
  fn('add_text', 'Maglagay ng text/title overlay sa timeline.', {
    text: { type: 'string' },
    start: { type: 'number', description: 'Timeline seconds. Default 0' },
    end: { type: 'number', description: 'Timeline seconds. Default start+3' },
    position: { type: 'string', enum: ['top', 'center', 'bottom'] },
    size: { type: 'string', enum: ['small', 'medium', 'large'] },
    color: { type: 'string', description: 'Hex gaya ng #ffffff' },
    style: { type: 'string', enum: ['outline', 'box'] },
  }, ['text']),
  fn('remove_text', 'Alisin ang text overlays.', { text_ids: { type: 'array', items: { type: 'string' }, description: 'Iwanang blangko para alisin lahat.' } }),
  fn('set_transition', 'Transition sa pagitan ng lahat ng clips.', {
    type: { type: 'string', enum: TRANSITIONS }, duration: { type: 'number', description: 'Segundo, 0.1–1.5. Default 0.4' },
  }, ['type']),
  fn('set_fades', 'Fade in sa simula at fade out sa dulo ng video (segundo; 0 = wala).', { fade_in: { type: 'number' }, fade_out: { type: 'number' } }),
  fn('set_aspect', 'Aspect ratio ng export (9:16 para sa TikTok/Reels/Shorts).', { aspect: { type: 'string', enum: ASPECTS } }, ['aspect']),
  fn('set_audio', 'Global audio: loudness normalization (pantay na lakas), mute, master volume.', {
    normalize: { type: 'boolean' }, mute: { type: 'boolean' }, master_volume: { type: 'number' },
  }),
  fn('reset_edit', 'Ibalik ang timeline sa orihinal na video (walang edits).'),
];

const TOOL_NAMES = new Set(TOOL_DEFS.map((t) => t.function.name));
const num = (v, min, max, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const fail = (msg) => { throw new Error(msg); };
const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

function pick(edit, ids) {
  if (!Array.isArray(ids) || !ids.length) return edit.clips;
  const found = edit.clips.filter((c) => ids.includes(c.id));
  if (!found.length) fail(`Walang clip na tumugma sa ${JSON.stringify(ids)}. Mga valid na id: ${edit.clips.map((c) => c.id).slice(0, 30).join(', ')}`);
  return found;
}

export function timelineSummary(project, maxClips = 40) {
  const { edit } = project;
  const layout = computeLayout(edit);
  return {
    source_duration: round(project.source.duration),
    timeline_duration: layout.total,
    clip_count: edit.clips.length,
    clips: edit.clips.slice(0, maxClips).map((c, i) => ({
      id: c.id, at: layout.items[i].tStart, src: [c.start, c.end], speed: c.speed, filter: c.filter, zoom: c.zoom, volume: c.volume,
    })),
    ...(edit.clips.length > maxClips ? { note: `Ipinapakita lang ang unang ${maxClips} clips.` } : {}),
    texts: edit.texts,
    transition: edit.transition, fade_in: edit.fadeIn, fade_out: edit.fadeOut, aspect: edit.aspect, audio: edit.audio,
  };
}

/** Alisin ang [a,b] (timeline seconds) — hinahati ang mga clip na tinatamaan. */
function cutTimeline(edit, a, b) {
  const { items } = computeLayout(edit);
  const out = [];
  edit.clips.forEach((c, i) => {
    const it = items[i];
    if (b <= it.tStart || a >= it.tEnd) return out.push(c);
    const srcA = c.start + (Math.max(a, it.tStart) - it.tStart) * c.speed;
    const srcB = c.start + (Math.min(b, it.tEnd) - it.tStart) * c.speed;
    if (srcA - c.start >= 0.1) out.push(newClip(edit, c.start, srcA, c));
    if (c.end - srcB >= 0.1) out.push(newClip(edit, srcB, c.end, c));
  });
  return out;
}

const impl = {
  get_timeline: (p) => timelineSummary(p),

  async analyze_video(p, _a, ctx) {
    const an = await ctx.analysis();
    const D = p.source.duration;
    const silences = detectSilence(an, { minSilence: 0.6 });
    return {
      duration: round(D),
      has_audio: p.source.hasAudio,
      noise_floor_db: an.noiseFloorDb, speech_level_db: an.loudDb, auto_silence_threshold_db: round(autoThreshold(an)),
      silence_total: round(silences.reduce((s, x) => s + x.end - x.start, 0)),
      silences: silences.slice(0, 40).map((s) => [round(s.start), round(s.end)]),
      scene_changes: an.scenes.slice(0, 80),
      highlight_candidates: computeHighlights(an, D, { targetDuration: Math.min(D, 60) }).map((h) => ({ start: round(h.start), end: round(h.end), score: h.score })),
    };
  },

  async remove_silence(p, a, ctx) {
    if (!p.source.hasAudio) fail('Walang audio ang video kaya hindi matukoy ang katahimikan.');
    const an = await ctx.analysis();
    const minSilence = num(a.min_silence, 0.2, 10, 0.6);
    const thresholdDb = num(a.threshold_db, -80, -5, autoThreshold(an));
    const padding = Math.min(num(a.padding, 0, 1, 0.12), minSilence / 3);
    const before = computeLayout(p.edit).total;
    const keeps = keepRanges(detectSilence(an, { thresholdDb, minSilence }), p.source.duration, padding);
    const clips = intersectClips(p.edit, keeps);
    if (!clips.length) fail('Halos buong video ay tahimik sa threshold na ito — walang matitira. Subukan ang mas mababang threshold_db.');
    p.edit.clips = clips;
    const after = computeLayout(p.edit).total;
    return { removed_seconds: round(before - after), timeline_duration: after, clip_count: clips.length, threshold_db: round(thresholdDb) };
  },

  async make_highlights(p, a, ctx) {
    const an = await ctx.analysis();
    const ranges = computeHighlights(an, p.source.duration, {
      targetDuration: num(a.target_duration, 3, 600, 30),
      segmentLength: a.segment_length === undefined ? undefined : num(a.segment_length, 1, 60, 5),
    });
    p.edit.clips = ranges.map((r) => newClip(p.edit, r.start, r.end));
    return { timeline_duration: computeLayout(p.edit).total, highlights: ranges.map((r, i) => ({ id: p.edit.clips[i].id, src: [round(r.start), round(r.end)], score: r.score })) };
  },

  set_timeline(p, a) {
    const D = p.source.duration;
    const ranges = (Array.isArray(a.ranges) ? a.ranges : []).slice(0, 200)
      .map((r) => ({ start: num(r?.start, 0, D, 0), end: num(r?.end, 0, D, D) }))
      .filter((r) => r.end - r.start >= 0.1);
    if (!ranges.length) fail('Walang valid na range (kailangan end > start, nasa loob ng source duration).');
    p.edit.clips = ranges.map((r) => newClip(p.edit, r.start, r.end));
    return { clip_count: ranges.length, timeline_duration: computeLayout(p.edit).total };
  },

  trim_clip(p, a) {
    const [c] = pick(p.edit, [a.clip_id]);
    const start = num(a.start, 0, p.source.duration, c.start), end = num(a.end, 0, p.source.duration, c.end);
    if (end - start < 0.1) fail('Masyadong maikli ang clip pagkatapos i-trim.');
    c.start = round(start); c.end = round(end);
    return { id: c.id, src: [c.start, c.end] };
  },

  split_at(p, a) {
    const t = num(a.timeline_time, 0, 1e6, -1);
    const { items } = computeLayout(p.edit);
    const i = items.findIndex((it) => t > it.tStart + 0.05 && t < it.tEnd - 0.05);
    if (i < 0) fail('Walang clip na mahahati sa puntong iyan (masyadong malapit sa gilid ng clip).');
    const c = p.edit.clips[i];
    const src = c.start + (t - items[i].tStart) * c.speed;
    const left = newClip(p.edit, c.start, src, c), right = newClip(p.edit, src, c.end, c);
    p.edit.clips.splice(i, 1, left, right);
    return { new_clips: [left.id, right.id] };
  },

  cut_range(p, a) {
    const total = computeLayout(p.edit).total;
    const s = num(a.start, 0, total, 0), e = num(a.end, 0, total, total);
    if (e - s < 0.05) fail('Kailangan end > start.');
    const clips = cutTimeline(p.edit, s, e);
    if (!clips.length) fail('Hindi pwedeng tanggalin ang buong timeline.');
    p.edit.clips = clips;
    return { removed_seconds: round(e - s), timeline_duration: computeLayout(p.edit).total };
  },

  delete_clips(p, a) {
    const ids = new Set(pick(p.edit, a.clip_ids).map((c) => c.id));
    if (!Array.isArray(a.clip_ids) || !a.clip_ids.length) fail('Ibigay ang clip_ids na buburahin.');
    if (ids.size >= p.edit.clips.length) fail('Hindi pwedeng burahin lahat ng clips.');
    p.edit.clips = p.edit.clips.filter((c) => !ids.has(c.id));
    return { deleted: [...ids], clip_count: p.edit.clips.length };
  },

  reorder_clips(p, a) {
    const byId = new Map(p.edit.clips.map((c) => [c.id, c]));
    const order = [...new Set(Array.isArray(a.order) ? a.order : [])].filter((id) => byId.has(id));
    if (!order.length) fail('Walang valid na clip id sa order.');
    const rest = p.edit.clips.filter((c) => !order.includes(c.id));
    p.edit.clips = [...order.map((id) => byId.get(id)), ...rest];
    return { order: p.edit.clips.map((c) => c.id) };
  },

  set_speed(p, a) {
    const speed = num(a.speed, 0.25, 4, 1);
    const clips = pick(p.edit, a.clip_ids);
    clips.forEach((c) => { c.speed = speed; });
    return { speed, clips: clips.length, timeline_duration: computeLayout(p.edit).total };
  },

  apply_filter(p, a) {
    if (!FILTERS.includes(a.filter)) fail(`Hindi kilalang filter. Pumili sa: ${FILTERS.join(', ')}`);
    const clips = pick(p.edit, a.clip_ids);
    clips.forEach((c) => { c.filter = a.filter; });
    return { filter: a.filter, clips: clips.length };
  },

  set_zoom(p, a) {
    const zoom = num(a.zoom, 1, 3, 1);
    const clips = pick(p.edit, a.clip_ids);
    clips.forEach((c) => { c.zoom = zoom; });
    return { zoom, clips: clips.length };
  },

  set_volume(p, a) {
    const volume = num(a.volume, 0, 3, 1);
    const clips = pick(p.edit, a.clip_ids);
    clips.forEach((c) => { c.volume = volume; });
    return { volume, clips: clips.length };
  },

  add_text(p, a) {
    const text = String(a.text ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, 200);
    if (!text) fail('Walang laman ang text.');
    if (p.edit.texts.length >= 30) fail('Sobrang dami na ng text overlays (max 30).');
    const total = computeLayout(p.edit).total;
    const start = num(a.start, 0, Math.max(0, total - 0.3), 0);
    const end = num(a.end, start + 0.3, total, Math.min(total, start + 3));
    p.edit.seq += 1;
    const t = {
      id: `t${p.edit.seq}`, text, start: round(start), end: round(Math.max(end, start + 0.3)),
      position: ['top', 'center', 'bottom'].includes(a.position) ? a.position : 'bottom',
      size: ['small', 'medium', 'large'].includes(a.size) ? a.size : 'medium',
      color: /^#[0-9a-f]{6}$/i.test(a.color || '') ? a.color.toLowerCase() : '#ffffff',
      style: a.style === 'box' ? 'box' : 'outline',
    };
    p.edit.texts.push(t);
    return t;
  },

  remove_text(p, a) {
    const before = p.edit.texts.length;
    const ids = Array.isArray(a.text_ids) && a.text_ids.length ? a.text_ids : null;
    p.edit.texts = ids ? p.edit.texts.filter((t) => !ids.includes(t.id)) : [];
    return { removed: before - p.edit.texts.length };
  },

  set_transition(p, a) {
    if (!TRANSITIONS.includes(a.type)) fail(`Hindi kilalang transition. Pumili sa: ${TRANSITIONS.join(', ')}`);
    p.edit.transition = { type: a.type, duration: num(a.duration, 0.1, 1.5, p.edit.transition.duration) };
    const layout = computeLayout(p.edit);
    return {
      ...p.edit.transition, applied_duration: layout.xfade,
      ...(a.type !== 'none' && !layout.xfade ? { warning: 'Hindi ma-apply: kailangan ng 2–40 clips na sapat ang haba.' } : {}),
    };
  },

  set_fades(p, a) {
    p.edit.fadeIn = num(a.fade_in, 0, 5, p.edit.fadeIn);
    p.edit.fadeOut = num(a.fade_out, 0, 5, p.edit.fadeOut);
    return { fade_in: p.edit.fadeIn, fade_out: p.edit.fadeOut };
  },

  set_aspect(p, a) {
    if (!ASPECTS.includes(a.aspect)) fail(`Pumili sa: ${ASPECTS.join(', ')}`);
    p.edit.aspect = a.aspect;
    return { aspect: a.aspect };
  },

  set_audio(p, a) {
    const au = p.edit.audio;
    if (typeof a.normalize === 'boolean') au.normalize = a.normalize;
    if (typeof a.mute === 'boolean') au.mute = a.mute;
    if (a.master_volume !== undefined) au.volume = num(a.master_volume, 0, 3, au.volume);
    return au;
  },

  reset_edit(p) {
    p.edit = freshEdit(p.source.duration);
    return { timeline_duration: round(p.source.duration) };
  },
};

/** Patakbuhin ang isang tool. Laging nagbabalik ng object; ang error ay ibinabalik bilang { error } para makabawi ang agent. */
export async function runTool(project, name, args, ctx) {
  if (!TOOL_NAMES.has(name)) return { error: `Walang tool na "${name}".` };
  try {
    return await impl[name](project, args && typeof args === 'object' ? args : {}, ctx);
  } catch (e) {
    return { error: e.message };
  }
}

/** Maikling label ng ginawa ng tool, para sa chat UI. */
export function describeStep(name, args, result) {
  if (result?.error) return `⚠️ ${name}: ${result.error}`;
  const n = (ids) => (Array.isArray(ids) && ids.length ? `${ids.length} clip` : 'lahat ng clips');
  switch (name) {
    case 'analyze_video': return `Sinuri ang video · ${result.silences.length} katahimikan, ${result.scene_changes.length} scene changes`;
    case 'get_timeline': return 'Binasa ang timeline';
    case 'remove_silence': return `Inalis ang ${result.removed_seconds}s na dead air → ${result.clip_count} clips`;
    case 'make_highlights': return `Gumawa ng highlight reel · ${result.highlights.length} segments, ${fmt(result.timeline_duration)}`;
    case 'set_timeline': return `Bagong timeline · ${result.clip_count} clips`;
    case 'trim_clip': return `Na-trim ang ${result.id}`;
    case 'split_at': return 'Hinati ang clip';
    case 'cut_range': return `Tinanggal ang ${result.removed_seconds}s`;
    case 'delete_clips': return `Binura ang ${result.deleted.length} clip`;
    case 'reorder_clips': return 'Inayos ang pagkakasunod';
    case 'set_speed': return `Bilis ${result.speed}× sa ${n(args.clip_ids)}`;
    case 'apply_filter': return `Filter "${result.filter}" sa ${n(args.clip_ids)}`;
    case 'set_zoom': return `Zoom ${result.zoom}× sa ${n(args.clip_ids)}`;
    case 'set_volume': return `Volume ${result.volume}× sa ${n(args.clip_ids)}`;
    case 'add_text': return `Text: "${result.text}"`;
    case 'remove_text': return `Inalis ang ${result.removed} text`;
    case 'set_transition': return result.warning ? `⚠️ Transition: ${result.warning}` : `Transition: ${result.type}`;
    case 'set_fades': return `Fade in ${result.fade_in}s · out ${result.fade_out}s`;
    case 'set_aspect': return `Aspect ${result.aspect}`;
    case 'set_audio': return `Audio: ${result.mute ? 'mute' : `${result.normalize ? 'normalized, ' : ''}vol ${result.volume}×`}`;
    case 'reset_edit': return 'Ibinalik sa orihinal';
    default: return name;
  }
}
