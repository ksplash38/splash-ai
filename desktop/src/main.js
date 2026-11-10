const { app, BrowserWindow, ipcMain, Tray, Menu, globalShortcut, shell, session, nativeImage, dialog, clipboard, desktopCapturer, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { Store } = require('./store');
const { writePaper } = require('./research');
const { readDocument, saveExtract, removeExtract, loadExtract, summaryOf, documentContext, TEXT_TYPES } = require('./documents');
const { ACTIONS_DOC, contextLine, makeExecutor, powershell } = require('./tools');
const { makeControl } = require('./control');
const { Router, customProvider, testProvider } = require('./shared/router.js');
const { buildSystemPrompt, runTurn } = require('./shared/brain.js');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let win, tray, store, router, server;
let quitting = false;
let conv; // current laptop conversation
const pendingConfirms = new Map();
const jobs = new Map();

const ICON = path.join(__dirname, '..', 'renderer', 'icon.png');
const MODEL_URLS = ['https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-en-us-0.15.tar.gz'];

function send(ch, data) { if (win && !win.isDestroyed()) win.webContents.send(ch, data); }

// ---------------- assistant ----------------
function getRouter() {
  if (!router) {
    router = new Router({ providers: store.config.providers }, store.routerState, (ev, data) => {
      if (ev === 'state') store.saveRouterState(data);
      if (ev === 'fallback') send('fallback', data);
      if (ev === 'trying') send('trying', { name: data.name, model: data.model });
    });
  }
  router.config = { providers: store.config.providers };
  return router;
}

const docsDir = () => path.join(store.dataDir, 'attached documents');
let control;
const getControl = () => control || (control = makeControl({ powershell, router: getRouter(), clipboard, desktopCapturer, screen }));

async function attachDocument(filePath) {
  const doc = await readDocument(filePath);
  saveExtract(docsDir(), doc);
  conv.docs = [...(conv.docs || []), summaryOf(doc)];
  store.saveConversation(conv);
  return doc;
}
function removeConversationDocs(c) { ((c && c.docs) || []).forEach(d => removeExtract(docsDir(), d.id)); }

async function ask(text, { c, source, confirm, onStep, heard = 'typed' }) {
  const promptInfo = {
    names: store.config.names,
    platform: "Kelvin's Windows PC (" + os.hostname() + ')',
    actionsDoc: ACTIONS_DOC,
    context: contextLine(),
    lessons: store.memory.lessons,
    facts: store.memory.facts,
    recentNotes: store.recentNotes(30),
  };
  const systemPrompt = buildSystemPrompt(promptInfo);
  const compactPrompt = buildSystemPrompt({ ...promptInfo, compact: true });
  // What it did last time travels with its replies, so "open the second one" knows what "one" means.
  const history = c.messages.map(m => ({ role: m.role, content: m.content + (m.role === 'assistant' && m.steps && m.steps.length
    ? '\n(Actions you ran: ' + m.steps.map(s => `${s.type} ${s.ok ? 'ok' : 'failed'}: ${String(s.result || '').slice(0, 300)}`).join(' | ') + ')' : '') }));
  const lastReply = [...c.messages].reverse().find(m => m.role === 'assistant');
  const situation = lastReply && lastReply.at
    ? `Your last reply was ${Math.round((Date.now() - Date.parse(lastReply.at)) / 1000)} seconds ago${lastReply.expectReply ? ' and asked him a question' : ''}.`
    : 'This is the start of the conversation.';
  const hasDocs = !!(c.docs && c.docs.length);
  const lastAsked = [...c.messages].reverse().find(m => m.role === 'user');
  const documents = hasDocs ? await documentContext({
    docs: c.docs, question: text, previous: lastAsked ? lastAsked.content : '', router: getRouter(),
    load: id => loadExtract(docsDir(), id), save: doc => saveExtract(docsDir(), doc),
    onProgress: t => send('doc-progress', t),
  }) : '';
  const res = await runTurn({
    router: getRouter(), history, userText: text, systemPrompt, compactPrompt, documents, situation,
    execute: makeExecutor({ store, confirm, documentOpen: hasDocs, control: getControl().newTurn() || getControl(), research: a => writePaper({
      router: getRouter(), topic: a.topic, length: a.length, instructions: a.instructions,
      outDir: path.join(store.dataDir, 'Research'), onProgress: t => send('research-progress', t),
    }) }), onStep, heard,
  });
  if (res.ignored) return res; // not meant for us: keep it out of the conversation
  const at = new Date().toISOString();
  c.messages.push({ role: 'user', content: text, at, source });
  // content (what the model sees next time) includes the explanation; the visual is kept alongside for the chat
  c.messages.push({ role: 'assistant', content: res.say + (res.explain ? '\n\n' + res.explain : ''), say: res.say, explain: res.explain, visual: res.visual, expectReply: res.expectReply, at, provider: res.provider, model: res.model,
    steps: res.steps.map(s => ({ type: s.type, ok: s.ok, result: String(s.result).slice(0, 400) })) });
  store.saveConversation(c);
  res.notes.forEach(n => store.addNote(n, source));
  res.lessons.forEach(l => store.addMemory('lessons', l, source));
  return res;
}

function localConfirm(text) {
  return new Promise(resolve => {
    const id = crypto.randomBytes(6).toString('hex');
    pendingConfirms.set(id, resolve);
    if (win) { win.show(); win.focus(); }
    send('confirm', { id, text });
  });
}

// ---------------- voice model download ----------------
function modelPath() { return path.join(app.getPath('userData'), 'models', 'vosk-model-small-en-us.tar.gz'); }

function download(url, dest, onProgress, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).toString(), dest, onProgress, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const total = Number(res.headers['content-length']) || 0;
      let got = 0;
      const tmp = dest + '.part';
      const out = fs.createWriteStream(tmp);
      res.on('data', ch => { got += ch.length; if (total) onProgress(got / total); });
      res.pipe(out);
      out.on('finish', () => out.close(() => { fs.renameSync(tmp, dest); resolve(dest); }));
      out.on('error', reject);
    }).on('error', reject);
  });
}

