// The things Splash AI can do on a Windows PC.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { shell, clipboard, Notification, desktopCapturer, screen, app } = require('electron');

const ACTIONS_DOC = `- {"type":"list","path":"C:\\\\Users\\\\..."}  list a folder
- {"type":"read","path":"..."}  read a text file
- {"type":"write","path":"...","content":"..."}  create or overwrite a file (missing folders are created)
- {"type":"append","path":"...","content":"..."}  add text to the end of a file
- {"type":"mkdir","path":"..."}  create a folder
- {"type":"delete","path":"...","permanent":false}  delete a file or folder (Recycle Bin unless permanent is true)
- {"type":"move","from":"...","to":"..."}  move or rename
- {"type":"copy","from":"...","to":"..."}  copy a file or folder
- {"type":"find","dir":"...","name":"part of the file name"}  search for files by name, including subfolders
- {"type":"open","path":"..."}  open a file, folder or program with its default app
- {"type":"url","url":"https://..."}  open a website in the browser
- {"type":"run","command":"..."}  run a PowerShell command and get its output. Use it for launching apps (Start-Process), processes, volume, Wi-Fi, installing software (winget), system settings, typing keys, and anything the other actions don't cover
- {"type":"clipboard_set","text":"..."} and {"type":"clipboard_get"}
- {"type":"research_paper","topic":"...","length":"short|medium|long","instructions":"any extra wishes, or empty"}  research real published papers and write a referenced Word document (takes a few minutes). ALWAYS use this when he asks for research or a research paper or essay with references; never write one yourself or invent references. Lengths are about 1500, 3000 or 6000 words; use medium if he doesn't say. If the topic is unclear, ask him first.
- {"type":"launch","app":"calc"}  start an app by its name, e.g. calc, notepad, chrome, msedge, winword, excel, explorer, spotify
- {"type":"look","question":"what you are trying to do"}  see the screen: the window in front, a numbered list of its buttons, links and boxes, the open windows, and (when available) a description of a picture of the screen
- {"type":"click","element":12}  click a numbered item from the last look ("double":true or "right":true for double or right click). Or {"type":"click","x":640,"y":400} for a spot on the screen
- {"type":"type","text":"...","enter":false}  type into whatever is selected (click the box first); "enter":true presses Enter after
- {"type":"keys","keys":"ctrl+s"}  press keys, e.g. "enter", "tab", "esc", "ctrl+l", "alt+tab", "win+d", "f5", or several: "ctrl+a, ctrl+c"
- {"type":"scroll","direction":"down","amount":5}  scroll the window in front up or down
- {"type":"focus","window":"part of the window title or app name"}  bring an open window to the front
- {"type":"wait","seconds":2}  wait for something to load
To operate an app like a person would: launch or focus it, look, then click, type or press keys, then look again to check it worked. You must look before clicking, typing or pressing keys, and look again whenever the window in front may have changed, and keep going step by step until the job is done. Use the quicker direct actions (open, url, run) when they do the job. Before clicking something that sends, posts, pays, buys or deletes, tell him what you are about to do and get his yes first.
Quick routes for messages (he must already be signed in on this laptop):
- Gmail: open the url https://mail.google.com/mail/?view=cm&to=ADDRESS&su=SUBJECT&body=BODY (each part URL-encoded), wait 3 seconds, look, check the details, then after his yes press ctrl+enter to send.
- WhatsApp: if the WhatsApp app is installed, open the url whatsapp://send?phone=NUMBER&text=MESSAGE, otherwise https://web.whatsapp.com/send?phone=NUMBER&text=MESSAGE. NUMBER is in international form with no + or spaces (e.g. 2348012345678). Wait, look, then after his yes press enter. If he gives a name instead of a number, open WhatsApp, look, search for the name, and pick the chat.
- Facebook: https://www.facebook.com (and https://www.facebook.com/messages for chats). Use look, click and type from there.
If a page asks him to sign in, stop and tell him; never type passwords.
- {"type":"screenshot"}  save a screenshot to Pictures\\Splash AI
- {"type":"notify","title":"...","text":"..."}  show a Windows notification
- {"type":"sysinfo"}  computer details: user, folders, drives, memory
- {"type":"remember","fact":"..."}  save a fact about Kelvin permanently
- {"type":"forget","match":"..."}  forget saved facts or lessons that contain this text`;

function knownFolders() {
  return {
    home: os.homedir(),
    desktop: app.getPath('desktop'),
    documents: app.getPath('documents'),
    downloads: app.getPath('downloads'),
    pictures: app.getPath('pictures'),
    music: app.getPath('music'),
    videos: app.getPath('videos'),
  };
}

