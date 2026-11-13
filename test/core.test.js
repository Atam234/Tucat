import test from 'node:test';
import assert from 'node:assert/strict';
import { FRAME, computeHighlights, detectSilence, keepRanges } from '../server/analysis.js';
import { computeLayout, freshEdit } from '../server/edit.js';
import { runTool } from '../server/tools.js';

// 40 s na pekeng audio: tahimik tuwing 5–7.5 s ng bawat 8 s, at malakas sa 18–21 s
const db = Array.from({ length: 40 / FRAME }, (_, i) => {
  const t = i * FRAME;
  if (t % 8 >= 5 && t % 8 < 7.5) return -70;
  return t >= 18 && t < 21 ? -6 : -20;
});
const an = { db, scenes: [4, 12, 20], noiseFloorDb: -70, loudDb: -6 };
const project = () => ({ source: { duration: 40, hasAudio: true }, edit: freshEdit(40) });
const ctx = { analysis: async () => an };

test('silence detection finds each quiet gap', () => {
  const s = detectSilence(an);
  assert.equal(s.length, 5);
  assert.ok(Math.abs(s[0].start - 5) < 0.1 && Math.abs(s[0].end - 7.5) < 0.1);
  const keeps = keepRanges(s, 40, 0.1);
  assert.equal(keeps.length, 6);
  assert.ok(keeps.every((k) => k.end > k.start));
});

test('highlights include the loudest part and never overlap', () => {
  const h = computeHighlights(an, 40, { targetDuration: 12 });
  assert.ok(h.some((r) => r.start < 19.5 && r.end > 19.5));
  for (let i = 1; i < h.length; i++) assert.ok(h[i].start >= h[i - 1].end);
});

test('remove_silence shortens the timeline and keeps clip settings', async () => {
  const p = project();
  await runTool(p, 'apply_filter', { filter: 'warm' }, ctx);
  const r = await runTool(p, 'remove_silence', {}, ctx);
  assert.ok(r.removed_seconds > 10 && r.removed_seconds < 12.6);
  assert.ok(p.edit.clips.every((c) => c.filter === 'warm'));
});

test('cut_range, split_at and speed keep the layout consistent', async () => {
  const p = project();
  await runTool(p, 'cut_range', { start: 10, end: 15 }, ctx);
  assert.equal(computeLayout(p.edit).total, 35);
  await runTool(p, 'split_at', { timeline_time: 5 }, ctx);
  assert.equal(p.edit.clips.length, 3);
  await runTool(p, 'set_speed', { speed: 2, clip_ids: [p.edit.clips[0].id] }, ctx);
  assert.equal(computeLayout(p.edit).total, 32.5);
});

test('bad arguments return errors instead of corrupting the edit', async () => {
  const p = project();
  assert.ok((await runTool(p, 'apply_filter', { filter: 'x;rm -rf' }, ctx)).error);
  assert.ok((await runTool(p, 'delete_clips', { clip_ids: ['c1'] }, ctx)).error);
  assert.ok((await runTool(p, 'nope', {}, ctx)).error);
  await runTool(p, 'set_speed', { speed: 999 }, ctx);
  assert.equal(p.edit.clips[0].speed, 4);
  const t = await runTool(p, 'add_text', { text: 'Hi', color: "red';x" }, ctx);
  assert.equal(t.color, '#ffffff');
});
