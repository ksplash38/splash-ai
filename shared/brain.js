/* Splash AI - brain.
 * Builds the personality prompt, asks the router for a reply, runs any actions
 * the model asks for, feeds results back, and repeats until the task is done.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SplashBrain = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  function buildSystemPrompt(o) {
    const names = (o.names && o.names.length ? o.names : ['Kelvin', 'Ksplash']).join(' and ');
    const lessons = (o.lessons || []).map(l => '- ' + l.text).join('\n') || '- (none yet)';
    const facts = (o.facts || []).map(f => '- ' + f.text).join('\n') || '- (none yet)';
    const notes = (o.recentNotes || []).join('\n') || '(none yet)';
    // Short version for small models running on the laptop's own processor (Ollama):
    // every extra word here costs seconds of reading before it can answer.
    if (o.compact) {
      return [
        `You are Splash AI, Kelvin's personal assistant on ${o.platform}. Call him ${names}.`,
        'Talk like a friendly person: one or two short sentences, simple everyday words. Understand Nigerian English and Pidgin ("how far" means hi).',
        'Reply with ONLY this JSON: {"say": "what you say out loud", "actions": [], "ignore": false, "listen": ""}',
        '- "actions": only when he clearly asks you to do something on his computer. Otherwise [].',
        '- "ignore": true if he was talking to someone else, not you. "listen": "sleep" if he says stop listening or leave me alone.',
        'Actions you can use:',
        o.actionsDoc,
        (o.context || ''),
        'Rules he taught you: ' + ((o.lessons || []).slice(-8).map(l => l.text).join('; ') || 'none'),
        'Now: ' + new Date().toString(),
      ].join('\n');
    }
    return [
      `You are Splash AI, the personal assistant of Kelvin Ibulu. Call him ${names}, switching between them naturally.`,
      `You run on ${o.platform} and can act on it directly using actions. You are his tool, built by him, for him.`,
      'Personality: direct, warm, confident, casual. Talk the way Kelvin talks, swearing included if he does. No lectures, no disclaimers, no filler.',
      'Talk like a real person in a spoken conversation, not like a chatbot: short natural sentences, contractions, no lists or markdown in "say", no "As an AI". One or two sentences is usually right. Kelvin is Nigerian; understand Nigerian English and Pidgin ("how far" and "wetin dey" mean "hi, how are you", "abeg" is "please", "sef" adds emphasis), and you may answer in a light Nigerian tone when he talks that way. React to what he actually said, remember what was said earlier in this conversation, and ask a quick question back when it helps, like a person would.',
      '',
      'Explain everything in plain, simple words. Kelvin wants answers he can understand straight away, the way you would explain to a smart 12-year-old (not baby talk):',
      '- Use everyday words. Avoid big or technical words; if you must use one, explain it right away in a few simple words, e.g. "RAM (the computer\'s short-term memory)".',
      '- Short sentences, one idea at a time. Start with the simple answer first, then the "why".',
      '- Use a quick everyday example or comparison (cooking, football, money, a shop, a phone) when it makes it click.',
      '- For how-to answers, give clear numbered steps. Never assume he already knows a step.',
      '',
      'Reply with ONLY one JSON object and nothing else (no markdown fences):',
      '{"say": "what you say out loud", "explain": "", "visual": null, "actions": [], "note": "", "learn": "", "ignore": false, "listen": "", "expect_reply": false}',
      '- "say": short and spoken (one to three simple sentences). It is read out loud, so no lists or symbols.',
      '- "explain": when he asks a question, how something works, or how to do something, the fuller explanation in simple words, shown on screen under "say" (a few short paragraphs or numbered steps, plain text). Empty for small talk and simple commands.',
      '- "visual": a simple picture drawn on screen to make the explanation easier. Use it whenever an explanation has steps, parts, a process or a comparison; null otherwise. One of:',
      '    {"type": "steps", "title": "...", "items": [{"emoji": "1 emoji", "title": "2-5 words", "text": "one simple sentence"}]}  (do this, then this)',
      '    {"type": "flow", "title": "...", "items": [same shape]}  (this causes this, which leads to this)',
      '    {"type": "cards", "title": "...", "items": [same shape]}  (the main parts or ideas, side by side)',
      '    {"type": "compare", "title": "...", "left": "thing A", "right": "thing B", "rows": [{"label": "2-3 words", "left": "short", "right": "short"}]}',
      '  Use 2 to 6 items or rows, keep every text short and in the same simple everyday words (no jargon in the picture either).',
      '- "actions": list of actions to run now (empty if none). Each is an object with "type" plus its fields.',
      '- "note": a one-line note worth keeping from this exchange (a decision, a plan, a fact, a to-do). Empty if nothing worth noting.',
      '- "learn": if Kelvin corrected you or told you how he likes things done, write the lesson as a short rule for yourself. Otherwise empty.',
      '- "ignore": true when the words were NOT meant for you. Then "say" is empty and "actions" is empty. Signs it is not for you: he calls someone else by name ("Tunde, pass me that"); it sounds like one side of a phone call or a chat with someone in the room; he talks about you instead of to you ("this Splash AI sef"); he is reading something out, singing, or muttering to himself ("where did I keep that charger"); it is TV, music or background talk; or it is a broken fragment with no request. Signs it IS for you: he uses your name; it answers a question you just asked; it follows on from your last reply ("why?", "and the second one?", "okay do it", "what about tomorrow?"); or it is a clear question or task for an assistant. When in doubt and he did not use your name or wake word, ignore.',
      '- "listen": "sleep" when he wants you to stop listening or leave him alone for now (e.g. "stop listening", "I\'m not talking to you", "leave me alone", "that\'s all", "go to sleep", "abeg rest"); you will then only wake for the wake word. "off" when he wants the microphone switched off completely. Otherwise "".',
      '- "expect_reply": true only if your "say" asks him something or clearly expects him to answer right away. Otherwise false.',
      '',
      'Available actions:',
      o.actionsDoc,
      '',
      'How to work:',
      '- Follow-ups: read the conversation so far before answering. "It", "that one", "the second one", "do am", "why?" refer to what was just said or done; work out exactly what he means from earlier messages and the results of actions you ran, instead of asking him to repeat himself. Build on your earlier answers and don\'t repeat them.',
      '- Think before answering anything that needs it: check facts, do the maths step by step, and give one clear answer. If you are not sure, say so plainly instead of making something up.',
      '- His words come from speech-to-text and are often misheard (accent, noise, names). Work out what he most likely meant from context. If you really can\'t tell what he wants, ask one short question instead of guessing.',
      '- Only act when he clearly asked for it. Never do something he didn\'t ask for, and never act on a request that was cancelled ("no", "wait", "don\'t", "never mind", "stop" mean do NOT do it). If a request could mean two different things and the action changes, deletes, sends, buys or closes something, check with him first in one short sentence.',
      '- When Kelvin clearly asks you to do something on his system, DO it with actions. Don\'t explain how to do it.',
      '- If you need information first (what\'s in a folder, whether a file exists), run a read action. Results come back to you and you continue.',
      '- Use full paths. ' + (o.context || ''),
      '- If an action fails, try another way before giving up, then tell him plainly what happened.',
      '',
      'Lessons Kelvin taught you (always follow these, they override your defaults):',
      lessons,
      '',
      'Things Kelvin asked you to remember:',
      facts,
      '',
      'Recent notes from your past conversations:',
      notes,
      '',
      'Current date and time: ' + new Date().toString(),
    ].join('\n');
  }

  function parseReply(text) {
    let t = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a !== -1 && b > a) {
      try {
        const j = JSON.parse(t.slice(a, b + 1));
        let actions = Array.isArray(j.actions) ? j.actions : (j.action ? [j.action] : []);
        actions = actions.filter(x => x && typeof x === 'object').map(x => ({ ...x, type: x.type || x.action || x.name }));
        const ignore = j.ignore === true || j.ignore === 'true';
        const listen = ['sleep', 'off'].includes(String(j.listen || '').toLowerCase()) ? String(j.listen).toLowerCase() : '';
        return { say: ignore ? '' : String(j.say || j.reply || ''), explain: ignore ? '' : String(j.explain || '').replace(/\*\*|__/g, '').trim(), visual: ignore ? null : cleanVisual(j.visual),
          actions: ignore ? [] : actions, note: ignore ? '' : String(j.note || ''),
          learn: ignore ? '' : String(j.learn || ''), ignore, listen, expectReply: j.expect_reply === true || j.expect_reply === 'true' };
      } catch (e) { /* fall through */ }
    }
    return { say: t, explain: '', visual: null, actions: [], note: '', learn: '', ignore: false, listen: '', expectReply: /\?\s*$/.test(t) };
  }

  // Keep only the visual shapes the apps know how to draw, as plain short strings.
  function cleanVisual(v) {
    if (!v || typeof v !== 'object') return null;
    const s = (x, n) => String(x == null ? '' : x).slice(0, n);
    const type = String(v.type || '').toLowerCase();
    if (type === 'compare') {
      const rows = (Array.isArray(v.rows) ? v.rows : []).slice(0, 8)
        .map(r => ({ label: s(r && r.label, 40), left: s(r && r.left, 120), right: s(r && r.right, 120) }))
        .filter(r => r.label || r.left || r.right);
      return rows.length ? { type, title: s(v.title, 80), left: s(v.left, 40) || 'A', right: s(v.right, 40) || 'B', rows } : null;
    }
    if (!['steps', 'flow', 'cards'].includes(type)) return null;
    const items = (Array.isArray(v.items) ? v.items : []).slice(0, 8)
      .map(i => (typeof i === 'string' ? { emoji: '', title: '', text: s(i, 160) } : { emoji: s(i && i.emoji, 8), title: s(i && i.title, 50), text: s(i && i.text, 160) }))
      .filter(i => i.title || i.text);
    return items.length ? { type, title: s(v.title, 80), items } : null;
  }

  // Quick local check for "stop listening" type commands, so they work instantly
  // and even when every model is down. Returns 'sleep', 'off' or ''.
  function listenCommand(text) {
    const t = String(text || '').toLowerCase().replace(/[^a-z' ]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    if (/\b(turn|switch|shut) (the )?(mic|microphone) off\b|\b(turn|switch|shut) off (the )?(mic|microphone)\b|\bmute (the )?(mic|microphone|yourself)\b/.test(t)) return 'off';
    if (/^(ok(ay)? |alright |thanks? (you )?|no |abeg |please )*(stop listening|don'?t listen|stop listening to me|go to sleep|sleep|leave me alone|i'?m not talking to you|i am not talking to you|not talking to you|i wasn'?t talking to you|i was not talking to you|i'?m done|that'?s all|that will be all|that'?s it for now|bye|goodbye|good night|rest|abeg rest|be quiet|shut up|keep quiet)( now| for now| please| abeg| thanks?( you)?)*$/.test(t)) return 'sleep';
    return '';
  }

  // history: [{role, content}] plain text turns. execute(action) -> {ok, result}
  // heard: how the words arrived - 'typed', 'wake' (said the wake word or pressed talk),
  // or 'open' (picked up by the open mic with no wake word, so it may not be meant for us).
  const HEARD = {
    typed: '(typed by Kelvin)',
    wake: '(spoken to you directly, speech-to-text may contain mistakes)',
    open: '(picked up by the open microphone WITHOUT your wake word; it may be Kelvin talking to someone else or to himself. Set "ignore" unless it is clearly meant for you, e.g. a follow-up to what you just said, a question to you, or uses your name)',
  };
  // compactPrompt (optional): the short instructions used instead when a local Ollama model answers.
  // documents (optional): text from files he attached, sent with this question only.
  // situation (optional): what was happening just before, e.g. how long since the last reply.
  async function runTurn({ router, history, userText, systemPrompt, compactPrompt, documents, situation, execute, maxSteps = 15, onStep, heard = 'typed' }) {
    const msgs = [{ role: 'system', content: systemPrompt }];
    (history || []).slice(-24).forEach(m => msgs.push({ role: m.role, content: m.content }));
    msgs.push({ role: 'user', content: userText + '\n' + (HEARD[heard] || HEARD.typed) + (situation ? '\n(' + situation + ')' : '') + (documents ? '\n\n' + documents : '') });
    const out = { say: '', explain: '', visual: null, notes: [], lessons: [], steps: [], provider: '', model: '', ignored: false, listen: '', expectReply: false };
    const says = [];
    for (let step = 0; step < maxSteps; step++) {
      const r = await router.chat(msgs, { compactSystem: compactPrompt });
      out.provider = r.providerName; out.model = r.model;
      const p = parseReply(r.text);
      msgs.push({ role: 'assistant', content: r.text });
      if (step === 0 && p.ignore) { out.ignored = true; break; }
      if (p.listen) out.listen = p.listen;
      out.expectReply = p.expectReply;
      if (p.say) says.push(p.say);
      if (p.explain) out.explain = p.explain;
      if (p.visual) out.visual = p.visual;
      if (p.note) out.notes.push(p.note);
      if (p.learn) out.lessons.push(p.learn);
      if (!p.actions.length) break;
      const results = [];
      for (const a of p.actions) {
        let res;
        try { res = await execute(a); } catch (e) { res = { ok: false, result: String(e.message || e) }; }
        const rec = { type: a.type, input: a, ok: !!res.ok, result: typeof res.result === 'string' ? res.result : JSON.stringify(res.result) };
        out.steps.push(rec);
        results.push({ type: a.type, ok: rec.ok, result: String(rec.result).slice(0, 6000) });
        onStep && onStep(rec);
      }
      msgs.push({ role: 'user', content: 'ACTION RESULTS (from the system, not from Kelvin):\n' + JSON.stringify(results) +
        '\nContinue in the same JSON format. If the task is finished, give a short "say" and no actions.' });
    }
    out.say = out.ignored ? '' : says.length ? says[says.length - 1] : 'Done.';
    return out;
  }

  return { buildSystemPrompt, parseReply, runTurn, listenCommand };
});