function contextLine() {
  const f = knownFolders();
  return `Windows user "${os.userInfo().username}" on computer "${os.hostname()}". Folders: ` +
    Object.entries(f).map(([k, v]) => `${k}=${v}`).join(', ') + '.';
}

function fullPath(p) {
  if (!p) throw new Error('No path given');
  let s = String(p).trim().replace(/^["']|["']$/g, '');
  s = s.replace(/%([^%]+)%/g, (_, v) => process.env[v] || process.env[v.toUpperCase()] || _);
  if (s.startsWith('~')) s = path.join(os.homedir(), s.slice(1));
  const f = knownFolders();
  const first = s.split(/[\\/]/)[0].toLowerCase();
  if (!path.isAbsolute(s) && f[first]) s = path.join(f[first], s.slice(first.length));
  if (!path.isAbsolute(s)) s = path.join(f.desktop, s);
  return path.normalize(s);
}

function powershell(command, timeout = 120000) {
  return new Promise(resolve => {
    const b64 = Buffer.from(String(command), 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64],
      { timeout, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const out = (String(stdout || '') + (stderr ? '\n[stderr] ' + stderr : '')).trim();
        resolve({ ok: !err, result: (out || (err ? String(err.message) : 'Done, no output.')).slice(0, 12000) });
      });
  });
}

async function find(dir, name, limit = 50) {
  const q = String(name || '').toLowerCase();
  const results = [];
  const skip = new Set(['node_modules', '.git', '$Recycle.Bin', 'AppData', 'Windows']);
  async function walk(d, depth) {
    if (results.length >= limit || depth > 7) return;
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (results.length >= limit) return;
      const p = path.join(d, e.name);
      if (e.name.toLowerCase().includes(q)) results.push(p + (e.isDirectory() ? '\\' : ''));
      if (e.isDirectory() && !skip.has(e.name)) await walk(p, depth + 1);
    }
  }
  await walk(dir, 0);
  return results;
}

function describe(a) {
  switch (a.type) {
    case 'delete': return `${a.permanent ? 'Permanently delete' : 'Delete (to Recycle Bin)'}: ${a.path}`;
    case 'run': return `Run this PowerShell command:\n${a.command}`;
    case 'write': return `Overwrite existing file: ${a.path}`;
    default: return `${a.type}: ${JSON.stringify(a)}`;
  }
}

const LOOK_ONLY = new Set(['list', 'read', 'find', 'sysinfo', 'look', 'wait']);

