// Documents attached on the laptop: reads PDF, Word and text files from disk.
// Choosing which parts go with a question is shared with the phone (shared/docs.js).
const fs = require('fs');
const path = require('path');
const { TEXT_TYPES, tidy, toParts, unsupported, pdfError, finishDocument, summaryOf, documentContext } = require('./shared/docs.js');

const MAX_FILE = 60 * 1024 * 1024;

async function readPdf(buf) {
  const { getDocumentProxy, extractText } = await import('unpdf');
  let pdf;
  try { pdf = await getDocumentProxy(new Uint8Array(buf)); } catch (e) { throw pdfError(e); }
  const { text } = await extractText(pdf, { mergePages: false });
  return text.map((t, i) => ({ n: i + 1, text: tidy(t) }));
}

async function readDocument(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (fs.statSync(filePath).size > MAX_FILE) throw new Error('That file is over 60 MB, which is too big.');
  const name = path.basename(filePath);
  if (ext === '.pdf') return finishDocument(name, 'page', await readPdf(fs.readFileSync(filePath)));
  if (ext === '.docx') {
    const mammoth = require('mammoth');
    let r;
    try { r = await mammoth.extractRawText({ path: filePath }); }
    catch { throw new Error('This Word file looks damaged, so I could not open it.'); }
    return finishDocument(name, 'part', toParts(r.value));
  }
  if (TEXT_TYPES.includes(ext)) return finishDocument(name, 'part', toParts(fs.readFileSync(filePath, 'utf8')));
  throw unsupported(ext);
}

// The extracted text lives in its own file; the conversation only keeps a short record.
const extractPath = (dir, docId) => path.join(dir, String(docId).replace(/[^a-z0-9]/gi, '') + '.json');
function saveExtract(dir, doc) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(extractPath(dir, doc.id), JSON.stringify(doc));
}
function loadExtract(dir, docId) {
  try { return JSON.parse(fs.readFileSync(extractPath(dir, docId), 'utf8')); } catch { return null; }
}
function removeExtract(dir, docId) { try { fs.unlinkSync(extractPath(dir, docId)); } catch {} }

module.exports = { readDocument, saveExtract, removeExtract, loadExtract, summaryOf, documentContext, TEXT_TYPES };