async function ensureModel() {
  const p = modelPath();
  if (fs.existsSync(p) && fs.statSync(p).size > 1e6) return p;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let lastErr;
  for (const u of MODEL_URLS) {
    try { await download(u, p, f => send('model-progress', f)); return p; } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// ---------------- speech-to-text (Groq Whisper, optional) ----------------
async function transcribe(buf) {
  const groq = store.config.providers.find(p => p.id === 'groq');
  // null = Whisper not available (use the offline text); '' = Whisper heard no real speech
  if (!store.config.useWhisper || !groq || !groq.key) return null;
  try {
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from(buf)], { type: 'audio/webm' }), 'speech.webm');
    // The full model is slower than turbo but noticeably better with accents.
    fd.append('model', 'whisper-large-v3');
    fd.append('language', 'en');
    fd.append('temperature', '0');
    fd.append('response_format', 'verbose_json');
    // Priming text: tells Whisper the names and words it should expect to hear.
    fd.append('prompt', [
      'Nigerian English conversation with Splash AI, Kelvin\'s assistant.',
      'Names: ' + [...(store.config.names || []), 'Splash AI'].join(', ') + '.',
      'Wake words: ' + (store.config.wakeWords || []).join(', ') + '.',
      ...store.memory.lessons.slice(-5).map(l => l.text),
    ].join(' ').slice(0, 800));
    const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: 'Bearer ' + groq.key.trim() }, body: fd,
    });
    if (!r.ok) return null;
    const j = await r.json();
    // Drop segments Whisper itself thinks were silence or noise.
    const segs = Array.isArray(j.segments) ? j.segments : null;
    let text = segs ? segs.filter(s => !(s.no_speech_prob > 0.6 && s.avg_logprob < -0.7)).map(s => s.text).join(' ') : String(j.text || '');
    text = text.replace(/\s+/g, ' ').trim();
    // Whisper "hears" these in silence or noise; never treat them as you talking.
    if (/^(thank you|thanks|thanks for watching|you|bye|okay|subtitles by.*|\.+)[.!]?$/i.test(text)) return '';
    return text;
  } catch { return null; }
}