// documentOpen: a file he attached is part of this turn, and files can contain hidden
// instructions, so anything beyond looking needs his OK even if confirmations are off.
function makeExecutor({ store, confirm, research, documentOpen, control }) {
  return async function execute(a) {
    const type = String(a.type || '').toLowerCase();
    let risky = type === 'delete' || type === 'run';
    if (type === 'write') { try { risky = fs.existsSync(fullPath(a.path)); } catch {} }
    const guarded = documentOpen && !LOOK_ONLY.has(type);
    if (guarded || (risky && store.config.confirmDangerous)) {
      const ok = await confirm((guarded ? 'A document is attached. Make sure you asked for this:\n' : '') + describe({ ...a, type }));
      if (!ok) return { ok: false, result: 'Kelvin declined this action. Do not retry it.' };
    }
    switch (type) {
      case 'list': {
        const p = fullPath(a.path);
        const entries = await fsp.readdir(p, { withFileTypes: true });
        const lines = await Promise.all(entries.slice(0, 300).map(async e => {
          if (e.isDirectory()) return `[folder] ${e.name}`;
          try { const s = await fsp.stat(path.join(p, e.name)); return `${e.name} (${Math.round(s.size / 1024)} KB)`; }
          catch { return e.name; }
        }));
        return { ok: true, result: `${p}\n` + (lines.join('\n') || '(empty)') + (entries.length > 300 ? `\n...and ${entries.length - 300} more` : '') };
      }
      case 'read': {
        const p = fullPath(a.path);
        const txt = await fsp.readFile(p, 'utf8');
        return { ok: true, result: txt.length > 12000 ? txt.slice(0, 12000) + '\n...(cut off)' : txt };
      }
      case 'write': case 'create': {
        const p = fullPath(a.path);
        await fsp.mkdir(path.dirname(p), { recursive: true });
        await fsp.writeFile(p, String(a.content ?? ''), 'utf8');
        return { ok: true, result: 'Saved ' + p };
      }
      case 'append': {
        const p = fullPath(a.path);
        await fsp.mkdir(path.dirname(p), { recursive: true });
        await fsp.appendFile(p, String(a.content ?? ''), 'utf8');
        return { ok: true, result: 'Appended to ' + p };
      }
      case 'mkdir': {
        const p = fullPath(a.path);
        await fsp.mkdir(p, { recursive: true });
        return { ok: true, result: 'Created ' + p };
      }
      case 'delete': {
        const p = fullPath(a.path);
        if (!fs.existsSync(p)) return { ok: false, result: 'Not found: ' + p };
        if (a.permanent) await fsp.rm(p, { recursive: true, force: true });
        else await shell.trashItem(p);
        return { ok: true, result: (a.permanent ? 'Permanently deleted ' : 'Moved to Recycle Bin: ') + p };
      }
      case 'move': case 'rename': {
        const from = fullPath(a.from || a.path), to = fullPath(a.to);
        await fsp.mkdir(path.dirname(to), { recursive: true });
        await fsp.rename(from, to);
        return { ok: true, result: `Moved ${from} -> ${to}` };
      }
      case 'copy': {
        const from = fullPath(a.from || a.path), to = fullPath(a.to);
        await fsp.mkdir(path.dirname(to), { recursive: true });
        await fsp.cp(from, to, { recursive: true });
        return { ok: true, result: `Copied ${from} -> ${to}` };
      }
      case 'find': {
        const res = await find(fullPath(a.dir || 'home'), a.name || a.query);
        return { ok: true, result: res.length ? res.join('\n') : 'Nothing found.' };
      }
      case 'open': {
        const target = String(a.path || a.app || '');
        const p = /[\\/]/.test(target) ? fullPath(target) : target;
        const err = await shell.openPath(p);
        if (err) return powershell(`Start-Process "${target.replace(/"/g, '')}"`);
        return { ok: true, result: 'Opened ' + p };
      }
      case 'url': {
        let u = String(a.url || '');
        if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
        await shell.openExternal(u);
        return { ok: true, result: 'Opened ' + u };
      }
      case 'run': case 'powershell': case 'cmd':
        return powershell(a.command || a.cmd || '', (a.timeoutSeconds || 120) * 1000);
      case 'research_paper': {
        if (!research) return { ok: false, result: 'Research is not available here.' };
        const r = await research(a);
        shell.openPath(r.file);
        return { ok: true, result: `Saved and opened "${r.title}" at ${r.file}: about ${r.words} words, ${r.cited} real sources cited out of ${r.found} found. It was written from the papers' abstracts, so he should read it and check the key claims.` };
      }
      case 'look': case 'click': case 'type': case 'keys': case 'scroll': case 'focus': case 'launch':
        return control[type](a);
      case 'press': return control.keys(a);
      case 'wait': await new Promise(r => setTimeout(r, Math.min(15, Math.max(0.2, Number(a.seconds) || 1)) * 1000)); return { ok: true, result: 'Waited.' };
      case 'clipboard_set': clipboard.writeText(String(a.text || '')); return { ok: true, result: 'Copied to clipboard.' };
      case 'clipboard_get': return { ok: true, result: clipboard.readText() || '(clipboard is empty)' };
      case 'screenshot': {
        const d = screen.getPrimaryDisplay();
        const size = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
        const dir = path.join(app.getPath('pictures'), 'Splash AI');
        await fsp.mkdir(dir, { recursive: true });
        const file = path.join(dir, 'screenshot-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png');
        await fsp.writeFile(file, sources[0].thumbnail.toPNG());
        return { ok: true, result: 'Saved ' + file };
      }
      case 'notify':
        new Notification({ title: String(a.title || 'Splash AI'), body: String(a.text || '') }).show();
        return { ok: true, result: 'Notification shown.' };
      case 'sysinfo': {
        const drives = await powershell('Get-PSDrive -PSProvider FileSystem | ForEach-Object { "$($_.Name): free $([math]::Round($_.Free/1GB,1)) GB, used $([math]::Round($_.Used/1GB,1)) GB" }', 20000);
        return { ok: true, result: `${contextLine()}\nOS: ${os.type()} ${os.release()} ${os.arch()}\nCPU: ${os.cpus()[0] && os.cpus()[0].model} x${os.cpus().length}\nRAM: ${Math.round(os.freemem() / 1e9)} GB free of ${Math.round(os.totalmem() / 1e9)} GB\n${drives.result}` };
      }
      case 'remember': {
        const item = store.addMemory('facts', a.fact || a.text, 'laptop');
        return { ok: true, result: item ? 'Remembered.' : 'Already known.' };
      }
      case 'forget': {
        const n = store.forgetMatching(a.match || a.text);
        return { ok: true, result: `Forgot ${n} item(s).` };
      }
      default:
        return { ok: false, result: `Unknown action "${a.type}". Use one of the listed actions, or "run" with PowerShell.` };
    }
  };
}

module.exports = { ACTIONS_DOC, contextLine, makeExecutor, powershell };
