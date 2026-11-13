// Kontrol sa gastos: token-bucket rate limit (kada minuto), daily quota kada user,
// at global monthly budget na sinusukat mula sa aktuwal na cost na ibinabalik ng OpenRouter.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const file = path.join(config.dataDir, 'usage.json');
const today = () => new Date().toISOString().slice(0, 10);
const month = () => today().slice(0, 7);

let state = { month: month(), usd: 0, llmCalls: 0, tokens: 0, day: today(), daily: {} };
try { state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* unang takbo */ }

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(file, JSON.stringify(state), () => {});
  }, 200);
}

function roll() {
  if (state.month !== month()) Object.assign(state, { month: month(), usd: 0, llmCalls: 0, tokens: 0 });
  if (state.day !== today()) Object.assign(state, { day: today(), daily: {} });
}

// --- token bucket (burst-friendly, tuloy-tuloy ang refill) ---
const buckets = new Map();
function takeToken(key, perMinute) {
  const now = Date.now();
  const b = buckets.get(key) || { tokens: perMinute, ts: now };
  b.tokens = Math.min(perMinute, b.tokens + ((now - b.ts) / 60000) * perMinute);
  b.ts = now;
  buckets.set(key, b);
  if (b.tokens < 1) return Math.ceil(((1 - b.tokens) / perMinute) * 60);
  b.tokens -= 1;
  return 0;
}
setInterval(() => {
  const cutoff = Date.now() - 10 * 60000;
  for (const [k, b] of buckets) if (b.ts < cutoff) buckets.delete(k);
}, 5 * 60000).unref();

export function dailyUsed(ip, name) {
  roll();
  return state.daily[`${name}:${ip}`] || 0;
}

/** Express middleware: limit kada minuto at kada araw, naka-key sa IP. */
export function limit(name, { perMinute, perDay }) {
  return (req, res, next) => {
    roll();
    const key = `${name}:${req.ip}`;
    if (perDay && (state.daily[key] || 0) >= perDay) {
      return res.status(429).json({ error: `Naabot mo na ang daily limit (${perDay} kada araw). Balik ka bukas.` });
    }
    if (perMinute) {
      const wait = takeToken(key, perMinute);
      if (wait) {
        res.set('Retry-After', String(wait));
        return res.status(429).json({ error: `Masyadong mabilis — subukan ulit pagkatapos ng ${wait}s.` });
      }
    }
    if (perDay) { state.daily[key] = (state.daily[key] || 0) + 1; save(); }
    next();
  };
}

export function budgetLeft() {
  roll();
  return config.monthlyBudgetUsd - state.usd;
}

export function recordLlmUsage(usage = {}) {
  roll();
  state.usd += Number(usage.cost) || 0;
  state.tokens += Number(usage.total_tokens) || 0;
  state.llmCalls += 1;
  save();
}

export function usageSummary(ip) {
  roll();
  return {
    chatUsedToday: dailyUsed(ip, 'chat'),
    chatPerDay: config.chatPerDay,
    budgetExhausted: budgetLeft() <= 0,
  };
}
