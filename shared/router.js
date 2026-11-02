/* Splash AI - model router.
 * Tries each enabled provider in order. When one fails (limit reached, out of
 * credits, bad key, down), it rests for a while and the next one takes over.
 * Every provider here speaks the OpenAI-style /chat/completions format.
 * Works in Node (Electron main process) and in the browser (Android app).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SplashRouter = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Model names change over time. If one stops working, edit it in Settings.
  const PROVIDERS = [
    { id: 'gemini', name: 'Google Gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', keyUrl: 'https://aistudio.google.com/apikey' },
    { id: 'groq', name: 'Groq', base: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', keyUrl: 'https://console.groq.com/keys' },
    { id: 'openrouter', name: 'OpenRouter (free models)', base: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct:free', keyUrl: 'https://openrouter.ai/keys' },
    { id: 'mistral', name: 'Mistral', base: 'https://api.mistral.ai/v1', model: 'mistral-small-latest', keyUrl: 'https://console.mistral.ai/api-keys' },
    { id: 'github', name: 'GitHub Models', base: 'https://models.github.ai/inference', model: 'openai/gpt-4.1-mini', keyUrl: 'https://github.com/settings/tokens' },
    { id: 'huggingface', name: 'Hugging Face', base: 'https://router.huggingface.co/v1', model: 'meta-llama/Llama-3.3-70B-Instruct', keyUrl: 'https://huggingface.co/settings/tokens' },
    // Paid (pay per use, needs credit on the account). Speaks Anthropic's own Messages API, not /chat/completions.
    { id: 'claude', name: 'Claude (paid)', base: 'https://api.anthropic.com/v1', model: 'claude-opus-5-5', keyUrl: 'https://platform.claude.com/settings/keys', format: 'anthropic' },
    { id: 'ollama', name: 'Ollama (on this computer, unlimited)', base: 'http://localhost:11434/v1', model: 'llama3.2', keyUrl: 'https://ollama.com/download', noKey: true },
  ];

  function defaultProviderConfig() {
    return PROVIDERS.map(p => ({ ...p, key: '', enabled: true }));
  }

  // Keep the user's keys/models/order, but pick up providers added in new versions.
  function mergeProviderConfig(saved) {
    const out = [];
    const seen = new Set();
    (saved || []).forEach(s => {
      const def = PROVIDERS.find(p => p.id === s.id);
      if (def) { out.push({ ...def, ...s, keyUrl: def.keyUrl, noKey: def.noKey, format: def.format }); seen.add(s.id); }
      else if (s.custom) { out.push(s); seen.add(s.id); }
    });
    PROVIDERS.forEach(p => { if (!seen.has(p.id)) out.push({ ...p, key: '', enabled: true }); });
    return out;
  }

  function cooldownFor(err) {
    const msg = String(err && err.message || '').toLowerCase();
    const s = err && err.status;
    if (err && err.noPlan) return 6 * 60 * 60 * 1000;   // fix is on the provider's site, no point retrying soon
    if (err && err.badReply) return 60 * 60 * 1000;     // service misbehaving; check again in an hour
    if (s === 429) {
      if (/quota|per day|daily|exhaust|limit exceeded|credits/.test(msg)) return 60 * 60 * 1000; // 1h, then re-check
      return Math.max((err.retryAfter || 60) * 1000, 30 * 1000);
    }
    if (s === 402) return 6 * 60 * 60 * 1000;           // out of credits
    if (s === 401 || s === 403) return 6 * 60 * 60 * 1000; // bad/blocked key
    if (s === 404) return 60 * 60 * 1000;                // model name changed
    if (err && err.name === 'AbortError') return 2 * 60 * 1000;
    if (s >= 500) return 2 * 60 * 1000;
    return 60 * 1000;                                    // network down, Ollama not running, etc.
  }

  // A short, plain reason to show the user when a model fails.
  function describeError(err) {
    const msg = String(err && err.message || '').toLowerCase();
    const s = err && err.status;
    if (err && err.noPlan) return 'this key has no free plan switched on yet (activate the free plan on the provider\'s website)';
    if (err && err.badReply) return 'the service sent back something that isn\'t a reply, so it isn\'t working right now (your key is fine)';
    if (s === 402 || /credit|billing|payment|insufficient/.test(msg)) return 'out of credits';
    if (s === 429) return 'limit reached';
    if (s === 401 || s === 403) return 'key not accepted';
    if (s === 404) return 'model name not found';
    if (err && err.name === 'AbortError') return 'took too long';
    if (s >= 500) return 'service is down';
    if (msg === 'empty reply') return 'sent an empty reply';
    return 'could not connect';
  }

  // Claude via the Messages API. The system prompt goes in the top-level "system" field.
  async function callAnthropic(p, messages, opts, signal) {
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const turns = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: String(m.content) }));
    while (turns.length && turns[0].role !== 'user') turns.shift(); // must start with the user
    // Server-side fallback exists for these models only (not Haiku); other models just stop on a decline.
    const canFallback = /^claude-(opus-5-5|opus-5|sonnet-5-5|fable-5-1)$/.test(p.model);
    const res = await fetch(p.base.replace(/\/$/, '') + '/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': p.key.trim(),
        'anthropic-version': '2026-10-21',
        // On a safety decline, re-run on a fallback model inside the same call.
        ...(canFallback ? { 'anthropic-beta': 'server-side-fallback-2026-07-01' } : {}),
        // Needed when the phone's web view calls the API directly.
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: p.model,
        max_tokens: Math.max(opts.maxTokens || 0, 8000),
        system,
        messages: turns,
        // Spoken replies should come back fast; low effort is plenty for chat and simple actions.
        output_config: { effort: 'low' },
        ...(canFallback ? { fallbacks: 'default' } : {}),
      }),
      signal,
    });
    const body = await res.text();
    if (!res.ok) {
      const e = new Error('HTTP ' + res.status + ' ' + body.slice(0, 300));
      e.status = res.status;
      e.retryAfter = Number(res.headers.get('retry-after')) || 0;
      throw e;
    }
    const data = JSON.parse(body);
    if (data.stop_reason === 'refusal') throw new Error('Declined the request');
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    if (!text.trim()) throw new Error('Empty reply');
    return text;
  }

  async function callProvider(p, messages, opts) {
    if (p.format === 'anthropic') {
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = setTimeout(() => ctrl && ctrl.abort(), opts.timeout || 90000);
      try { return await callAnthropic(p, messages, opts, ctrl ? ctrl.signal : undefined); }
      finally { clearTimeout(timer); }
    }
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    // Models running on the laptop's own processor (Ollama) can take a minute or more, so wait longer for them.
    const timer = setTimeout(() => ctrl && ctrl.abort(), opts.timeout || (p.noKey ? 180000 : 60000));
    const headers = { 'Content-Type': 'application/json' };
    if (p.key) headers.Authorization = 'Bearer ' + p.key.trim();
    if (p.id === 'openrouter') { headers['HTTP-Referer'] = 'https://splash-ai.local'; headers['X-Title'] = 'Splash AI'; }
    // Local models (Ollama) are slow on a laptop processor: give them the short instructions,
    // only the last few messages, a short answer limit, and keep the model loaded between questions.
    const local = !!p.noKey;
    if (local && opts.compactSystem) {
      const rest = messages.filter(m => m.role !== 'system');
      messages = [{ role: 'system', content: opts.compactSystem }, ...rest.slice(-6)];
    }
    const request = { model: p.model, messages, temperature: opts.temperature ?? 0.5, max_tokens: local ? 400 : (opts.maxTokens || 2048) };
    if (local) request.keep_alive = '30m';
    try {
      const res = await fetch(p.base.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        signal: ctrl ? ctrl.signal : undefined,
      });
      const body = await res.text();
      if (!res.ok) {
        const e = new Error('HTTP ' + res.status + ' ' + body.slice(0, 300));
        e.status = res.status;
        e.retryAfter = Number(res.headers.get('retry-after')) || 0;
        // A limit of 0 means the account has no plan that allows requests yet (e.g. Mistral before
        // the free plan is activated), not that you used it up.
        if (res.status === 429 && ['x-ratelimit-limit-req-minute', 'x-ratelimit-limit-requests'].some(h => res.headers.get(h) === '0')) e.noPlan = true;
        throw e;
      }
      let data;
      try { data = JSON.parse(body); }
      catch {
        // e.g. GitHub Models answering a bare "OK": the service isn't working, not a network problem
        const e = new Error('Not a reply: ' + body.slice(0, 80));
        e.badReply = true;
        throw e;
      }
      const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!text || !String(text).trim()) throw new Error('Empty reply');
      return String(text);
    } finally { clearTimeout(timer); }
  }

  class Router {
    // config: { providers: [...] }, state: { [id]: { until, last, at } }
    constructor(config, state, onEvent) {
      this.config = config;
      this.state = state || {};
      this.onEvent = onEvent || (() => {});
    }
    ready() {
      const now = Date.now();
      return this.config.providers.filter(p => p.enabled && (p.key || p.noKey) && !((this.state[p.id] || {}).until > now));
    }
    status() {
      const now = Date.now();
      return this.config.providers.map(p => {
        const st = this.state[p.id] || {};
        return { id: p.id, name: p.name, model: p.model, enabled: p.enabled, hasKey: !!(p.key || p.noKey),
          restingFor: st.until > now ? Math.round((st.until - now) / 1000) : 0, last: st.last || '' };
      });
    }
    wake(id) { if (id) delete this.state[id]; else this.state = {}; this.onEvent('state', this.state); }
    async chat(messages, opts = {}) {
      // Every checked model gets a turn: rested-up ones first in your order, then
      // the resting ones (soonest to wake first) in case their limit already reset.
      const ready = this.ready();
      const resting = this.config.providers
        .filter(p => p.enabled && (p.key || p.noKey) && !ready.includes(p))
        .sort((a, b) => ((this.state[a.id] || {}).until || 0) - ((this.state[b.id] || {}).until || 0));
      const list = ready.concat(resting);
      if (!list.length) throw new Error('No models set up yet. Open Settings and paste at least one free API key, or install Ollama.');
      const errors = [];
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        try {
          this.onEvent('trying', p);
          const text = await callProvider(p, messages, opts);
          this.state[p.id] = { until: 0, last: 'ok', at: Date.now() };
          this.onEvent('state', this.state);
          return { text, provider: p.id, providerName: p.name, model: p.model };
        } catch (e) {
          const ms = cooldownFor(e);
          this.state[p.id] = { until: Date.now() + ms, last: String(e.message).slice(0, 200), at: Date.now() };
          const why = describeError(e);
          errors.push(p.name + ': ' + why + ' (' + String(e.message).slice(0, 140) + ')');
          this.onEvent('state', this.state);
          this.onEvent('fallback', { from: p.name, why, reason: String(e.message).slice(0, 140), next: list[i + 1] ? list[i + 1].name : '' });
        }
      }
      throw new Error('Every checked model failed this time:\n' + errors.join('\n'));
    }
  }

  return { PROVIDERS, Router, defaultProviderConfig, mergeProviderConfig, cooldownFor, describeError };
});
