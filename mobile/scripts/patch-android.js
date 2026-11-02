// Adds the permissions Splash AI needs to the Android project and sets the app icon.
// Safe to run more than once.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', 'android', 'app', 'src', 'main');
const manifest = path.join(root, 'AndroidManifest.xml');
if (!fs.existsSync(manifest)) { console.log('Run "npx cap add android" first.'); process.exit(0); }
let m = fs.readFileSync(manifest, 'utf8');
const perms = ['RECORD_AUDIO', 'INTERNET', 'ACCESS_NETWORK_STATE', 'CALL_PHONE', 'QUERY_ALL_PACKAGES'];
for (const p of perms) {
  const tag = `<uses-permission android:name="android.permission.${p}" />`;
  if (!m.includes(`android.permission.${p}"`)) m = m.replace('</manifest>', `    ${tag}\n</manifest>`);
}
if (!m.includes('usesCleartextTraffic')) m = m.replace('<application', '<application\n        android:usesCleartextTraffic="true"');
if (!m.includes('android.speech.RecognitionService')) {
  m = m.replace('</manifest>', `    <queries>
        <intent><action android:name="android.speech.RecognitionService" /></intent>
        <intent><action android:name="android.intent.action.TTS_SERVICE" /></intent>
    </queries>\n</manifest>`);
}
// QR pairing: have Google Play services fetch the barcode scanner screen ahead of time
if (!m.includes('com.google.mlkit.vision.DEPENDENCIES')) {
  m = m.replace('</application>', `    <meta-data android:name="com.google.mlkit.vision.DEPENDENCIES" android:value="barcode_ui" />\n    </application>`);
}
fs.writeFileSync(manifest, m);

// icon
const icon = path.join(__dirname, 'icon.png');
const res = path.join(root, 'res');
if (fs.existsSync(icon) && fs.existsSync(res)) {
  for (const d of fs.readdirSync(res).filter(d => d.startsWith('mipmap-') && !d.includes('anydpi'))) {
    for (const f of ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png']) {
      const target = path.join(res, d, f);
      if (fs.existsSync(target)) fs.copyFileSync(icon, target);
    }
  }
  // use the plain icon instead of the adaptive one so it shows exactly as designed
  const anydpi = path.join(res, 'mipmap-anydpi-v26');
  if (fs.existsSync(anydpi)) fs.rmSync(anydpi, { recursive: true, force: true });
}
console.log('Android project patched.');