// ---------------- natural voices (Microsoft Edge online voices, free, no key) ----------------
// Unofficial service: if it fails, the app falls back to the Windows voice.
const NATURAL_VOICES = [
  { id: 'en-NG-AbeoNeural', label: 'Abeo, Nigerian man (natural)' },
  { id: 'en-NG-EzinneNeural', label: 'Ezinne, Nigerian woman (natural)' },
  { id: 'en-GB-RyanNeural', label: 'Ryan, British man (natural)' },
  { id: 'en-US-AndrewNeural', label: 'Andrew, American man (natural)' },
];
let edge = null, edgeVoice = '';
async function synthesize(text, voice) {
  const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
  voice = NATURAL_VOICES.some(v => v.id === voice) ? voice : NATURAL_VOICES[0].id;
  text = String(text || '').replace(/[<>&]/g, ' ').trim().slice(0, 1500);
  if (!text) throw new Error('nothing to say');
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 600));
    try {
      if (!edge || edgeVoice !== voice) {
        if (edge) try { edge.close(); } catch {}
        edge = new MsEdgeTTS({ connectionTimeoutMs: 8000, synthesisTimeoutMs: 20000 });
        await edge.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
        edgeVoice = voice;
      }
      const { audioStream } = edge.toStream(text);
      const chunks = [];
      for await (const c of audioStream) chunks.push(c);
      const buf = Buffer.concat(chunks);
      if (!buf.length) throw new Error('empty audio');
      return buf;
    } catch (e) {
      try { edge && edge.close(); } catch {}
      edge = null;  // reconnect and retry, then give up (the app falls back to the Windows voice)
      if (attempt === 2) throw e;
    }
  }
}

// ---------------- phone link server ----------------
function lanAddresses() {
  // Skip virtual adapters (VirtualBox, VMware, Hyper-V, WSL...): the phone can never reach those.
  // Windows often names them just "Ethernet 2", so also check the maker part of the MAC address.
  const virtual = /virtualbox|vmware|vethernet|hyper-v|wsl|loopback|docker|vbox/i;
  const virtualMac = /^(0a:00:27|08:00:27|00:50:56|00:0c:29|00:05:69|00:1c:14|00:15:5d)/i;
  const out = [];
  Object.entries(os.networkInterfaces()).forEach(([name, list]) => (list || []).forEach(i => {
    if (i.family === 'IPv4' && !i.internal && !virtual.test(name) && !virtualMac.test(i.mac || '') && !i.address.startsWith('169.254.')) out.push(i.address);
  }));
  // Home Wi-Fi style addresses first, Tailscale (100.x) last
  return out.sort((a, b) => (a.startsWith('100.') ? 1 : 0) - (b.startsWith('100.') ? 1 : 0));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 30e6) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
  });
}

