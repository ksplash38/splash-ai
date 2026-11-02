/* Splash AI for Android */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const when = iso => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const Cap = window.Capacitor;
const plugin = name => Cap && (Cap.Plugins[name] || (Cap.registerPlugin && Cap.registerPlugin(name)));
const Speech = plugin('SpeechRecognition');
const TTS = plugin('TextToSpeech');
const Launcher = plugin('AppLauncher');
const Share = plugin('Share');

// ---------- storage ----------
const KEY = 'splash-ai-v1';
function load() {
  let d = {};
  try { d = JSON.parse(localStorage.getItem(KEY)) || {}; } catch {}
  d.config = Object.assign({
    names: ['Kelvin', 'Ksplash'],
    wakeWords: ['hey splash ai', 'hello splash ai', 'hey splash', 'hello splash'],
    speak: true, laptop: { address: '', token: '' },
  }, d.config || {});
  d.config.providers = SplashRouter.mergeProviderConfig(d.config.providers);
  d.memory = d.memory || { facts: [], lessons: [] };
  d.conversations = d.conversations || {};
  d.notes = d.notes || [];          // notes written on this phone
  d.laptopNotes = d.laptopNotes || [];
  d.pending = d.pending || { facts: [], lessons: [], notes: [], convs: [] };
  d.routerState = d.routerState || {};
  d.currentId = d.currentId || null;
  return d;
}
const D = load();
const save = () => localStorage.setItem(KEY, JSON.stringify(D));

function currentConv() {
  let c = D.currentId && D.conversations[D.currentId];
  if (!c) {
    const now = new Date().toISOString();
    c = { id: 'p' + uid(), title: 'New conversation', source: 'phone', created: now, updated: now, messages: [] };
    D.conversations[c.id] = c; D.currentId = c.id;
  }
  return c;
}
function addMemory(kind, text, source = 'phone') {
  text = String(text || '').trim();
  if (!text || D.memory[kind].some(x => x.text.toLowerCase() === text.toLowerCase())) return false;
  const item = { id: uid(), text, at: new Date().toISOString(), source };
  D.memory[kind].push(item);
  if (source === 'phone') D.pending[kind].push(item);
  save(); return true;
}
function addNote(text) {
  text = String(text || '').trim(); if (!text) return;
  const n = { text, at: new Date().toISOString() };
  D.notes.push(n); D.pending.notes.push(n); save();
}

// ---------- UI helpers ----------
const core = new SplashCore($('#core'));
function toast(msg, ms = 3500) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms); }
function setState(s, label) { core.setState(s); if (label) $('#stateLabel').textContent = label; }
let fakeLevel = null;
function pulse(on) {
  clearInterval(fakeLevel);
  if (on) fakeLevel = setInterval(() => core.setLevel(0.25 + Math.random() * 0.6), 90);
  else core.setLevel(0);
}

document.querySelectorAll('.bottomnav button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.bottomnav button').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('on', v.id === 'view-' + b.dataset.view));
  if (b.dataset.view === 'talk') setTimeout(() => core.resize(), 30);
  if (b.dataset.view === 'history') renderHistory();
  if (b.dataset.view === 'notes') renderNotes();
  if (b.dataset.view === 'memory') renderMemory();
  if (b.dataset.view === 'settings') { draft = JSON.parse(JSON.stringify(D.config)); renderSettings(); }
});

