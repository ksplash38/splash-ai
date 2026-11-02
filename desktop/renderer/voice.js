/* Splash AI voice (desktop).
 * Listens offline with Vosk for any of your wake words, then records your
 * command until you stop talking. Uses Groq Whisper for the command if you
 * have a Groq key (much more accurate), otherwise the offline text.
 */
(function () {
  function norm(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\b(a i|a eye|ay i|ay eye|eye|ai)\b/g, 'ai').replace(/\s+/g, ' ').trim();
  }
  function lev(a, b) {
    const m = a.length, n = b.length;
    if (Math.abs(m - n) > 1) return 2;
    const d = Array.from({ length: m + 1 }, (_, i) => [i]);
    for (let j = 1; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[m][n];
  }
  const near = (w, t) => w === t || (t.length >= 4 && lev(w, t) <= 1);
  // Vosk often "hears" a stray filler word in background noise; don't treat that as you talking.
  const FILLER = new Set(['the', 'a', 'uh', 'um', 'huh', 'hmm', 'ah', 'oh', 'and', 'i']);
  const meaningful = t => norm(t).split(' ').filter(w => w && !FILLER.has(w)).length > 0;

  // returns the text after the wake word, or null if no wake word was heard
  function matchWake(text, wakeWords) {
    const words = norm(text).split(' ').filter(Boolean);
    for (const ww of wakeWords) {
      const t = norm(ww).split(' ').filter(Boolean);
      if (!t.length) continue;
      for (let i = 0; i + t.length <= words.length; i++) {
        if (t.every((tw, k) => near(words[i + k], tw))) return words.slice(i + t.length).join(' ');
      }
    }
    return null;
  }

  class Voice {
    constructor(o) { this.o = o; this.mode = 'off'; this.cmdFinal = ''; this.cmdPartial = ''; this.noise = 0.01; this.openMic = false; }

    // Open mic: while on, you can just talk (no wake word needed). Used while it
    // thinks and for a few seconds after it answers, so follow-ups are easy.
    setOpenMic(on, ms) {
      clearTimeout(this.openTimer);
      this.openMic = !!on;
      if (on && ms) this.openTimer = setTimeout(() => { this.openMic = false; this.o.onOpenMicEnd && this.o.onOpenMicEnd(); }, ms);
    }

    async init() {
      this.o.onStatus('Downloading the offline voice model (first run only, about 40 MB)');
      const url = await window.splash.modelUrl();
      this.o.onStatus('Loading the voice model');
      this.model = await Vosk.createModel(url);
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
      this.ctx = new AudioContext();
      const src = this.ctx.createMediaStreamSource(this.stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      src.connect(this.analyser);
      this.rec = new this.model.KaldiRecognizer(this.ctx.sampleRate);
      this.rec.on('partialresult', m => this.onPartial(m.result.partial || ''));
      this.rec.on('result', m => this.onResult(m.result.text || ''));
      const node = this.ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = e => { if (this.mode !== 'muted') { try { this.rec.acceptWaveform(e.inputBuffer); } catch {} } };
      src.connect(node); node.connect(this.ctx.destination);
      this.mode = 'idle';
      this.meter();
    }

    meter() {
      const buf = new Float32Array(this.analyser.fftSize);
      const spec = new Uint8Array(this.analyser.frequencyBinCount);
      const tick = () => {
        this.analyser.getFloatTimeDomainData(buf);
        let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        if (this.mode === 'idle') this.noise = this.noise * 0.995 + rms * 0.005;
        this.rms = rms;
        if (this.mode === 'command') {
          this.analyser.getByteFrequencyData(spec);
          this.o.onSpectrum(spec);
          this.o.onLevel(Math.min(1, rms * 12));
          if (rms > Math.max(0.012, this.noise * 2.5)) this.lastSpeech = performance.now();
          const now = performance.now();
          // Wait 2.5s of silence so a short pause mid-sentence doesn't cut you off.
          if ((now - this.lastSpeech > 2500 && now - this.started > 2000) || now - this.started > 45000) this.finish();
        } else if (this.mode === 'idle') {
          this.o.onLevel(Math.min(1, rms * 6));
        }
        requestAnimationFrame(tick);
      };
      tick();
    }

    onPartial(text) {
      if (!text) return;
      this.o.onHeard(text);
      if (this.mode === 'idle') {
        const rest = matchWake(text, this.o.getWakeWords());
        if (rest !== null) this.startCommand(rest, true);
        else if (this.openMic && meaningful(text)) this.startCommand(text, false);
      } else if (this.mode === 'command') {
        const rest = matchWake(text, this.o.getWakeWords());
        this.cmdPartial = rest !== null ? rest : text;
        this.o.onHeard(this.cmdFinal + ' ' + this.cmdPartial);
      }
    }
    onResult(text) {
      if (!text) return;
      if (this.mode === 'idle') {
        const rest = matchWake(text, this.o.getWakeWords());
        if (rest !== null) { this.startCommand('', true); this.cmdFinal = rest; }
        else if (this.openMic && meaningful(text)) { this.startCommand('', false); this.cmdFinal = text; }
      } else if (this.mode === 'command') {
        const rest = matchWake(text, this.o.getWakeWords());
        this.cmdFinal = (this.cmdFinal + ' ' + (rest !== null ? rest : text)).trim();
        this.cmdPartial = '';
      }
    }

    // viaWake: true when you said the wake word or pressed talk; false when the open mic picked you up.
    startCommand(initial, viaWake = true) {
      if (this.mode === 'command') return;
      this.mode = 'command';
      this.viaWake = viaWake;
      this.setOpenMic(false);
      this.cmdFinal = ''; this.cmdPartial = initial || '';
      this.started = this.lastSpeech = performance.now();
      this.chunks = [];
      try {
        this.recorder = new MediaRecorder(this.stream, { mimeType: 'audio/webm' });
        this.recorder.ondataavailable = e => e.data.size && this.chunks.push(e.data);
        this.recorder.start();
      } catch { this.recorder = null; }
      this.beep(880);
      this.o.onWake();
    }
    pushToTalk() { if (this.mode === 'idle' || this.mode === 'muted') { this.micOff = false; this.mode = 'idle'; this.startCommand('', true); } }

    async finish() {
      if (this.mode !== 'command') return;
      this.mode = 'muted';
      this.flush();
      this.beep(560);
      const offline = (this.cmdFinal + ' ' + this.cmdPartial).trim();
      let text = null;
      let viaWake = this.viaWake;
      if (this.recorder && this.recorder.state !== 'inactive') {
        const blob = await new Promise(res => { this.recorder.onstop = () => res(new Blob(this.chunks, { type: 'audio/webm' })); this.recorder.stop(); });
        if (blob.size > 2000) {
          this.o.onStatus('Working out what you said');
          text = await window.splash.transcribe(await blob.arrayBuffer());
          const rest = text ? matchWake(text, this.o.getWakeWords()) : null;
          if (rest !== null) { text = rest; viaWake = true; }
        }
      }
      // Whisper is far more accurate; use the offline guess only when Whisper isn't available.
      text = (text === null ? offline : text).trim();
      this.o.onCommand(text, { viaWake });
    }

    // Close off the current utterance so old words can't re-trigger the wake word.
    flush() { try { this.rec.retrieveFinalResult(); } catch {} }
    mute(on) {
      if (this.mode === 'off') return;
      if (on) { if (this.mode !== 'muted') { this.mode = 'muted'; this.flush(); } }
      else if (this.mode === 'muted' && !this.micOff) this.mode = 'idle';
    }
    // Mic fully off (not even the wake word) until you press talk or call setMicOff(false).
    setMicOff(on) {
      // Drop anything half-heard so it isn't sent when the mic comes back.
      if (on && this.mode === 'command') {
        try { this.recorder && this.recorder.state !== 'inactive' && this.recorder.stop(); } catch {}
        this.cmdFinal = this.cmdPartial = '';
        this.mode = 'idle';
      }
      this.micOff = !!on;
      this.setOpenMic(false);
      this.mute(on);
    }

    beep(freq) {
      if (!this.ctx) return;
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.frequency.value = freq; g.gain.value = 0.0001;
      o.connect(g); g.connect(this.ctx.destination);
      const t = this.ctx.currentTime;
      g.gain.exponentialRampToValueAtTime(0.15, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      o.start(t); o.stop(t + 0.2);
    }
  }

  // Text-to-speech: natural online voices ('edge:<id>'), falling back to Windows voices
  let audio = null, audioCtx = null, speakId = 0;
  const Speaker = {
    voices() { return speechSynthesis.getVoices(); },
    clean(t) {
      return String(t).replace(/```[\s\S]*?```/g, ' (code shown on screen) ').replace(/[*_#`>]/g, '')
        .replace(/https?:\/\/\S+/g, 'the link').slice(0, 700);
    },
    async speak(text, voiceName, onLevel) {
      this.stop();
      const id = ++speakId;
      if (String(voiceName || '').startsWith('edge:')) {
        const r = await window.splash.tts({ text: this.clean(text), voice: voiceName.slice(5) });
        if (id !== speakId) return; // stopped while it was loading
        if (r.ok) return this.playMp3(r.audio, onLevel);
        console.warn('Natural voice failed, using the Windows voice:', r.error);
      }
      return this.speakWindows(text, voiceName, onLevel);
    },
    playMp3(bytes, onLevel) {
      return new Promise(resolve => {
        const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
        audio = new Audio(url);
        let timer = null;
        try {
          // Drive the core's pulse from the real loudness of the voice.
          audioCtx = audioCtx || new AudioContext();
          const an = audioCtx.createAnalyser(); an.fftSize = 512;
          audioCtx.createMediaElementSource(audio).connect(an);
          an.connect(audioCtx.destination);
          const data = new Uint8Array(an.fftSize);
          timer = setInterval(() => {
            an.getByteTimeDomainData(data);
            let sum = 0; for (const v of data) sum += (v - 128) * (v - 128);
            onLevel(Math.min(1, Math.sqrt(sum / data.length) / 40));
          }, 60);
        } catch { timer = setInterval(() => onLevel(0.3 + Math.random() * 0.6), 90); }
        const done = () => { clearInterval(timer); onLevel(0); URL.revokeObjectURL(url); resolve(); };
        audio.onended = done; audio.onerror = done; audio.onpause = done;
        audio.play().catch(done);
      });
    },
    speakWindows(text, voiceName, onLevel) {
      return new Promise(resolve => {
        const u = new SpeechSynthesisUtterance(this.clean(text));
        const v = this.voices().find(x => x.name === voiceName);
        if (v) u.voice = v;
        u.rate = 1.03;
        let timer = setInterval(() => onLevel(0.3 + Math.random() * 0.6), 90);
        const done = () => { clearInterval(timer); onLevel(0); resolve(); };
        u.onend = done; u.onerror = done;
        speechSynthesis.speak(u);
      });
    },
    stop() {
      speakId++;
      speechSynthesis.cancel();
      if (audio) { audio.pause(); audio = null; }
    },
  };

  window.SplashVoice = Voice;
  window.SplashSpeaker = Speaker;
  window.matchWake = matchWake;
})();
