// Kinokopya ang web UI (../public) papunta sa www/ at isinusulat ang address ng backend.
// Walang API key dito — ang app ay kausap lang ng sarili nating backend.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const www = path.join(root, 'www');
const api = (process.env.TUCAT_API_URL || '').trim().replace(/\/+$/, '');
if (api && !/^https?:\/\/[^\s'"<>]+$/.test(api)) throw new Error(`Hindi valid ang TUCAT_API_URL: ${api}`);

fs.rmSync(www, { recursive: true, force: true });
fs.cpSync(path.join(root, '..', 'public'), www, { recursive: true });
fs.writeFileSync(path.join(www, 'config.js'), `window.TUCAT_API = ${JSON.stringify(api)};\n`);
console.log(`www/ handa na · backend: ${api || '(ilalagay ng user sa app)'}`);