// ---------- laptop link ----------
function lapBase() {
  let a = (D.config.laptop.address || '').trim();
  if (!a) return '';
  if (!/^https?:\/\//.test(a)) a = 'http://' + a;
  if (!/:\d+$/.test(a.replace(/\/$/, ''))) a = a.replace(/\/$/, '') + ':7777';
  return a.replace(/\/$/, '');
}
async function lap(path, opts = {}) {
  const base = lapBase();
  if (!base) throw new Error('Your laptop is not linked yet. Add it in Settings.');
  const r = await fetch(base + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'x-splash-token': D.config.laptop.token.trim() },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Laptop said HTTP ' + r.status);
  return j;
}
async function checkLink() {
  try { const j = await lap('/api/ping'); $('#linkBadge').textContent = 'Linked to ' + j.computer; $('#linkBadge').classList.add('ok'); return true; }
  catch { $('#linkBadge').textContent = lapBase() ? 'Laptop offline' : 'Laptop not linked'; $('#linkBadge').classList.remove('ok'); return false; }
}
function askConfirm(text) {
  return new Promise(resolve => {
    $('#confirmText').textContent = text; $('#confirmBox').hidden = false;
    $('#confirmYes').onclick = () => { $('#confirmBox').hidden = true; resolve(true); };
    $('#confirmNo').onclick = () => { $('#confirmBox').hidden = true; resolve(false); };
  });
}
async function laptopCommand(text) {
  const { jobId } = await lap('/api/command', { method: 'POST', body: { text } });
  const started = Date.now();
  while (Date.now() - started < 10 * 60 * 1000) {
    await new Promise(r => setTimeout(r, 900));
    const j = await lap('/api/job?id=' + jobId);
    if (j.state === 'confirm' && j.confirm) {
      const ok = await askConfirm(j.confirm.text);
      await lap('/api/confirm', { method: 'POST', body: { id: j.confirm.id, ok } });
    } else if (j.state === 'done') {
      return { ok: true, result: 'Laptop replied: ' + j.result.say + '\nSteps: ' + JSON.stringify(j.result.steps) };
    } else if (j.state === 'error') {
      return { ok: false, result: 'Laptop error: ' + j.error };
    }
  }
  return { ok: false, result: 'The laptop took too long.' };
}
async function sync(quiet = true) {
  if (!lapBase()) return;
  try {
    const convs = [...new Set(D.pending.convs)].map(id => D.conversations[id]).filter(Boolean);
    await lap('/api/sync', { method: 'POST', body: { facts: D.pending.facts, lessons: D.pending.lessons, notes: D.pending.notes, conversations: convs } });
    D.pending = { facts: [], lessons: [], notes: [], convs: [] };
    const j = await lap('/api/sync');
    j.facts.forEach(f => addMemory('facts', f.text, 'laptop'));
    j.lessons.forEach(l => addMemory('lessons', l.text, 'laptop'));
    j.conversations.forEach(c => {
      const mine = D.conversations[c.id];
      if (!mine || mine.messages.length < c.messages.length) D.conversations[c.id] = c;
    });
    D.laptopNotes = j.notes || [];
    save();
    if (!quiet) toast('Synced with ' + j.computer);
  } catch (e) { if (!quiet) toast('Sync failed: ' + e.message, 5000); }
}

// ---------- phone actions ----------
const ACTIONS_DOC = `- {"type":"laptop","command":"..."}  do something on Kelvin's Windows laptop (files, folders, apps, commands, anything on the PC). Write it as a full, clear instruction
- {"type":"open_app","package":"com.whatsapp"}  open an Android app by its package name
- {"type":"url","url":"https://..."}  open a website
- {"type":"call","number":"..."}  start a phone call
- {"type":"sms","number":"...","text":"..."}  open a text message, ready to send
- {"type":"share","text":"..."}  share text to another app
- {"type":"remember","fact":"..."}  save a fact about Kelvin permanently
- {"type":"forget","match":"..."}  forget saved facts or lessons containing this text`;

async function openUrl(url) {
  if (Launcher) { await Launcher.openUrl({ url }); return; }
  window.open(url, '_system');
}
async function execute(a) {
  const t = String(a.type || '').toLowerCase();
  switch (t) {
    case 'laptop': return laptopCommand(String(a.command || a.text || ''));
    case 'open_app': {
      try { await Launcher.openUrl({ url: String(a.package) }); return { ok: true, result: 'Opened ' + a.package }; }
      catch (e) { return { ok: false, result: 'Could not open ' + a.package + '. It may not be installed.' }; }
    }
    case 'url': { let u = String(a.url || ''); if (!/^https?:/i.test(u)) u = 'https://' + u; await openUrl(u); return { ok: true, result: 'Opened ' + u }; }
    case 'call': await openUrl('tel:' + String(a.number).replace(/[^\d+]/g, '')); return { ok: true, result: 'Dialer opened' };
    case 'sms': await openUrl('sms:' + String(a.number).replace(/[^\d+]/g, '') + '?body=' + encodeURIComponent(a.text || '')); return { ok: true, result: 'Message ready' };
    case 'share': if (Share) await Share.share({ text: String(a.text || '') }); return { ok: true, result: 'Share sheet opened' };
    case 'remember': return { ok: true, result: addMemory('facts', a.fact || a.text) ? 'Remembered.' : 'Already known.' };
    case 'forget': {
      const q = String(a.match || a.text || '').toLowerCase(); let n = 0;
      for (const k of ['facts', 'lessons']) { const b = D.memory[k].length; D.memory[k] = D.memory[k].filter(x => !x.text.toLowerCase().includes(q)); n += b - D.memory[k].length; }
      save(); return { ok: true, result: `Forgot ${n} item(s).` };
    }
    default:
      if (lapBase()) return laptopCommand(JSON.stringify(a));
      return { ok: false, result: 'Unknown action ' + a.type };
  }
}

// ---------- the brain ----------
const router = new SplashRouter.Router({ providers: D.config.providers }, D.routerState, (ev, data) => {
  if (ev === 'state') { D.routerState = data; save(); }
  if (ev === 'fallback') {
    // Keep every model that failed during this request on screen, not just the last one.
    if (Date.now() - fails.at > 20000) fails.list = [];
    fails.at = Date.now();
    fails.list.push('Error with ' + data.from + ': ' + (data.why || 'failed'));
    toast(fails.list.join('\n') + '\n' + (data.next ? 'Trying ' + data.next + '...' : 'No more checked models to try.'), 8000);
  }
});
const fails = { list: [], at: 0 };
let busy = false;

// ---------- speaking ----------
// Uses the laptop's natural voice (Abeo by default) when linked, otherwise the
// phone's own Nigerian English voice, otherwise any English voice.
let phoneAudio = null;
function stopSpeaking() {
  TTS && TTS.stop().catch(() => {});
  if (phoneAudio) { phoneAudio.pause(); phoneAudio = null; }
}
function playBase64Mp3(b64) {
  return new Promise(resolve => {
    phoneAudio = new Audio('data:audio/mpeg;base64,' + b64);
    const done = () => { phoneAudio = null; resolve(); };
    phoneAudio.onended = done; phoneAudio.onerror = done; phoneAudio.onpause = done;
    phoneAudio.play().catch(done);
  });
}
async function speak(text) {
  text = String(text).replace(/[*_#`]/g, '').replace(/https?:\/\/\S+/g, 'the link').slice(0, 700);
  if (lapBase()) {
    try {
      const j = await Promise.race([
        lap('/api/tts', { method: 'POST', body: { text } }),
        new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 8000)),
      ]);
      if (j.audio) return await playBase64Mp3(j.audio);
    } catch {}
  }
  if (!TTS) return;
  try { await TTS.speak({ text, lang: 'en-NG', rate: 1.0 }); }
  catch { try { await TTS.speak({ text, lang: 'en-US', rate: 1.0 }); } catch {} }
}

// heard: 'typed', 'wake' (wake word or tap to talk) or 'open' (follow-up listen, no wake word)
async function handle(text, heard = 'typed') {
  text = String(text || '').trim();
  if (!text || busy) return;
  const byVoice = heard !== 'typed';
  const lc = SplashBrain.listenCommand(text);
  if (lc) {
    // "stop listening", "leave me alone", "turn off the mic": no follow-ups; 'off' also ends hands-free
    stopSpeaking();
    if (lc === 'off' && handsFree) $('#handsFree').click();
    busy = true;
    await speak(lc === 'off' ? 'Alright, mic off. Tap the core when you need me.' : "No wahala, I'll leave you to it.");
    busy = false;
    setState('idle', handsFree ? 'Listening for your wake word' : 'Tap the core to talk');
    if (handsFree) setTimeout(listenLoop, 600);
    return;
  }
  if (/^(stop|cancel|wait|hold on|never ?mind|forget it|be quiet)[.!]*$/i.test(text)) { stopSpeaking(); return; }
  busy = true;
  const c = currentConv();
  const bubble = pushBubble('user', text);
  setState('thinking', 'Thinking'); pulse(true);
  router.config = { providers: D.config.providers };
  let followUp = byVoice;
  try {
    const linked = !!lapBase();
    const promptInfo = {
      names: D.config.names,
      platform: "Kelvin's Android phone" + (linked ? ', linked to his Windows laptop' : ''),
      actionsDoc: ACTIONS_DOC,
      context: linked ? 'For anything on the laptop, use the "laptop" action.' : 'The laptop is not linked right now.',
      lessons: D.memory.lessons, facts: D.memory.facts,
      recentNotes: [...D.laptopNotes.slice(-20), ...D.notes.slice(-10).map(n => `[phone ${n.at.slice(0, 10)}] ${n.text}`)],
    };
    const res = await SplashBrain.runTurn({
      router, history: c.messages.map(m => ({ role: m.role, content: m.content })), userText: text, execute, heard,
      systemPrompt: SplashBrain.buildSystemPrompt(promptInfo),
      compactPrompt: SplashBrain.buildSystemPrompt({ ...promptInfo, compact: true }),
    });
    if (res.ignored) {
      // Not meant for it: stay quiet and keep it out of the conversation.
      pulse(false);
      bubble.classList.add('ignored');
      $('#liveText').textContent = "Sounded like that wasn't for me, so I stayed quiet.";
      busy = false;
      setState('idle', handsFree ? 'Listening for your wake word' : 'Tap the core to talk');
      if (handsFree) setTimeout(listenLoop, 600);
      return;
    }
    if (res.listen === 'off' && handsFree) $('#handsFree').click();
    followUp = byVoice && !res.listen;
    const at = new Date().toISOString();
    c.messages.push({ role: 'user', content: text, at });
    c.messages.push({ role: 'assistant', content: res.say + (res.explain ? '\n\n' + res.explain : ''), say: res.say, explain: res.explain, visual: res.visual,
      at, provider: res.provider, steps: res.steps.map(s => ({ type: s.type, ok: s.ok })) });
    c.updated = at;
    if (c.title === 'New conversation') c.title = text.slice(0, 60);
    D.pending.convs.push(c.id);
    res.notes.forEach(addNote);
    res.lessons.forEach(l => addMemory('lessons', l));
    save();
    renderChat();
    $('#liveText').textContent = res.provider;
    pulse(false);
    if (D.config.speak) {
      setState('speaking', 'Speaking'); pulse(true);
      await speak(res.say);
      pulse(false);
    }
    sync();
  } catch (e) {
    pulse(false);
    setState('error', 'Something went wrong');
    $('#liveText').textContent = e.message;
    followUp = false;
  }
  busy = false;
  // If you were talking, listen once more for a follow-up, no wake word needed.
  if (followUp) {
    setState('listening', 'Any follow-up? Just talk'); pulse(true);
    let t = '';
    try { t = await hear(); } catch {}
    pulse(false);
    if (t && t.trim()) {
      $('#liveText').textContent = t;
      const rest = afterWake(t);
      return handle(rest !== null && rest ? rest : t, rest !== null ? 'wake' : 'open');
    }
  }
  setState('idle', handsFree ? 'Listening for your wake word' : 'Tap the core to talk');
  if (handsFree) setTimeout(listenLoop, 600);
}

// ---------- voice ----------
let handsFree = false;
function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\b(a i|eye|ai)\b/g, 'ai').replace(/\s+/g, ' ').trim(); }
function afterWake(text) {
  const t = ' ' + norm(text) + ' ';
  for (const w of D.config.wakeWords) { const i = t.indexOf(' ' + norm(w) + ' '); if (i !== -1) return t.slice(i + norm(w).length + 2).trim(); }
  return null;
}
async function hear() {
  if (!Speech) throw new Error('Speech recognition is not available on this phone.');
  const perm = await Speech.checkPermissions();
  if (perm.speechRecognition !== 'granted') await Speech.requestPermissions();
  const r = await Speech.start({ language: 'en-US', maxResults: 1, partialResults: false, popup: false });
  return (r && r.matches && r.matches[0]) || '';
}
async function talkOnce() {
  if (busy) return;
  stopSpeaking();
  setState('listening', 'Listening'); pulse(true);
  try { const t = await hear(); pulse(false); if (t) { $('#liveText').textContent = t; await handle(t, 'wake'); } else setState('idle', 'Didn\'t catch that. Tap to try again'); }
  catch (e) { pulse(false); setState('idle', 'Didn\'t catch that. Tap to try again'); }
}
async function listenLoop() {
  if (!handsFree || busy) return;
  setState('idle', 'Listening for your wake word');
  let t = '';
  try { t = await hear(); } catch {}
  if (!handsFree) return;
  const rest = t ? afterWake(t) : null;
  if (rest === null) return setTimeout(listenLoop, 250);
  if (rest) return handle(rest, 'wake');
  setState('listening', 'Yes?'); pulse(true);
  try { t = await hear(); } catch { t = ''; }
  pulse(false);
  if (t) return handle(t, 'wake');
  setTimeout(listenLoop, 250);
}
$('#core').onclick = () => talkOnce();
$('#handsFree').onclick = () => {
  handsFree = !handsFree;
  $('#handsFree').setAttribute('aria-pressed', handsFree);
  if (handsFree) listenLoop(); else { try { Speech.stop(); } catch {} setState('idle', 'Tap the core to talk'); }
};
$('#askForm').onsubmit = e => { e.preventDefault(); const v = $('#askInput').value; $('#askInput').value = ''; handle(v); };

