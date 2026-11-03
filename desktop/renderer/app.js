const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const api = window.splash;
let S = null;          // state from main process
let draft = null;      // settings being edited
const core = new SplashCore($('#core'));
let voice = null;
let busy = false;
let naturalVoices = [];

// ---------- small helpers ----------
function toast(msg, ms = 3500) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms);
}
function setState(state, label) { core.setState(state); if (label) $('#stateLabel').textContent = label; }
const when = iso => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
function idleLabel() {
  const w = S && S.config.wakeWords[0];
  if (!voice || voice.mode === 'off') return 'Type a command below';
  if (listening === 'off') return 'Mic is off. Click the mic when you need me';
  if (listening === 'sleep') return `Resting. Say “${w}” when you need me`;
  return `Say “${w}”`;
}

// ---------- tabs ----------
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.id === 'tab-' + b.dataset.tab));
  if (b.dataset.tab === 'notes') renderNotes();
  if (b.dataset.tab === 'settings') { draft = JSON.parse(JSON.stringify(S.config)); renderSettings(); refreshStatus(); renderPairing(); }
});

// ---------- side panel: hide/show and drag to resize ----------
// Remembered per computer; the core canvas only listens to window resizes, so nudge it.
const shell = $('.shell');
const PANEL_MIN = 300, PANEL_DEFAULT = 400;
const remember = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const recall = k => { try { return localStorage.getItem(k); } catch { return null; } };
const redrawCore = () => window.dispatchEvent(new Event('resize'));
function panelMax() { return Math.max(PANEL_MIN, Math.round(window.innerWidth * 0.7)); }
function setPanelWidth(w, save = true) {
  if (!w) { shell.style.removeProperty('--panel-w'); shell.classList.remove('custom-w'); if (save) remember('panelWidth', ''); redrawCore(); return; }
  w = Math.min(panelMax(), Math.max(PANEL_MIN, Math.round(w)));
  shell.style.setProperty('--panel-w', w + 'px'); shell.classList.add('custom-w');
  if (save) remember('panelWidth', String(w));
  redrawCore();
}
function setPanelHidden(hidden) {
  shell.classList.toggle('panel-hidden', hidden);
  const b = $('#panelToggle');
  const label = hidden ? 'Show the side panel (Ctrl+B)' : 'Hide the side panel (Ctrl+B)';
  b.title = label; b.setAttribute('aria-label', label); b.setAttribute('aria-expanded', String(!hidden));
  $('#panelToggleFill').style.opacity = hidden ? 0 : 1;
  remember('panelHidden', hidden ? '1' : '');
  redrawCore();
}
$('#panelToggle').onclick = () => setPanelHidden(!shell.classList.contains('panel-hidden'));
document.addEventListener('keydown', e => {
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') { e.preventDefault(); $('#panelToggle').click(); }
});
$('#panelGrip').addEventListener('pointerdown', e => {
  e.preventDefault();
  const grip = e.currentTarget; grip.setPointerCapture(e.pointerId);
  shell.classList.add('resizing');
  const move = ev => setPanelWidth(window.innerWidth - ev.clientX, false);
  const up = () => {
    grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up);
    shell.classList.remove('resizing');
    if (shell.classList.contains('custom-w')) remember('panelWidth', String(parseInt(shell.style.getPropertyValue('--panel-w'))));
  };
  grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up);
});
$('#panelGrip').ondblclick = () => setPanelWidth(0);
window.addEventListener('resize', e => {
  // keep a saved width within the window when it shrinks (ignore our own nudges)
  if (e.isTrusted && shell.classList.contains('custom-w')) {
    const w = parseInt(shell.style.getPropertyValue('--panel-w'));
    if (w > panelMax()) setPanelWidth(panelMax(), false);
  }
});
if (Number(recall('panelWidth'))) setPanelWidth(Number(recall('panelWidth')), false);
if (recall('panelHidden') === '1') setPanelHidden(true);

