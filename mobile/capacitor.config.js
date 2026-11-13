// TUCAT_API_URL: address ng backend na ibe-bake sa app (hal. https://tucat.example.com).
// Kapag http:// ito (o TUCAT_ALLOW_HTTP=1), pinapayagan ang cleartext para sa local/LAN testing — huwag gamitin sa release build.
const api = process.env.TUCAT_API_URL || '';
const allowHttp = process.env.TUCAT_ALLOW_HTTP === '1' || api.startsWith('http://');

/** @type {import('@capacitor/cli').CapacitorConfig} */
module.exports = {
  appId: 'com.tucat.app',
  appName: 'Tucat',
  webDir: 'www',
  backgroundColor: '#0a0a0b',
  server: allowHttp ? { androidScheme: 'http', cleartext: true } : { androidScheme: 'https' },
  android: { allowMixedContent: allowHttp },
  ios: { contentInset: 'never', backgroundColor: '#0a0a0b' },
};
