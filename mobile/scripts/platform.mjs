// Gumawa ng native project kung wala pa, tapos i-sync ang www/ at plugins.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const platform = process.argv[2];
if (!['android', 'ios'].includes(platform)) throw new Error('Gamit: platform.mjs android|ios');
const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' });

if (!fs.existsSync(path.join(root, platform))) run(`npx cap add ${platform}`);
run(`npx cap sync ${platform}`);

if (platform === 'android') { // portrait lang, at hindi nagre-resize ang layout kapag lumabas ang keyboard nang hindi inaasahan
  const manifest = path.join(root, 'android/app/src/main/AndroidManifest.xml');
  let xml = fs.readFileSync(manifest, 'utf8');
  if (!xml.includes('android:screenOrientation')) {
    xml = xml.replace('<activity', '<activity android:screenOrientation="portrait" android:windowSoftInputMode="adjustResize"');
    fs.writeFileSync(manifest, xml);
  }
}
