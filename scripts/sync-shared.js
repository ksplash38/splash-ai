// Copies the shared brain/router/core files into the desktop and mobile apps.
// Edit files in /shared, then run any build; this runs automatically.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const src = path.join(root, 'shared');
const targets = [
  path.join(root, 'desktop', 'src', 'shared'),
  path.join(root, 'desktop', 'renderer', 'shared'),
  path.join(root, 'mobile', 'www', 'shared'),
];
for (const t of targets) {
  fs.mkdirSync(t, { recursive: true });
  for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(t, f));
}
console.log('Shared files synced.');