// ---------- chat ----------
function renderChat() {
  $('#convTitle').textContent = S.conv.title;
  const box = $('#messages');
  if (!S.conv.messages.length) {
    box.innerHTML = `<p class="empty">Ask anything, or tell it what to do. Try “create a folder called Invoices on my desktop”.</p>`;
    return;
  }
  box.innerHTML = S.conv.messages.map(m => {
    const steps = (m.steps || []).map(s => `<div class="${s.ok ? '' : 'fail'}">${esc(s.type)}${s.ok ? '' : ': ' + esc(String(s.result).slice(0, 120))}</div>`).join('');
    const meta = m.role === 'assistant' && m.provider ? `<span class="meta">${esc(m.provider)}</span>` : '';
    // newer answers keep the spoken line, explanation and picture separately
    const main = m.say !== undefined ? m.say : m.content;
    const extras = m.role === 'assistant' ? SplashVisual.answerExtras(m) : '';
    return `<div class="msg ${m.role}${extras ? ' rich' : ''}">${esc(main)}${extras}${steps ? `<div class="steps">${steps}</div>` : ''}${meta}</div>`;
  }).join('');
  box.scrollTop = box.scrollHeight;
}
function pushBubble(role, text) {
  const box = $('#messages');
  if (box.querySelector('.empty')) box.innerHTML = '';
  const d = document.createElement('div');
  d.className = 'msg ' + role; d.textContent = text;
  box.appendChild(d); box.scrollTop = box.scrollHeight;
  return d;
}

// Things you say (or type) while it's still working wait here and get answered next.
const queue = [];
const FOLLOW_UP_MS = 8000;      // after it asks you something
const SHORT_FOLLOW_UP_MS = 5000; // after a plain answer
// 'awake': normal. 'sleep': only the wake word wakes it (no open mic, no follow-ups).
// 'off': the mic is off completely until you click the mic or press the shortcut.
let listening = 'awake';

