// Everything Splash AI remembers lives in Documents\Splash AI so you can see it,
// back it up, or copy it to another PC. Settings and keys live in AppData.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const { defaultProviderConfig, mergeProviderConfig } = require('./shared/router.js');

const id = () => Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
const day = (d = new Date()) => d.toISOString().slice(0, 10);

function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJSON(p, data) {
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

class Store {
  constructor() {
    this.userDir = app.getPath('userData');
    this.dataDir = path.join(app.getPath('documents'), 'Splash AI');
    this.convDir = path.join(this.dataDir, 'conversations');
    this.notesDir = path.join(this.dataDir, 'notes');
    this.memPath = path.join(this.dataDir, 'memory.json');
    this.cfgPath = path.join(this.userDir, 'config.json');
    this.statePath = path.join(this.userDir, 'router-state.json');
    [this.dataDir, this.convDir, this.notesDir].forEach(d => fs.mkdirSync(d, { recursive: true }));
    this.config = this.loadConfig();
    this.memory = readJSON(this.memPath, { facts: [], lessons: [] });
    this.routerState = readJSON(this.statePath, {});
  }

  // ---------- settings ----------
  loadConfig() {
    const def = {
      names: ['Kelvin', 'Ksplash'],
      wakeWords: ['hey splash ai', 'hello splash ai', 'hey splash', 'hello splash'],
      providers: defaultProviderConfig(),
      confirmDangerous: true,
      speak: true,
      voice: 'edge:en-NG-AbeoNeural', // 'edge:<id>' = natural online voice, 'windows' = Windows default, else a Windows voice name
      useWhisper: true,
      hotkey: 'Control+Space',
      startWithWindows: false,
      startHidden: false,
      remote: { enabled: true, port: 7777, token: crypto.randomBytes(16).toString('hex') },
    };
    const saved = readJSON(this.cfgPath, {});
    const cfg = { ...def, ...saved, remote: { ...def.remote, ...(saved.remote || {}) } };
    cfg.providers = mergeProviderConfig(saved.providers || def.providers);
    if (!cfg.voice) cfg.voice = def.voice; // older versions saved '' for the Windows default
    if (!saved.remote) writeJSON(this.cfgPath, cfg);
    return cfg;
  }
  saveConfig(patch) {
    if (patch) {
      Object.assign(this.config, patch);
      if (patch.providers) this.config.providers = mergeProviderConfig(patch.providers);
    }
    writeJSON(this.cfgPath, this.config);
    return this.config;
  }
  saveRouterState(s) { this.routerState = s; writeJSON(this.statePath, s); }

  // ---------- memory: facts + lessons ----------
  addMemory(kind, text, source = 'laptop') {
    text = String(text || '').trim();
    if (!text) return null;
    const list = this.memory[kind];
    if (list.some(x => x.text.toLowerCase() === text.toLowerCase())) return null;
    const item = { id: id(), text, at: new Date().toISOString(), source };
    list.push(item);
    writeJSON(this.memPath, this.memory);
    return item;
  }
  removeMemory(kind, itemId) {
    this.memory[kind] = this.memory[kind].filter(x => x.id !== itemId);
    writeJSON(this.memPath, this.memory);
  }
  forgetMatching(text) {
    const q = String(text || '').toLowerCase();
    let n = 0;
    for (const kind of ['facts', 'lessons']) {
      const before = this.memory[kind].length;
      this.memory[kind] = this.memory[kind].filter(x => !x.text.toLowerCase().includes(q));
      n += before - this.memory[kind].length;
    }
    writeJSON(this.memPath, this.memory);
    return n;
  }

  // ---------- conversations ----------
  newConversation(source = 'laptop') {
    const now = new Date().toISOString();
    return { id: id(), title: 'New conversation', source, created: now, updated: now, messages: [] };
  }
  listConversations() {
    return fs.readdirSync(this.convDir).filter(f => f.endsWith('.json')).map(f => {
      const c = readJSON(path.join(this.convDir, f), null);
      return c && { id: c.id, title: c.title, source: c.source, updated: c.updated, count: c.messages.length };
    }).filter(Boolean).sort((a, b) => b.updated.localeCompare(a.updated));
  }
  getConversation(cid) { return readJSON(path.join(this.convDir, cid + '.json'), null); }
  saveConversation(c) {
    c.updated = new Date().toISOString();
    if (c.title === 'New conversation') {
      const first = c.messages.find(m => m.role === 'user');
      if (first) c.title = first.content.slice(0, 60);
    }
    writeJSON(path.join(this.convDir, c.id + '.json'), c);
  }
  deleteConversation(cid) { try { fs.unlinkSync(path.join(this.convDir, cid + '.json')); } catch {} }

  // ---------- notes ----------
  addNote(text, source = 'laptop') {
    text = String(text || '').trim();
    if (!text) return;
    const d = new Date();
    const file = path.join(this.notesDir, day(d) + '.md');
    if (!fs.existsSync(file)) fs.writeFileSync(file, `# Notes, ${day(d)}\n\n`);
    const tag = source === 'phone' ? ' (phone)' : '';
    fs.appendFileSync(file, `- ${d.toTimeString().slice(0, 5)}${tag} ${text}\n`);
  }
  listNotes() {
    return fs.readdirSync(this.notesDir).filter(f => f.endsWith('.md')).sort().reverse()
      .map(f => ({ date: f.replace('.md', ''), content: fs.readFileSync(path.join(this.notesDir, f), 'utf8') }));
  }
  deleteNotes(date) { try { fs.unlinkSync(path.join(this.notesDir, date + '.md')); } catch {} }
  recentNotes(n = 30) {
    const lines = [];
    for (const nd of this.listNotes()) {
      nd.content.split('\n').filter(l => l.startsWith('- ')).reverse().forEach(l => lines.push(`[${nd.date}] ${l.slice(2)}`));
      if (lines.length >= n) break;
    }
    return lines.slice(0, n).reverse();
  }

  // ---------- sync with phone ----------
  mergeFromPhone(data) {
    (data.facts || []).forEach(f => this.addMemory('facts', f.text, 'phone'));
    (data.lessons || []).forEach(l => this.addMemory('lessons', l.text, 'phone'));
    (data.notes || []).forEach(n => this.addNote(n.text, 'phone'));
    (data.conversations || []).forEach(c => {
      if (!c || !c.id || !Array.isArray(c.messages)) return;
      const existing = this.getConversation(c.id);
      if (!existing || existing.messages.length <= c.messages.length) {
        writeJSON(path.join(this.convDir, c.id + '.json'), { ...c, source: 'phone' });
      }
    });
  }
  exportForPhone() {
    const convs = this.listConversations().slice(0, 50).map(c => this.getConversation(c.id)).filter(Boolean);
    return { facts: this.memory.facts, lessons: this.memory.lessons, conversations: convs, notes: this.recentNotes(200) };
  }
}

module.exports = { Store };