// ---------------- easy pairing ----------------
// Instead of typing the long pairing code, the phone scans a QR code (or types a
// 6-digit PIN). The PIN only works for 10 minutes and for 5 wrong tries; the phone
// swaps it for the real code over /api/pair.
const PAIR_MS = 10 * 60 * 1000;
let pairing = null; // { pin, expires, tries }
function newPairing() {
  pairing = { pin: String(crypto.randomInt(0, 1e6)).padStart(6, '0'), expires: Date.now() + PAIR_MS, tries: 0 };
  return pairing;
}
async function pairingInfo(fresh) {
  if (fresh || !pairing || pairing.expires < Date.now() || pairing.tries >= 5) newPairing();
  const port = store.config.remote.port;
  const addresses = lanAddresses().map(ip => ip + ':' + port);
  // What the QR holds: every address this laptop has, plus the PIN.
  const link = 'splashai://pair?a=' + encodeURIComponent(addresses.join(',')) + '&p=' + pairing.pin;
  const QRCode = require('qrcode');
  const qr = await QRCode.toDataURL(link, { margin: 1, width: 360, errorCorrectionLevel: 'M', color: { dark: '#06131f', light: '#e6f4f5' } });
  return { pin: pairing.pin, expires: pairing.expires, addresses, qr, enabled: store.config.remote.enabled };
}
function tryPair(pin) {
  if (!store.config.remote.enabled) return { code: 403, body: { error: 'Phone control is switched off on the laptop' } };
  if (!pairing || pairing.expires < Date.now()) return { code: 410, body: { error: 'That PIN has expired. Open Settings, Phone link on the laptop for a new one.' } };
  if (pairing.tries >= 5) return { code: 429, body: { error: 'Too many wrong tries. Open Settings, Phone link on the laptop for a new PIN.' } };
  if (String(pin || '').replace(/\D/g, '') !== pairing.pin) { pairing.tries++; return { code: 401, body: { error: 'Wrong PIN' } }; }
  pairing = null; // one phone per PIN
  send('toast', 'Your phone is now linked to this laptop.');
  send('paired');
  return { code: 200, body: { token: store.config.remote.token, computer: os.hostname() } };
}

function phoneConversation() {
  const day = new Date().toISOString().slice(0, 10);
  const cid = 'phonelink-' + day;
  return store.getConversation(cid) || { ...store.newConversation('phone'), id: cid, title: 'From phone, ' + day };
}

function startServer() {
  if (server) { try { server.close(); } catch {} server = null; }
  const { port, enabled, token } = store.config.remote;
  server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-splash-token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const url = new URL(req.url, 'http://x');
    const json = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    try {
      if (url.pathname === '/models/vosk.tar.gz') {
        const p = modelPath();
        if (!fs.existsSync(p)) return json(404, { error: 'model not downloaded' });
        res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': fs.statSync(p).size });
        return fs.createReadStream(p).pipe(res);
      }
      if (!url.pathname.startsWith('/api/')) return json(404, { error: 'not found' });
      if (url.pathname === '/api/pair' && req.method === 'POST') {
        const r = tryPair((await readBody(req)).pin);
        return json(r.code, r.body);
      }
      if (!enabled || req.headers['x-splash-token'] !== token) return json(401, { error: 'wrong pairing code' });

      if (url.pathname === '/api/ping') return json(200, { ok: true, computer: os.hostname() });

      if (url.pathname === '/api/command' && req.method === 'POST') {
        const body = await readBody(req);
        const jobId = crypto.randomBytes(8).toString('hex');
        const job = { state: 'running', confirm: null, result: null, error: null, steps: [], at: Date.now() };
        jobs.set(jobId, job);
        send('remote', { text: body.text });
        const c = phoneConversation();
        ask(String(body.text || ''), {
          c, source: 'phone', heard: ['typed', 'wake', 'open'].includes(body.heard) ? body.heard : 'wake',
          onStep: s => job.steps.push({ type: s.type, ok: s.ok }),
          confirm: text => new Promise(resolve => {
            const id = crypto.randomBytes(6).toString('hex');
            job.state = 'confirm'; job.confirm = { id, text };
            pendingConfirms.set(id, ok => { job.state = 'running'; job.confirm = null; resolve(ok); });
          }),
        }).then(r => { job.state = 'done'; job.result = { say: r.say, explain: r.explain, visual: r.visual, ignored: r.ignored, listen: r.listen, expectReply: r.expectReply, steps: r.steps.map(s => ({ type: s.type, ok: s.ok, result: String(s.result).slice(0, 400) })), provider: r.provider }; send('history-changed'); })
          .catch(e => { job.state = 'error'; job.error = String(e.message || e); });
        return json(200, { jobId });
      }
      if (url.pathname === '/api/job') {
        const job = jobs.get(url.searchParams.get('id'));
        if (!job) return json(404, { error: 'unknown job' });
        return json(200, job);
      }
      if (url.pathname === '/api/confirm' && req.method === 'POST') {
        const body = await readBody(req);
        const r = pendingConfirms.get(body.id);
        if (r) { pendingConfirms.delete(body.id); r(!!body.ok); }
        return json(200, { ok: true });
      }
      if (url.pathname === '/api/tts' && req.method === 'POST') {
        const body = await readBody(req);
        const buf = await synthesize(body.text, body.voice || store.config.voice.replace(/^edge:/, ''));
        return json(200, { audio: buf.toString('base64') });
      }
      if (url.pathname === '/api/sync' && req.method === 'GET') {
        return json(200, { ...store.exportForPhone(), providers: store.config.providers, names: store.config.names, wakeWords: store.config.wakeWords, computer: os.hostname() });
      }
      if (url.pathname === '/api/sync' && req.method === 'POST') {
        store.mergeFromPhone(await readBody(req));
        send('history-changed');
        return json(200, { ok: true });
      }
      return json(404, { error: 'not found' });
    } catch (e) { return json(500, { error: String(e.message || e) }); }
  });
  server.on('error', e => send('toast', 'Phone link could not start on port ' + port + ': ' + e.message));
  server.listen(port, enabled ? '0.0.0.0' : '127.0.0.1');
  // clean old jobs
  setInterval(() => { const cut = Date.now() - 3600e3; for (const [k, j] of jobs) if (j.at < cut) jobs.delete(k); }, 600e3).unref();
}

