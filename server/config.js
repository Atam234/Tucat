import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Ang API key ay binabasa lang dito sa server (.env o environment variables) — hindi kailanman ipinapadala sa browser.
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const num = (name, def) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
};

export const config = {
  port: num('PORT', 3000),
  trustProxy: process.env.TRUST_PROXY === '1',
  dataDir: process.env.DATA_DIR || path.join(ROOT, 'data'),

  openrouterKey: (process.env.OPENROUTER_API_KEY || '').trim(),
  model: process.env.LLM_MODEL || 'google/gemini-2.5-flash',
  fallbackModels: (process.env.LLM_FALLBACK_MODELS || '')
    .split(',').map((s) => s.trim()).filter(Boolean),
  maxTokens: num('LLM_MAX_TOKENS', 1200),
  agentMaxSteps: num('AGENT_MAX_STEPS', 8),

  monthlyBudgetUsd: num('MONTHLY_BUDGET_USD', 15),
  chatPerMinute: num('CHAT_PER_MINUTE', 6),
  chatPerDay: num('CHAT_PER_DAY', 20),
  uploadsPerDay: num('UPLOADS_PER_DAY', 10),
  rendersPerDay: num('RENDERS_PER_DAY', 10),

  maxUploadMb: num('MAX_UPLOAD_MB', 500),
  maxVideoMinutes: num('MAX_VIDEO_MINUTES', 30),
};

export const dirs = {
  uploads: path.join(config.dataDir, 'uploads'),
  projects: path.join(config.dataDir, 'projects'),
  renders: path.join(config.dataDir, 'renders'),
  tmp: path.join(config.dataDir, 'tmp'),
};
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