// ---------- rendering ----------
function pushBubble(role, text) {
  const box = $('#messages'); if (box.querySelector('.empty')) box.innerHTML = '';
  const d = document.createElement('div'); d.className = 'msg ' + role; d.textContent = text; box.appendChild(d); box.scrollTop = box.scrollHeight;
}
function renderChat() {
  const c = currentConv(), box = $('#messages');
  if (!c.messages.length) { box.innerHTML = '<p class="empty">Tap the core and talk, or type below. Try “on my laptop, make a folder called Receipts on the desktop”.</p>'; return; }
  box.innerHTML = c.messages.map(m => {
    const steps = (m.steps || []).map(s => (s.ok ? '✓ ' : '✗ ') + esc(s.type)).join('<br>');
    const main = m.say !== undefined ? m.say : m.content;
    const extras = m.role === 'assistant' ? SplashVisual.answerExtras(m) : '';
    return `<div class="msg ${m.role}${extras ? ' rich' : ''}">${esc(main)}${extras}${steps ? `<div class="steps">${steps}</div>` : ''}${m.provider ? `<span class="meta">${esc(m.provider)}</span>` : ''}</div>`;
  }).join('');
  box.scrollTop = box.scrollHeight;
}
function renderHistory() {
  const list = Object.values(D.conversations).filter(c => c.messages.length).sort((a, b) => b.updated.localeCompare(a.updated));
  const ul = $('#historyList');
  if (!list.length) { ul.innerHTML = '<p class="empty">Your conversations will show up here.</p>'; return; }
  ul.innerHTML = list.map(c => `<li><div class="grow" data-open="${c.id}">${esc(c.title)}<small>${when(c.updated)}, ${c.messages.length} messages${c.source === 'phone' ? '' : ', from laptop'}</small></div><button class="x" data-del="${c.id}" aria-label="Delete">✕</button></li>`).join('');
  ul.querySelectorAll('[data-open]').forEach(el => el.onclick = () => { D.currentId = el.dataset.open; save(); renderChat(); document.querySelector('[data-view=talk]').click(); });
  ul.querySelectorAll('[data-del]').forEach(el => el.onclick = () => { if (!confirm('Delete this conversation on the phone?')) return; delete D.conversations[el.dataset.del]; if (D.currentId === el.dataset.del) D.currentId = null; save(); renderHistory(); renderChat(); });
}
$('#newConv').onclick = () => { D.currentId = null; currentConv(); save(); renderChat(); document.querySelector('[data-view=talk]').click(); };
function renderNotes() {
  const byDay = {};
  D.notes.forEach(n => { const d = n.at.slice(0, 10); (byDay[d] = byDay[d] || []).push(`${n.at.slice(11, 16)} ${n.text}`); });
  D.laptopNotes.forEach(l => { const m = l.match(/^\[(\d{4}-\d{2}-\d{2})\] (.*)$/); if (m) (byDay[m[1]] = byDay[m[1]] || []).push(m[2] + ' (laptop)'); });
  const days = Object.keys(byDay).sort().reverse();
  $('#notesList').innerHTML = days.length ? days.map(d => `<div class="note"><strong>${d}</strong> <button class="x" data-day="${d}" aria-label="Delete">✕</button><pre>${esc(byDay[d].map(x => '- ' + x).join('\n'))}</pre></div>`).join('')
    : '<p class="empty">Notes from your conversations land here.</p>';
  document.querySelectorAll('[data-day]').forEach(b => b.onclick = () => {
    if (!confirm('Delete phone notes for ' + b.dataset.day + '?')) return;
    D.notes = D.notes.filter(n => !n.at.startsWith(b.dataset.day)); D.laptopNotes = D.laptopNotes.filter(l => !l.startsWith('[' + b.dataset.day)); save(); renderNotes();
  });
}
function renderMemory() {
  const item = (k, x) => `<li><div class="grow">${esc(x.text)}<small>${when(x.at)}</small></div><button class="x" data-k="${k}" data-id="${x.id}" aria-label="Delete">✕</button></li>`;
  $('#lessonList').innerHTML = D.memory.lessons.map(x => item('lessons', x)).join('') || '<p class="empty">Correct it and the lesson lands here.</p>';
  $('#factList').innerHTML = D.memory.facts.map(x => item('facts', x)).join('') || '<p class="empty">Say “remember that…”.</p>';
  document.querySelectorAll('#view-memory .x').forEach(b => b.onclick = () => { D.memory[b.dataset.k] = D.memory[b.dataset.k].filter(x => x.id !== b.dataset.id); save(); renderMemory(); });
}
document.querySelectorAll('#view-memory form').forEach(f => f.onsubmit = e => { e.preventDefault(); const i = f.querySelector('input'); addMemory(f.dataset.kind, i.value); i.value = ''; renderMemory(); });

