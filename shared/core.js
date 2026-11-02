/* Splash AI - the core visual.
 * A mechanical core sitting in water: armour plates slide open and lock shut,
 * segmented rings turn, and the surface splashes when you speak.
 * States: idle, listening, thinking, speaking, error.
 */
(function (root) {
  const COLORS = {
    idle: [63, 208, 224],
    listening: [110, 245, 200],
    thinking: [150, 130, 255],
    speaking: [255, 145, 70],
    error: [255, 84, 96],
  };
  const lerp = (a, b, t) => a + (b - a) * t;

  class SplashCore {
    constructor(canvas) {
      this.c = canvas;
      this.g = canvas.getContext('2d');
      this.state = 'idle';
      this.level = 0; this.target = 0;
      this.spec = null;
      this.t = 0; this.open = 0; this.spin = 0;
      this.col = COLORS.idle.slice();
      this.ripples = [];
      this.reduced = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.drops = Array.from({ length: 60 }, () => ({ a: Math.random() * Math.PI * 2, r: 0.55 + Math.random() * 0.45, s: (Math.random() - 0.5) * 0.004, z: Math.random() }));
      this.resize = this.resize.bind(this);
      root.addEventListener('resize', this.resize);
      // Also follow layout changes that aren't window resizes (side panel hidden, caption grows).
      if (root.ResizeObserver) new root.ResizeObserver(this.resize).observe(canvas);
      this.resize();
      const loop = () => { this.frame(); root.requestAnimationFrame(loop); };
      root.requestAnimationFrame(loop);
    }
    resize() {
      const r = this.c.getBoundingClientRect();
      const d = root.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d));
      if (this.c.width !== w) this.c.width = w;
      if (this.c.height !== h) this.c.height = h;
      this.w = this.c.width; this.h = this.c.height;
    }
    setState(s) { if (COLORS[s]) { if (s !== this.state && (s === 'listening' || s === 'speaking')) this.splash(0.8); this.state = s; } }
    setLevel(v) {
      this.target = Math.max(0, Math.min(1, v || 0));
      if (this.target > 0.35 && Math.random() < 0.12) this.splash(this.target);
    }
    setSpectrum(arr) { this.spec = arr; }
    splash(v) { if (this.ripples.length < 10) this.ripples.push({ r: 0.15, a: 0.25 + 0.5 * v }); }

    frame() {
      const g = this.g, w = this.w, h = this.h;
      if (!w || !h) return;
      const speed = this.reduced ? 0.25 : 1;
      this.t += 0.016 * speed;
      this.level = lerp(this.level, this.target, 0.18);
      const tc = COLORS[this.state];
      for (let i = 0; i < 3; i++) this.col[i] = lerp(this.col[i], tc[i], 0.06);
      const [cr, cg, cb] = this.col.map(Math.round);
      const C = (a) => `rgba(${cr},${cg},${cb},${a})`;

      // how far the plates are open
      let want = 0;
      if (this.state === 'listening') want = 0.35 + this.level * 0.65;
      else if (this.state === 'thinking') want = 0.45 + 0.35 * Math.sin(this.t * 3);
      else if (this.state === 'speaking') want = 0.55 + this.level * 0.45;
      else if (this.state === 'error') want = 0.1;
      else want = 0.06 + 0.04 * Math.sin(this.t * 0.8);
      this.open = lerp(this.open, want, 0.08);
      const spinRate = this.state === 'thinking' ? 0.05 : this.state === 'idle' ? 0.004 : 0.012;
      this.spin += spinRate * speed;

      g.clearRect(0, 0, w, h);
      const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.36;

      // water glow
      const bg = g.createRadialGradient(cx, cy, R * 0.1, cx, cy, R * 1.6);
      bg.addColorStop(0, C(0.16 + this.level * 0.15));
      bg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = bg; g.fillRect(0, 0, w, h);

      // ripples
      g.lineWidth = Math.max(1, R * 0.006);
      this.ripples = this.ripples.filter(rp => rp.a > 0.01);
      this.ripples.forEach(rp => {
        rp.r += 0.012 * speed; rp.a *= 0.965;
        g.strokeStyle = C(rp.a);
        g.beginPath(); g.ellipse(cx, cy, R * rp.r * 1.6, R * rp.r * 1.6, 0, 0, Math.PI * 2); g.stroke();
      });

      // droplets orbiting
      this.drops.forEach(d => {
        d.a += d.s * (1 + this.level * 4) * speed * (this.state === 'thinking' ? 4 : 1);
        const rr = R * (1.05 + d.r * 0.55 + this.level * 0.2 * d.z);
        const x = cx + Math.cos(d.a) * rr, y = cy + Math.sin(d.a) * rr * 0.92;
        g.fillStyle = C(0.25 + d.z * 0.5);
        g.beginPath(); g.arc(x, y, Math.max(1, R * 0.006 * (0.5 + d.z)), 0, Math.PI * 2); g.fill();
      });

      // spectrum ring
      const bars = 96;
      g.lineCap = 'round';
      for (let i = 0; i < bars; i++) {
        let v;
        if (this.spec && this.spec.length) v = this.spec[Math.floor((i % (bars / 2)) / (bars / 2) * this.spec.length * 0.7)] / 255;
        else v = this.level * (0.5 + 0.5 * Math.sin(i * 0.7 + this.t * 6));
        if (this.state === 'thinking') v = 0.25 + 0.25 * Math.sin(i * 0.5 - this.t * 8);
        const a = (i / bars) * Math.PI * 2 + this.spin * 0.5;
        const r1 = R * 1.0, r2 = r1 + R * (0.02 + v * 0.28);
        g.strokeStyle = C(0.35 + v * 0.6);
        g.lineWidth = Math.max(1, R * 0.012);
        g.beginPath();
        g.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
        g.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
        g.stroke();
      }

      // segmented rings
      const ring = (radius, segs, gap, rot, width, alpha) => {
        g.lineWidth = width; g.strokeStyle = C(alpha); g.lineCap = 'butt';
        const step = (Math.PI * 2) / segs;
        for (let i = 0; i < segs; i++) {
          g.beginPath();
          g.arc(cx, cy, radius, rot + i * step + gap, rot + (i + 1) * step - gap);
          g.stroke();
        }
      };
      ring(R * (0.9 + this.open * 0.06), 3, 0.18, this.spin * 1.5, R * 0.025, 0.85);
      ring(R * (0.82 + this.open * 0.04), 24, 0.05, -this.spin * 2.2, R * 0.012, 0.45);
      ring(R * 0.76, 6, 0.32, this.spin * 3.1, R * 0.04, 0.3 + this.open * 0.4);

      // armour plates
      const plates = 6;
      for (let i = 0; i < plates; i++) {
        const a = (i / plates) * Math.PI * 2 + this.spin * 0.8 + Math.PI / 6;
        const push = R * (0.04 + this.open * 0.2);
        const ox = Math.cos(a) * push, oy = Math.sin(a) * push;
        const inner = R * 0.3, outer = R * 0.62, half = Math.PI / plates - 0.06;
        g.save();
        g.translate(cx + ox, cy + oy);
        g.beginPath();
        g.moveTo(Math.cos(a - half) * inner, Math.sin(a - half) * inner);
        g.lineTo(Math.cos(a - half * 0.8) * outer, Math.sin(a - half * 0.8) * outer);
        g.lineTo(Math.cos(a + half * 0.8) * outer, Math.sin(a + half * 0.8) * outer);
        g.lineTo(Math.cos(a + half) * inner, Math.sin(a + half) * inner);
        g.closePath();
        const pg = g.createLinearGradient(0, 0, Math.cos(a) * outer, Math.sin(a) * outer);
        pg.addColorStop(0, 'rgba(10,30,45,0.95)');
        pg.addColorStop(1, `rgba(${Math.round(cr * 0.25)},${Math.round(cg * 0.25)},${Math.round(cb * 0.3)},0.95)`);
        g.fillStyle = pg; g.fill();
        g.lineWidth = Math.max(1, R * 0.008); g.strokeStyle = C(0.75); g.stroke();
        // plate detail line
        g.beginPath();
        g.moveTo(Math.cos(a) * inner * 1.15, Math.sin(a) * inner * 1.15);
        g.lineTo(Math.cos(a) * outer * 0.9, Math.sin(a) * outer * 0.9);
        g.strokeStyle = C(0.35); g.stroke();
        g.restore();
      }

      // core
      const coreR = R * (0.2 + this.level * 0.06 + this.open * 0.05);
      const cgr = g.createRadialGradient(cx, cy, 0, cx, cy, coreR * 1.8);
      cgr.addColorStop(0, 'rgba(255,255,255,0.95)');
      cgr.addColorStop(0.25, C(0.95));
      cgr.addColorStop(1, C(0));
      g.fillStyle = cgr;
      g.beginPath(); g.arc(cx, cy, coreR * 1.8, 0, Math.PI * 2); g.fill();
      // inner hex
      g.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 - this.spin * 2;
        const x = cx + Math.cos(a) * coreR * 0.7, y = cy + Math.sin(a) * coreR * 0.7;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.closePath();
      g.lineWidth = Math.max(1, R * 0.01); g.strokeStyle = 'rgba(255,255,255,0.7)'; g.stroke();
    }
  }
  root.SplashCore = SplashCore;
})(typeof window !== 'undefined' ? window : this);
