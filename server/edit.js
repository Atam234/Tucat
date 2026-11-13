// Ang "edit" ay isang non-destructive edit decision list (EDL): hindi ginagalaw ang orihinal na video,
// listahan lang ito ng mga clip (source ranges) + effects na ire-render ng ffmpeg sa export.

export const FILTERS = ['none', 'cinematic', 'warm', 'cool', 'bw', 'vintage', 'vivid'];
export const TRANSITIONS = ['none', 'fade', 'dissolve', 'wipeleft', 'slideleft', 'circleopen', 'fadeblack'];
export const ASPECTS = ['source', '16:9', '9:16', '1:1', '4:5'];
const MAX_XFADE_CLIPS = 40;

export function freshEdit(duration) {
  return {
    seq: 1,
    clips: [{ id: 'c1', start: 0, end: duration, speed: 1, filter: 'none', zoom: 1, volume: 1 }],
    texts: [],
    transition: { type: 'none', duration: 0.4 },
    fadeIn: 0,
    fadeOut: 0,
    aspect: 'source',
    audio: { normalize: false, mute: false, volume: 1 },
  };
}

export function newClip(edit, start, end, base = {}) {
  edit.seq += 1;
  return { speed: 1, filter: 'none', zoom: 1, volume: 1, ...base, id: `c${edit.seq}`, start: round(start), end: round(end) };
}

export const round = (n) => Math.round(n * 1000) / 1000;
export const clipDur = (c) => (c.end - c.start) / c.speed;

/** Haba ng crossfade na talagang gagamitin (0 kapag hindi kasya o sobrang dami ng clips). */
export function transitionDur(edit) {
  const n = edit.clips.length;
  if (edit.transition.type === 'none' || n < 2 || n > MAX_XFADE_CLIPS) return 0;
  const shortest = Math.min(...edit.clips.map(clipDur));
  const d = Math.min(edit.transition.duration, shortest / 2 - 0.05);
  return d >= 0.1 ? round(d) : 0;
}

/** Posisyon ng bawat clip sa final timeline. Iisang source of truth para sa preview, agent, at render. */
export function computeLayout(edit) {
  const d = transitionDur(edit);
  let t = 0;
  const items = edit.clips.map((c, i) => {
    const shown = clipDur(c) - (i < edit.clips.length - 1 ? d : 0);
    const item = { id: c.id, tStart: round(t), tEnd: round(t + shown), srcStart: c.start, srcEnd: round(c.start + shown * c.speed), speed: c.speed };
    t += shown;
    return item;
  });
  return { items, total: round(t), xfade: d };
}

/** Panatilihin lang ang mga bahagi ng timeline na nasa loob ng ibinigay na source ranges. */
export function intersectClips(edit, ranges) {
  const out = [];
  for (const c of edit.clips) {
    for (const r of ranges) {
      const s = Math.max(c.start, r.start), e = Math.min(c.end, r.end);
      if (e - s >= 0.15) out.push(s === c.start && e === c.end ? c : newClip(edit, s, e, c));
    }
  }
  return out;
}