// ---------- settings ----------
let draft = null;
function renderSettings() {
  $('#lapAddr').value = draft.laptop.address; $('#lapToken').value = draft.laptop.token;
  $('#namesInput').value = draft.names.join(', ');
  $('#optSpeak').checked = draft.speak;
  $('#wakeChips').innerHTML = draft.wakeWords.map((w, i) => `<span class="chip">${esc(w)}<button class="x" data-i="${i}" aria-label="Remove">✕</button></span>`).join('');
  $('#wakeChips').querySelectorAll('.x').forEach(b => b.onclick = () => { if (draft.wakeWords.length > 1) { draft.wakeWords.splice(+b.dataset.i, 1); renderSettings(); } });
  const st = router.status();
  $('#providerList').innerHTML = draft.providers.map((p, i) => {
    const s = st.find(x => x.id === p.id) || {};
    const warn = s.restingFor > 0;
    return `<div class="prov"><div class="top2"><input type="checkbox" data-en="${i}" ${p.enabled ? 'checked' : ''}><strong>${esc(p.name)}</strong>
      <button class="order" data-up="${i}">↑</button><button class="order" data-down="${i}">↓</button></div>
      ${p.noKey ? '' : `<input type="password" data-key="${i}" value="${esc(p.key)}" placeholder="Paste API key">`}
      <input data-model="${i}" value="${esc(p.model)}">
      <div class="status ${warn ? 'warn' : ''}">${warn ? `Resting ${Math.ceil(s.restingFor / 60)} min` : (p.key || p.noKey) ? 'Ready' : 'Off until you add a key'} <a data-link="${esc(p.keyUrl)}">Get a key</a></div></div>`;
  }).join('');
  const pl = $('#providerList');
  pl.querySelectorAll('[data-en]').forEach(el => el.onchange = () => (draft.providers[+el.dataset.en].enabled = el.checked));
  pl.querySelectorAll('[data-key]').forEach(el => el.oninput = () => (draft.providers[+el.dataset.key].key = el.value.trim()));
  pl.querySelectorAll('[data-model]').forEach(el => el.oninput = () => (draft.providers[+el.dataset.model].model = el.value.trim()));
  pl.querySelectorAll('[data-link]').forEach(el => el.onclick = () => openUrl(el.dataset.link));
  const mv = (i, d) => { const j = i + d, a = draft.providers; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; renderSettings(); };
  pl.querySelectorAll('[data-up]').forEach(el => el.onclick = () => mv(+el.dataset.up, -1));
  pl.querySelectorAll('[data-down]').forEach(el => el.onclick = () => mv(+el.dataset.down, 1));
}
function readDraft() {
  draft.laptop = { address: $('#lapAddr').value.trim(), token: $('#lapToken').value.trim() };
  draft.names = $('#namesInput').value.split(',').map(s => s.trim()).filter(Boolean);
  draft.speak = $('#optSpeak').checked;
}
$('#wakeForm').onsubmit = e => { e.preventDefault(); const v = $('#wakeForm input').value.trim().toLowerCase(); if (v && !draft.wakeWords.includes(v)) draft.wakeWords.push(v); $('#wakeForm input').value = ''; renderSettings(); };
$('#saveSettings').onclick = () => { readDraft(); D.config = JSON.parse(JSON.stringify(draft)); router.config = { providers: D.config.providers }; save(); toast('Settings saved'); checkLink(); };
$('#testLink').onclick = async () => { readDraft(); D.config.laptop = draft.laptop; save(); toast((await checkLink()) ? 'Laptop linked' : 'Could not reach the laptop. Check the address, code and Wi-Fi.', 5000); };
$('#syncNow').onclick = async () => { readDraft(); D.config.laptop = draft.laptop; save(); await sync(false); };
async function copyFromLaptop() {
  const j = await lap('/api/sync');
  const host = lapBase().replace(/:\d+$/, '');
  draft.providers = SplashRouter.mergeProviderConfig(j.providers.map(p => p.id === 'ollama' ? { ...p, base: host + ':11434/v1' } : p));
  draft.wakeWords = j.wakeWords || draft.wakeWords; draft.names = j.names || draft.names;
}
$('#importKeys').onclick = async () => {
  readDraft(); D.config.laptop = draft.laptop; save();
  try { await copyFromLaptop(); renderSettings(); toast('Keys copied. Tap Save settings.'); }
  catch (e) { toast('Could not copy keys: ' + e.message, 5000); }
};