// ---------------- window / tray ----------------
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600,
    backgroundColor: '#06131f', show: !store.config.startHidden, icon: ICON,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#06131f', symbolColor: '#9fe9f0', height: 36 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('close', e => { if (!quitting) { e.preventDefault(); win.hide(); } });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('Splash AI');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Splash AI', click: () => { win.show(); win.focus(); } },
    { label: 'Talk now', click: () => { win.show(); send('ptt'); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => { win.isVisible() ? win.focus() : win.show(); });
}

function applySystemSettings() {
  globalShortcut.unregisterAll();
  if (store.config.hotkey) {
    try { globalShortcut.register(store.config.hotkey, () => { win.show(); win.focus(); send('ptt'); }); } catch {}
  }
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!store.config.startWithWindows, args: ['--hidden'] });
}

function publicState() {
  return {
    config: store.config,
    memory: store.memory,
    conversations: store.listConversations(),
    conv,
    router: getRouter().status(),
    dataDir: store.dataDir,
    lan: lanAddresses(),
    computer: os.hostname(),
  };
}

// ---------------- IPC ----------------
function registerIpc() {
  ipcMain.handle('get-state', () => publicState());
  ipcMain.handle('save-config', (_, patch) => {
    const before = JSON.stringify(store.config.remote);
    store.saveConfig(patch);
    applySystemSettings();
    if (JSON.stringify(store.config.remote) !== before) startServer();
    return publicState();
  });
  ipcMain.handle('regen-token', () => {
    store.saveConfig({ remote: { ...store.config.remote, token: crypto.randomBytes(16).toString('hex') } });
    startServer();
    return publicState();
  });
  ipcMain.handle('ask', async (_, text, heard) => {
    try {
      const r = await ask(text, { c: conv, source: 'laptop', confirm: localConfirm, onStep: s => send('step', s), heard });
      return { ok: true, ...r };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('confirm-reply', (_, { id, ok }) => {
    const r = pendingConfirms.get(id);
    if (r) { pendingConfirms.delete(id); r(!!ok); }
  });
  ipcMain.handle('new-conversation', () => { conv = store.newConversation(); return publicState(); });
  ipcMain.handle('open-conversation', (_, id) => { const c = store.getConversation(id); if (c) conv = c; return publicState(); });
  // Attach from the paperclip (no path: show the file picker) or from drag-and-drop (path given).
  ipcMain.handle('attach-document', async (_, dropped) => {
    let file = dropped;
    if (!file) {
      const pick = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Documents', extensions: ['pdf', 'docx', ...TEXT_TYPES.map(t => t.slice(1))] }] });
      if (pick.canceled || !pick.filePaths[0]) return { ok: false, canceled: true };
      file = pick.filePaths[0];
    }
    if ((conv.docs || []).length >= 5) return { ok: false, error: 'Five documents is the limit for one conversation. Remove one first.' };
    try {
      const doc = await attachDocument(file);
      return { ok: true, name: doc.name, count: doc.pages.length, unit: doc.unit, blank: doc.blank, state: publicState() };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('detach-document', (_, docId) => {
    removeExtract(docsDir(), docId);
    conv.docs = (conv.docs || []).filter(d => d.id !== docId);
    store.saveConversation(conv);
    return publicState();
  });
  ipcMain.handle('delete-conversation', (_, id) => {
    removeConversationDocs(store.getConversation(id));
    store.deleteConversation(id);
    if (conv.id === id) conv = store.newConversation();
    return publicState();
  });
  ipcMain.handle('delete-all-history', () => {
    store.listConversations().forEach(c => { removeConversationDocs(store.getConversation(c.id)); store.deleteConversation(c.id); });
    conv = store.newConversation();
    return publicState();
  });
  ipcMain.handle('list-notes', () => store.listNotes());
  ipcMain.handle('delete-notes', (_, date) => { store.deleteNotes(date); return store.listNotes(); });
  ipcMain.handle('add-memory', (_, { kind, text }) => { store.addMemory(kind, text, 'laptop'); return publicState(); });
  ipcMain.handle('delete-memory', (_, { kind, id }) => { store.removeMemory(kind, id); return publicState(); });
  ipcMain.handle('router-wake', (_, id) => { getRouter().wake(id); store.saveRouterState(getRouter().state); return getRouter().status(); });
  ipcMain.handle('router-status', () => getRouter().status());
  ipcMain.handle('transcribe', (_, buf) => transcribe(buf));
  ipcMain.handle('natural-voices', () => NATURAL_VOICES);
  ipcMain.handle('make-custom-model', (_, form) => { try { return { ok: true, provider: customProvider(form) }; } catch (e) { return { ok: false, result: e.message }; } });
  ipcMain.handle('test-model', async (_, form) => { try { return await testProvider(customProvider(form)); } catch (e) { return { ok: false, result: e.message }; } });
  ipcMain.handle('pairing-info', (_, fresh) => pairingInfo(!!fresh));
  ipcMain.handle('tts', async (_, { text, voice }) => {
    try { return { ok: true, audio: await synthesize(text, voice) }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
  ipcMain.handle('model-url', async () => {
    await ensureModel();
    return `http://127.0.0.1:${store.config.remote.port}/models/vosk.tar.gz`;
  });
  ipcMain.handle('open-external', (_, u) => shell.openExternal(u));
  ipcMain.handle('open-data-folder', () => shell.openPath(store.dataDir));
}

// ---------------- start ----------------
app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
app.whenReady().then(() => {
  store = new Store();
  if (process.argv.includes('--hidden')) store.config.startHidden = true;
  conv = store.newConversation();
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(['media', 'notifications', 'clipboard-read'].includes(perm)));
  session.defaultSession.setPermissionCheckHandler((wc, perm) => ['media', 'notifications'].includes(perm));
  registerIpc();
  startServer();
  createWindow();
  createTray();
  applySystemSettings();
});
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', e => e.preventDefault());