function setListening(mode) {
  listening = mode;
  const b = $('#listenBtn'), off = mode === 'off';
  b.classList.toggle('off', off);
  b.setAttribute('aria-pressed', String(off));
  b.title = off ? 'Start listening again' : 'Stop listening to me';
  b.setAttribute('aria-label', b.title);
  $('#listenBtnText').textContent = off ? 'Not listening' : 'Stop listening';
  if (!voice) return;
  if (mode === 'off') voice.setMicOff(true);
  else { voice.setMicOff(false); voice.setOpenMic(false); voice.mute(false); }
}
async function sayShort(text) {
  $('#liveText').textContent = text;
  if (S.config.speak) { setState('speaking', 'Speaking'); await SplashSpeaker.speak(text, S.config.voice, v => core.setLevel(v)); }
}
const STOP_RE = /^(stop|cancel|wait|hold on|no stop|never ?mind|forget it|forget that|don'?t do (it|that))[.!]*$/i;

// heard: 'typed', 'wake' (wake word or talk button) or 'open' (open mic, no wake word)
async function handleCommand(text, heard = 'typed') {
  text = String(text || '').trim();
  if (!text) { if (!busy) { voice && voice.mute(false); setState('idle', idleLabel()); } return; }

  // "stop listening", "leave me alone", "turn off the mic"... handled instantly, no model needed
  const lc = SplashBrain.listenCommand(text);
  if (lc) {
    queue.length = 0; SplashSpeaker.stop();
    if (busy) { setListening(lc); return; }
    busy = true;
    setListening('awake'); voice && voice.mute(true); // don't hear our own reply
    await sayShort(lc === 'off' ? "Alright, mic off. Click the mic when you need me." : "No wahala, I'll leave you to it. Call me when you need me.");
    busy = false;
    setListening(lc); setState('idle', idleLabel());
    return;
  }
  if (STOP_RE.test(text)) { queue.length = 0; SplashSpeaker.stop(); if (!busy) { voice && voice.mute(false); setState('idle', idleLabel()); } return; }
  if (/^(start a )?new (conversation|chat)\.?$/i.test(text)) { S = await api.newConversation(); renderChat(); setState('idle', 'New conversation started'); voice && voice.mute(false); return; }
  if (heard !== 'open' && listening !== 'awake') setListening('awake'); // talking to it directly wakes it up
  if (busy) {
    queue.push({ text, heard });
    pushBubble('user', text);
    if (heard !== 'open') toast("Got it. I'll answer that right after this one.");
    return;
  }
  busy = true;
  const bubble = pushBubble('user', text);
  $('#liveText').textContent = text;
  setState('thinking', listening === 'awake' ? 'Thinking (still listening)' : 'Thinking');
  // Keep the mic open while it thinks, so you can keep talking.
  if (voice && listening === 'awake') { voice.mute(false); voice.setOpenMic(true); }
  const res = await api.ask(text, heard);
  if (voice) voice.setOpenMic(false);
  S = await api.getState();
  renderChat(); renderHistory(); renderMemory();
  let followUp = 0;
  if (!res.ok) {
    setState('error', 'Something went wrong');
    $('#liveText').textContent = res.error;
  } else if (res.ignored) {
    // It decided you weren't talking to it: stay quiet, show it faintly so you know.
    $('#liveText').textContent = 'Sounded like that wasn\'t for me, so I stayed quiet.';
    bubble.classList.add('ignored'); bubble.title = 'Not meant for Splash AI, so it stayed quiet'; $('#messages').appendChild(bubble);
  } else {
    $('#modelBadge').textContent = res.provider + ' is answering';
    $('#liveText').textContent = res.say;
    if (res.listen) setListening(res.listen);
    if (S.config.speak && res.say) {
      setState('speaking', 'Speaking (say the wake word to interrupt)');
      if (listening === 'off' && voice) voice.mute(true);
      await SplashSpeaker.speak(res.say, S.config.voice, v => core.setLevel(v));
    }
    if (heard !== 'typed') followUp = res.expectReply ? FOLLOW_UP_MS : SHORT_FOLLOW_UP_MS;
  }
  busy = false;
  if (queue.length) {
    const items = queue.splice(0);
    return handleCommand(items.map(i => i.text).join('. '), items.some(i => i.heard !== 'open') ? 'wake' : 'open');
  }
  if (!res.ok) return setTimeout(() => { if (!busy) setState('idle', idleLabel()); }, 4000);
  if (followUp && listening === 'awake') return listenForFollowUp(followUp);
  if (voice && listening !== 'off') voice.mute(false);
  setState('idle', idleLabel());
}

// After it answers, listen for a few seconds without needing the wake word.
function listenForFollowUp(ms = FOLLOW_UP_MS) {
  if (!voice || voice.mode === 'off') return setState('idle', idleLabel());
  setTimeout(() => {
    if (busy || voice.mode === 'command' || listening !== 'awake') return;
    voice.mute(false);
    voice.setOpenMic(true, ms);
    setState('listening', 'Any follow-up? Just talk');
  }, 350);
}

$('#askForm').onsubmit = e => { e.preventDefault(); const v = $('#askInput').value; $('#askInput').value = ''; handleCommand(v); };
$('#micBtn').onclick = () => startTalking();
// One click: stop hearing me completely (not even the wake word). Click again to listen again.
$('#listenBtn').onclick = () => {
  if (listening === 'off') {
    setListening('awake');
    if (!busy) setState('idle', idleLabel());
    toast("I'm listening again.");
  } else {
    queue.length = 0;
    SplashSpeaker.stop();
    setListening('off');
    $('#micBtn').classList.remove('live');
    if (!busy) setState('idle', idleLabel());
    toast("Okay, I've stopped listening. Click the button again, or the mic, when you need me.");
  }
};
$('#core').onclick = () => startTalking();
$('#newConv').onclick = async () => { S = await api.newConversation(); renderChat(); };
function startTalking() {
  SplashSpeaker.stop();
  if (listening !== 'awake') setListening('awake');
  if (voice && voice.mode !== 'off') voice.pushToTalk();
  else $('#askInput').focus();
}

// ---------- history ----------
function renderHistory() {
  const ul = $('#historyList');
  if (!S.conversations.length) { ul.innerHTML = '<p class="empty">Your conversations will show up here.</p>'; return; }
  ul.innerHTML = S.conversations.map(c => `
    <li><div class="grow click" data-open="${c.id}">${esc(c.title)}<small>${when(c.updated)}, ${c.count} messages${c.source === 'phone' ? ', from phone' : ''}</small></div>
    <button class="x" data-del="${c.id}" aria-label="Delete conversation">✕</button></li>`).join('');
  ul.querySelectorAll('[data-open]').forEach(el => el.onclick = async () => {
    S = await api.openConversation(el.dataset.open); renderChat();
    document.querySelector('[data-tab=chat]').click();
  });
  ul.querySelectorAll('[data-del]').forEach(el => el.onclick = async () => {
    if (!confirm('Delete this conversation for good?')) return;
    S = await api.deleteConversation(el.dataset.del); renderHistory(); renderChat();
  });
}
$('#clearHistory').onclick = async () => {
  if (!confirm('Delete every conversation? Notes and memory stay.')) return;
  S = await api.deleteAllHistory(); renderHistory(); renderChat();
};

// ---------- notes ----------
async function renderNotes() {
  const notes = await api.listNotes();
  const box = $('#notesList');
  if (!notes.length) { box.innerHTML = '<p class="empty">Splash AI writes notes here as you talk: plans, decisions, things to do.</p>'; return; }
  box.innerHTML = notes.map(n => `
    <div class="note"><header><strong>${esc(n.date)}</strong><button class="x" data-date="${n.date}" aria-label="Delete notes for this day">✕</button></header>
    <pre>${esc(n.content.replace(/^# .*\n+/, ''))}</pre></div>`).join('');
  box.querySelectorAll('[data-date]').forEach(b => b.onclick = async () => {
    if (!confirm('Delete the notes for ' + b.dataset.date + '?')) return;
    await api.deleteNotes(b.dataset.date); renderNotes();
  });
}
$('#openFolder').onclick = () => api.openDataFolder();

// ---------- memory ----------
function renderMemory() {
  const item = (kind, x) => `<li><div class="grow">${esc(x.text)}<small>${when(x.at)}${x.source === 'phone' ? ', from phone' : ''}</small></div><button class="x" data-kind="${kind}" data-id="${x.id}" aria-label="Delete">✕</button></li>`;
  $('#lessonList').innerHTML = S.memory.lessons.map(x => item('lessons', x)).join('') || '<p class="empty">No lessons yet. Correct it and it learns.</p>';
  $('#factList').innerHTML = S.memory.facts.map(x => item('facts', x)).join('') || '<p class="empty">Say “remember that…” and it will.</p>';
  document.querySelectorAll('#tab-memory .x').forEach(b => b.onclick = async () => {
    S = await api.deleteMemory({ kind: b.dataset.kind, id: b.dataset.id }); renderMemory();
  });
}
document.querySelectorAll('#tab-memory form').forEach(f => f.onsubmit = async e => {
  e.preventDefault();
  const inp = f.querySelector('input'); if (!inp.value.trim()) return;
  S = await api.addMemory({ kind: f.dataset.kind, text: inp.value }); inp.value = ''; renderMemory();
});

// ---------- settings ----------
function renderSettings() {
  $('#wakeChips').innerHTML = draft.wakeWords.map((w, i) => `<span class="chip">${esc(w)}<button class="x" data-i="${i}" aria-label="Remove wake word">✕</button></span>`).join('');
  $('#wakeChips').querySelectorAll('.x').forEach(b => b.onclick = () => {
    if (draft.wakeWords.length === 1) return toast('Keep at least one wake word');
    draft.wakeWords.splice(+b.dataset.i, 1); renderSettings();
  });
  $('#namesInput').value = draft.names.join(', ');
  $('#optConfirm').checked = draft.confirmDangerous;
  $('#optSpeak').checked = draft.speak;
  $('#optWhisper').checked = draft.useWhisper;
  $('#optStartup').checked = draft.startWithWindows;
  $('#optRemote').checked = draft.remote.enabled;
  $('#hotkeyInput').value = draft.hotkey || '';
  const vs = SplashSpeaker.voices();
  const opt = (value, label) => `<option value="${esc(value)}" ${value === draft.voice ? 'selected' : ''}>${esc(label)}</option>`;
  $('#voiceSelect').innerHTML =
    '<optgroup label="Natural voices (need internet)">' + naturalVoices.map(v => opt('edge:' + v.id, v.label)).join('') + '</optgroup>' +
    '<optgroup label="Windows voices (offline)">' + opt('windows', 'Windows default') + vs.map(v => opt(v.name, v.name)).join('') + '</optgroup>';
  $('#phoneInfo').innerHTML = `Address: ${(S.lan.length ? S.lan : ['(not on a network)']).map(ip => `<code>${ip}:${draft.remote.port}</code>`).join(' or ')}<br>Pairing code: <code>${esc(draft.remote.token)}</code>`;
  renderProviders();
}
function renderProviders(status = []) {
  const box = $('#providerList');
  box.innerHTML = draft.providers.map((p, i) => {
    const st = status.find(s => s.id === p.id) || {};
    const resting = st.restingFor > 0;
    const statusText = !p.key && !p.noKey ? 'Off until you paste a key'
      : resting ? `Resting for ${Math.ceil(st.restingFor / 60)} min. ${esc(st.last.slice(0, 90))}`
      : st.last === 'ok' ? 'Working' : st.last ? 'Last error: ' + esc(st.last.slice(0, 90)) : 'Ready';
    return `<div class="prov ${resting ? 'resting' : ''}">
      <div class="top"><input type="checkbox" data-en="${i}" ${p.enabled ? 'checked' : ''} aria-label="Use ${esc(p.name)}">
        <strong>${esc(p.name)}</strong>
        <button class="order" data-up="${i}" aria-label="Move up">↑</button><button class="order" data-down="${i}" aria-label="Move down">↓</button></div>
      <div class="row2">
        ${p.noKey ? '<span class="hint">No key needed</span>' : `<input type="password" data-key="${i}" value="${esc(p.key)}" placeholder="Paste API key">`}
        <input data-model="${i}" value="${esc(p.model)}" aria-label="Model name">
      </div>
      <div class="status ${resting || (st.last && st.last !== 'ok') ? 'warn' : ''}">${statusText}
        ${resting ? ` <a data-wake="${p.id}">Try it now</a>` : ''} <a data-link="${esc(p.keyUrl)}">${p.noKey ? 'Download' : p.paid ? 'Get a key (paid)' : 'Get a free key'}</a></div>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-en]').forEach(el => el.onchange = () => (draft.providers[+el.dataset.en].enabled = el.checked));
  box.querySelectorAll('[data-key]').forEach(el => el.oninput = () => (draft.providers[+el.dataset.key].key = el.value.trim()));
  box.querySelectorAll('[data-model]').forEach(el => el.oninput = () => (draft.providers[+el.dataset.model].model = el.value.trim()));
  box.querySelectorAll('[data-link]').forEach(el => el.onclick = () => api.openExternal(el.dataset.link));
  box.querySelectorAll('[data-wake]').forEach(el => el.onclick = async () => renderProviders(await api.routerWake(el.dataset.wake)));
  const move = (i, d) => { const j = i + d; if (j < 0 || j >= draft.providers.length) return; const a = draft.providers; [a[i], a[j]] = [a[j], a[i]]; refreshStatus(); };
  box.querySelectorAll('[data-up]').forEach(el => el.onclick = () => move(+el.dataset.up, -1));
  box.querySelectorAll('[data-down]').forEach(el => el.onclick = () => move(+el.dataset.down, 1));
}
async function refreshStatus() { renderProviders(await api.routerStatus()); }

$('#wakeForm').onsubmit = e => {
  e.preventDefault();
  const v = $('#wakeForm input').value.trim().toLowerCase();
  if (v && !draft.wakeWords.includes(v)) draft.wakeWords.push(v);
  $('#wakeForm input').value = ''; renderSettings();
};
// ---------- easy phone pairing: QR code + 6-digit PIN ----------
let pairTimer = null;
async function renderPairing(fresh = false) {
  const p = await api.pairingInfo(fresh);
  $('#pairQr').src = p.qr;
  $('#pairPin').textContent = p.pin.slice(0, 3) + ' ' + p.pin.slice(3);
  $('#pairAddr').innerHTML = p.addresses.length ? 'Address: ' + p.addresses.map(a => `<code>${esc(a)}</code>`).join(' or ') : 'Not connected to a network';
  clearInterval(pairTimer);
  const tick = () => {
    const left = Math.max(0, Math.round((p.expires - Date.now()) / 1000));
    if (!left) { clearInterval(pairTimer); if ($('#tab-settings').classList.contains('on')) renderPairing(); return; }
    $('#pairExpires').textContent = (p.enabled ? '' : 'Phone control is off; tick "Allow my phone" below and save. ') + `Works for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} more`;
  };
  tick(); pairTimer = setInterval(tick, 1000);
}
$('#newPin').onclick = () => renderPairing(true);
api.on('paired', () => { if ($('#tab-settings').classList.contains('on')) renderPairing(); });

$('#regenToken').onclick = async () => {
  if (!confirm('Your phone will need the new code to reconnect. Continue?')) return;
  S = await api.regenToken(); draft.remote = { ...S.config.remote }; renderSettings();
};
$('#saveSettings').onclick = async () => {
  draft.names = $('#namesInput').value.split(',').map(s => s.trim()).filter(Boolean);
  draft.confirmDangerous = $('#optConfirm').checked;
  draft.speak = $('#optSpeak').checked;
  draft.useWhisper = $('#optWhisper').checked;
  draft.startWithWindows = $('#optStartup').checked;
  draft.remote.enabled = $('#optRemote').checked;
  draft.hotkey = $('#hotkeyInput').value.trim();
  draft.voice = $('#voiceSelect').value;
  S = await api.saveConfig(draft);
  draft = JSON.parse(JSON.stringify(S.config));
  toast('Settings saved');
  refreshStatus();
};

// ---------- confirmations ----------
api.on('confirm', ({ id, text }) => {
  $('#confirmText').textContent = text;
  $('#confirmBox').hidden = false;
  if (S.config.speak) SplashSpeaker.speak('Should I go ahead?', S.config.voice, v => core.setLevel(v));
  const done = ok => { $('#confirmBox').hidden = true; api.confirmReply({ id, ok }); };
  $('#confirmYes').onclick = () => done(true);
  $('#confirmNo').onclick = () => done(false);
  $('#confirmYes').focus();
});

// ---------- events from main ----------
api.on('step', s => { $('#liveText').textContent = (s.ok ? 'Done: ' : 'Failed: ') + s.type; });
api.on('trying', p => { $('#modelBadge').textContent = 'Asking ' + p.name; });
// Keep every model that failed during this request on screen, not just the last one.
let fails = [], failsAt = 0;
api.on('fallback', f => {
  if (Date.now() - failsAt > 20000) fails = [];
  failsAt = Date.now();
  fails.push(`Error with ${f.from}: ${f.why || 'failed'}`);
  toast(fails.join('\n') + '\n' + (f.next ? `Trying ${f.next}...` : 'No more checked models to try.'), 8000);
});
api.on('ptt', () => startTalking());
api.on('remote', r => toast('Phone: ' + r.text));
api.on('history-changed', async () => { S = await api.getState(); renderHistory(); renderMemory(); });
api.on('toast', t => toast(t, 6000));
api.on('model-progress', f => { $('#stateLabel').textContent = `Downloading the voice model, ${Math.round(f * 100)}%`; });

// ---------- start ----------
(async function boot() {
  S = await api.getState();
  naturalVoices = await api.naturalVoices();
  renderChat(); renderHistory(); renderMemory();
  const ready = S.router.filter(r => r.enabled && r.hasKey);
  $('#modelBadge').textContent = ready.length ? `${ready.length} models ready` : 'No models set up yet';
  if (!S.config.providers.some(p => p.key)) {
    toast('Add free API keys in Settings so Splash AI can think. Ollama works without one.', 8000);
  }
  speechSynthesis.onvoiceschanged = () => draft && renderSettings();

  voice = new SplashVoice({
    getWakeWords: () => S.config.wakeWords,
    onStatus: t => setState('idle', t),
    onHeard: t => { if (!busy) $('#liveText').textContent = 'Heard: ' + t; },
    onLevel: v => core.setLevel(v),
    onSpectrum: s => core.setSpectrum(s),
    onWake: () => { SplashSpeaker.stop(); $('#micBtn').classList.add('live'); setState('listening', busy ? "Listening (I'll add this)" : 'Listening'); },
    onCommand: (t, info = {}) => {
      $('#micBtn').classList.remove('live'); core.setSpectrum(null);
      if (busy && listening === 'awake') { voice.mute(false); voice.setOpenMic(true); setState('thinking', 'Thinking (still listening)'); }
      handleCommand(t, info.viaWake === false ? 'open' : 'wake');
    },
    onOpenMicEnd: () => { if (!busy) setState('idle', idleLabel()); },
  });
  try {
    await voice.init();
    setState('idle', idleLabel());
  } catch (e) {
    voice.mode = 'off';
    setState('error', 'Voice is off: ' + (e.message || e));
    setTimeout(() => setState('idle', idleLabel()), 6000);
  }
})();