// ---------- easy pairing: scan the laptop's QR code, or type its address + 6-digit PIN ----------
const Scanner = plugin('BarcodeScanner');
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('timeout')), ms))]);
function normAddr(a) {
  a = String(a || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  return /:\d+$/.test(a) ? a : a + ':7777';
}
// Tries each address the laptop gave until one answers, then swaps the PIN for the real pairing code.
async function pairWith(addresses, pin) {
  pin = String(pin || '').replace(/\D/g, '');
  if (pin.length !== 6) throw new Error('The PIN is 6 numbers.');
  for (const addr of addresses.map(normAddr)) {
    let r;
    try {
      r = await withTimeout(fetch('http://' + addr + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) }), 6000);
    } catch { continue; } // can't reach this address, try the next
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'The laptop said no (' + r.status + ').');
    readDraft();
    draft.laptop = { address: addr, token: j.token };
    D.config.laptop = draft.laptop;
    // First time? Bring the model keys over too, so the phone can think straight away.
    if (!D.config.providers.some(p => p.key)) { try { await copyFromLaptop(); } catch {} }
    D.config = JSON.parse(JSON.stringify(draft)); router.config = { providers: D.config.providers };
    save(); renderSettings();
    await checkLink(); sync();
    return j.computer || 'your laptop';
  }
  throw new Error("Couldn't reach the laptop. Make sure Splash AI is open on it and both are on the same Wi-Fi.");
}
async function doPair(addresses, pin) {
  toast('Linking…', 8000);
  try { toast('Linked to ' + await pairWith(addresses, pin) + '. You can now say "on my laptop…"', 6000); $('#pinPair').open = false; }
  catch (e) { toast(e.message, 7000); }
}
$('#scanQr').onclick = async () => {
  if (!Scanner) return toast('QR scanning works in the installed phone app. Use "Pair with PIN" instead.', 5000);
  try {
    // Uses Google's built-in scanner screen; it is downloaded once the first time.
    const { available } = await Scanner.isGoogleBarcodeScannerModuleAvailable();
    if (!available) {
      await Scanner.installGoogleBarcodeScannerModule().catch(() => {});
      return toast('Getting the scanner ready (one time only). Tap Scan QR code again in a few seconds.', 6000);
    }
    const { barcodes } = await Scanner.scan({ formats: ['QR_CODE'] });
    const raw = barcodes && barcodes[0] && barcodes[0].rawValue;
    if (!raw) return;
    let link;
    try { link = new URL(raw); } catch { link = null; }
    if (!link || link.protocol !== 'splashai:') return toast("That isn't the Splash AI code. Scan the one in the laptop's Settings, Phone link.", 6000);
    await doPair((link.searchParams.get('a') || '').split(',').filter(Boolean), link.searchParams.get('p'));
  } catch (e) {
    if (!/cancel/i.test(String(e && e.message))) toast('Could not scan: ' + (e.message || e), 5000);
  }
};
$('#pinGo').onclick = () => {
  const addr = $('#pinAddr').value.trim();
  if (!addr) return toast('Type the address shown on the laptop, e.g. 192.168.1.20', 5000);
  doPair([addr], $('#pinCode').value);
};
$('#wipeAll').onclick = () => { if (!confirm('Delete all conversations and notes on this phone? Memory and settings stay.')) return; D.conversations = {}; D.notes = []; D.laptopNotes = []; D.currentId = null; save(); renderChat(); toast('Phone history deleted'); };

// ---------- start ----------
renderChat();
checkLink().then(ok => ok && sync());
if (!D.config.providers.some(p => p.key)) toast('Link your laptop: go to Settings and tap “Scan QR code”.', 7000);
