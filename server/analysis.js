// Video analysis na walang AI cost: lahat ng signal processing ay lokal (ffmpeg + JS).
//  - RMS loudness envelope (50 ms frames) mula sa isang PCM decode pass
//  - adaptive silence detection (threshold batay sa noise floor ng mismong video)
//  - scene-change detection (ffmpeg scene score)
//  - highlight scoring: loudness z-score + audio onsets + scene density, greedy non-overlap selection
import { spawn } from 'node:child_process';

export const FRAME = 0.05; // segundo kada loudness frame
const RATE = 8000;

function run(cmd, args, { onStdout } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (onStdout ? onStdout(d) : (out += d)));
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exit ${code}: ${err.slice(-500)}`))));
  });
}

export async function probe(file) {
  const out = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const info = JSON.parse(out);
  const v = info.streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  if (!v) throw new Error('Walang video stream ang file.');
  const a = info.streams.find((s) => s.codec_type === 'audio');
  const duration = Number(info.format.duration) || Number(v.duration) || 0;
  if (!(duration > 0)) throw new Error('Hindi mabasa ang haba ng video.');
  const rot = Math.abs(Number(v.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ?? v.tags?.rotate ?? 0));
  const swap = rot === 90 || rot === 270;
  return {
    duration,
    width: swap ? v.height : v.width,
    height: swap ? v.width : v.height,
    hasAudio: Boolean(a),
  };
}

/** Isang decode pass: mono 8 kHz PCM → dB kada 50 ms frame. */
async function loudnessFrames(file) {
  const per = Math.round(RATE * FRAME);
  const db = [];
  let sum = 0, n = 0, carry = null;
  await run('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-'], {
    onStdout(chunk) {
      if (carry) { chunk = Buffer.concat([carry, chunk]); carry = null; }
      const even = chunk.length - (chunk.length % 2);
      for (let i = 0; i < even; i += 2) {
        const s = chunk.readInt16LE(i) / 32768;
        sum += s * s;
        if (++n === per) {
          db.push(Math.max(-90, Math.round(10 * Math.log10(sum / n + 1e-10))));
          sum = 0; n = 0;
        }
      }
      if (even < chunk.length) carry = chunk.subarray(even);
    },
  });
  return db;
}

async function sceneChanges(file) {
  const out = await run('ffmpeg', ['-v', 'error', '-i', file, '-an',
    '-vf', "fps=6,scale=160:-2,select='gt(scene,0.3)',metadata=print:file=-", '-f', 'null', '-']);
  return [...out.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(Number(m[1]).toFixed(2)));
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

export async function analyze(file, meta) {
  const [db, scenes] = await Promise.all([
    meta.hasAudio ? loudnessFrames(file) : Promise.resolve([]),
    sceneChanges(file).catch(() => []),
  ]);
  let noiseFloorDb = -60, loudDb = -20;
  if (db.length) {
    const sorted = [...db].sort((x, y) => x - y);
    noiseFloorDb = percentile(sorted, 0.1);
    loudDb = percentile(sorted, 0.95);
  }
  // maliit na envelope (0..1) para sa waveform ng timeline
  const points = Math.min(1200, db.length);
  const envelope = [];
  for (let i = 0; i < points; i++) {
    const a = Math.floor((i * db.length) / points), b = Math.max(a + 1, Math.floor(((i + 1) * db.length) / points));
    let peak = -90;
    for (let j = a; j < b; j++) peak = Math.max(peak, db[j]);
    envelope.push(Number(Math.max(0, Math.min(1, (peak + 60) / 60)).toFixed(2)));
  }
  return { ready: true, db, scenes, noiseFloorDb, loudDb, envelope };
}

/** Adaptive threshold: 35% ng pagitan mula noise floor hanggang sa karaniwang lakas ng boses. */
export function autoThreshold(an) {
  return Math.max(-55, Math.min(-18, an.noiseFloorDb + 0.35 * (an.loudDb - an.noiseFloorDb)));
}

export function detectSilence(an, { thresholdDb = autoThreshold(an), minSilence = 0.6 } = {}) {
  const out = [];
  let start = -1;
  for (let i = 0; i <= an.db.length; i++) {
    const quiet = i < an.db.length && an.db[i] < thresholdDb;
    if (quiet && start < 0) start = i;
    if (!quiet && start >= 0) {
      if ((i - start) * FRAME >= minSilence) out.push({ start: start * FRAME, end: i * FRAME });
      start = -1;
    }
  }
  return out;
}

/** Mga bahaging ititira = kabaligtaran ng silences, may kaunting padding para hindi putol ang salita. */
export function keepRanges(silences, duration, padding = 0.12) {
  const keeps = [];
  let cursor = 0;
  for (const s of silences) {
    const end = s.start === 0 ? 0 : s.start + padding;
    if (end - cursor >= 0.2) keeps.push({ start: cursor, end: Math.min(end, duration) });
    cursor = Math.max(cursor, s.end >= duration - FRAME ? duration : s.end - padding);
  }
  if (duration - cursor >= 0.2) keeps.push({ start: cursor, end: duration });
  return keeps;
}

function zscores(arr) {
  const mean = arr.reduce((a, b) => a + b, 0) / (arr.length || 1);
  const sd = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / (arr.length || 1)) || 1;
  return arr.map((v) => (v - mean) / sd);
}

/**
 * Pumili ng pinaka-"exciting" na mga segment.
 * Score kada 0.5 s window = 0.6·z(loudness) + 0.25·z(onset) + 0.15·z(scene density),
 * tapos sliding-window sum (prefix sums) at greedy na pagpili ng hindi nagpapatong na segments,
 * at i-snap ang mga gilid sa pinakamalapit na katahimikan para natural ang cut.
 */
export function computeHighlights(an, duration, { targetDuration = 30, segmentLength } = {}) {
  const W = 0.5;
  const nWin = Math.max(1, Math.floor(duration / W));
  targetDuration = Math.min(targetDuration, duration);
  const segLen = Math.min(duration, segmentLength || Math.max(3, Math.min(8, targetDuration / 5)));
  const want = Math.max(1, Math.round(targetDuration / segLen));

  const per = Math.round(W / FRAME);
  const loud = Array.from({ length: nWin }, (_, w) => {
    if (!an.db.length) return 0;
    let s = 0, c = 0;
    for (let j = w * per; j < Math.min(an.db.length, (w + 1) * per); j++) { s += 10 ** (an.db[j] / 10); c++; }
    return c ? 10 * Math.log10(s / c + 1e-10) : -90;
  });
  // i-clamp sa silence threshold para hindi ituring na "exciting" ang bawat pagbalik mula sa katahimikan
  if (an.db.length) { const floor = autoThreshold(an); for (let i = 0; i < nWin; i++) loud[i] = Math.max(loud[i], floor); }
  const onset = loud.map((v, i) => (i ? Math.max(0, v - loud[i - 1]) : 0));
  const scene = new Array(nWin).fill(0);
  for (const t of an.scenes) {
    const c = Math.floor(t / W);
    for (let k = Math.max(0, c - 4); k <= Math.min(nWin - 1, c + 4); k++) scene[k] += 1;
  }
  const zl = zscores(loud), zo = zscores(onset), zs = zscores(scene);
  const hasSignal = an.db.length || an.scenes.length;
  const score = zl.map((v, i) => 0.6 * v + 0.25 * zo[i] + 0.15 * zs[i]);

  const prefix = [0];
  for (const v of score) prefix.push(prefix[prefix.length - 1] + v);
  const segWin = Math.max(1, Math.round(segLen / W));
  const cands = [];
  for (let s = 0; s + segWin <= nWin; s++) cands.push({ s, score: (prefix[s + segWin] - prefix[s]) / segWin });
  if (!cands.length) return [{ start: 0, end: duration, score: 0 }];

  let picked = [];
  if (hasSignal) {
    cands.sort((a, b) => b.score - a.score);
    for (const c of cands) {
      if (picked.length >= want) break;
      if (picked.every((p) => Math.abs(p.s - c.s) >= segWin + 2)) picked.push(c);
    }
  } else { // walang audio at walang scene cuts: pantay-pantay na sampling
    for (let i = 0; i < want; i++) picked.push({ s: Math.floor(((i + 0.5) * (nWin - segWin)) / want), score: 0 });
  }

  const silences = an.db.length ? detectSilence(an, { minSilence: 0.25 }) : [];
  const snap = (t, edge) => {
    let best = t, dist = 0.75;
    for (const s of silences) {
      const cand = edge === 'start' ? s.end - 0.08 : s.start + 0.08;
      if (Math.abs(cand - t) < dist) { dist = Math.abs(cand - t); best = cand; }
    }
    return Math.max(0, Math.min(duration, best));
  };
  const out = picked
    .map((p) => ({ start: snap(p.s * W, 'start'), end: snap((p.s + segWin) * W, 'end'), score: Number(p.score.toFixed(2)) }))
    .filter((r) => r.end - r.start >= 1)
    .sort((a, b) => a.start - b.start);
  // pagsamahin ang nagdikit/nagpatong matapos ang snapping
  const merged = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + 0.2) { last.end = Math.max(last.end, r.end); last.score = Math.max(last.score, r.score); }
    else merged.push({ ...r });
  }
  return merged;
}
