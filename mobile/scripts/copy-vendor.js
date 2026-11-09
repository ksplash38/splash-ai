// Copies the PDF and Word readers from the installed packages into the app.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const out = path.join(root, 'www', 'vendor');
fs.mkdirSync(out, { recursive: true });
const files = {
  'node_modules/pdfjs-dist/legacy/build/pdf.min.mjs': 'pdf.min.js',
  'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs': 'pdf.worker.min.js',
  'node_modules/mammoth/mammoth.browser.min.js': 'mammoth.browser.min.js',
};
for (const [from, to] of Object.entries(files)) fs.copyFileSync(path.join(root, from), path.join(out, to));
console.log('Document readers copied.');
