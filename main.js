(() => {
  'use strict';

  // Standard tuning, low E on top — the way you see it when you hold the guitar.
  const STRINGS = [
    { freq: 82.41, width: 3.0, wound: true },
    { freq: 110.0, width: 2.5, wound: true },
    { freq: 146.83, width: 2.0, wound: true },
    { freq: 196.0, width: 1.6, wound: false },
    { freq: 246.94, width: 1.25, wound: false },
    { freq: 329.63, width: 1.0, wound: false },
  ];

  const canvas = document.getElementById('strings');
  const ctx2d = canvas.getContext('2d');
  const soundBtn = document.getElementById('sound');
  const gameBtn = document.getElementById('game');
  const statusEl = document.getElementById('status');
  const bestEl = document.getElementById('best');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const darkScheme = window.matchMedia('(prefers-color-scheme: dark)');

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /* ---------- sound ---------- */

  let audio = null;
  let master = null;
  let soundOn = false;
  let userMuted = false;
  const bank = [];
  const voices = [];

  // Karplus–Strong: a short burst of noise fed through a decaying delay line.
  function makeString(freq) {
    const sr = audio.sampleRate;
    const len = Math.floor(sr * 3.2);
    const buf = audio.createBuffer(1, len, sr);
    const out = buf.getChannelData(0);
    const n = Math.max(2, Math.round(sr / freq - 0.5));
    const ring = new Float32Array(n);
    let soft = 0;
    for (let i = 0; i < n; i++) {
      soft = soft * 0.45 + (Math.random() * 2 - 1) * 0.55;
      ring[i] = soft;
    }
    const decay = 0.9965;
    let peak = 0;
    for (let i = 0, j = 0; i < len; i++) {
      const k = j + 1 === n ? 0 : j + 1;
      const v = ring[j];
      ring[j] = decay * 0.5 * (v + ring[k]);
      out[i] = v;
      peak = Math.max(peak, Math.abs(v));
      j = k;
    }
    const fade = Math.floor(sr * 0.3);
    const gain = peak ? 0.9 / peak : 1;
    for (let i = 0; i < len; i++) {
      out[i] *= gain * (i > len - fade ? (len - i) / fade : 1);
    }
    return buf;
  }

  function enableSound() {
    if (!audio) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audio = new AC();
      master = audio.createGain();
      master.gain.value = 0.45;
      const comp = audio.createDynamicsCompressor();
      master.connect(comp);
      comp.connect(audio.destination);
      STRINGS.forEach((s, i) => {
        bank[i] = [makeString(s.freq), makeString(s.freq), makeString(s.freq)];
      });
    }
    if (audio.state === 'suspended') audio.resume();
    soundOn = true;
    renderSoundBtn();
  }

  function disableSound() {
    soundOn = false;
    if (audio) audio.suspend();
    renderSoundBtn();
  }

  function renderSoundBtn() {
    soundBtn.textContent = soundOn ? 'sound on' : 'sound off';
    soundBtn.setAttribute('aria-pressed', String(soundOn));
  }

  // Any real gesture can turn sound on, unless the visitor switched it off.
  function wake() {
    if (!userMuted && !soundOn) enableSound();
  }

  function ring(i, vel, pan, delay) {
    if (!soundOn || !audio) return;
    const t = audio.currentTime + (delay || 0);
    const old = voices[i];
    if (old) {
      // A new pluck damps the previous one, like a real string.
      old.gain.gain.cancelScheduledValues(t);
      old.gain.gain.setTargetAtTime(0, t, 0.015);
      try { old.src.stop(t + 0.12); } catch (e) { /* already stopped */ }
    }
    const src = audio.createBufferSource();
    const variants = bank[i];
    src.buffer = variants[(Math.random() * variants.length) | 0];
    src.playbackRate.value = 1 + (Math.random() - 0.5) * 0.002;
    const gain = audio.createGain();
    gain.gain.value = 0.25 + vel * 0.6;
    src.connect(gain);
    if (audio.createStereoPanner) {
      const p = audio.createStereoPanner();
      p.pan.value = (pan - 0.5) * 0.8;
      gain.connect(p);
      p.connect(master);
    } else {
      gain.connect(master);
    }
    src.start(t);
    const voice = { src, gain };
    voices[i] = voice;
    src.onended = () => { if (voices[i] === voice) voices[i] = null; };
  }

  soundBtn.addEventListener('click', () => {
    if (soundOn) {
      userMuted = true;
      disableSound();
    } else {
      userMuted = false;
      enableSound();
      pluck(5, { x: 0.5, vel: 0.5 });
    }
  });

  /* ---------- drawing ---------- */

  let W = 0;
  let H = 0;
  let ys = [];
  let gap = 0;
  let raf = 0;
  const colors = { ink: '#1d1b18', accent: '#c2410c', bg: '#f2ede3' };
  const strings = STRINGS.map(() => ({ amp: 0, t0: 0, px: 0.5, glow: 0 }));

  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    colors.ink = cs.getPropertyValue('--ink').trim() || colors.ink;
    colors.accent = cs.getPropertyValue('--accent').trim() || colors.accent;
    colors.bg = cs.getPropertyValue('--bg').trim() || colors.bg;
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = r.width;
    H = r.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    const top = H * 0.17;
    gap = (H * 0.66) / (STRINGS.length - 1);
    ys = STRINGS.map((_, i) => top + gap * i);
    draw(performance.now());
  }

  function strokeString(i, a, px, osc) {
    const y0 = ys[i];
    const pxW = px * W;
    ctx2d.beginPath();
    const steps = 64;
    for (let k = 0; k <= steps; k++) {
      const x = (k / steps) * W;
      const shape = x < pxW ? x / pxW : (W - x) / (W - pxW);
      const y = y0 + a * shape * osc;
      if (k) ctx2d.lineTo(x, y); else ctx2d.moveTo(x, y);
    }
  }

  function draw(now) {
    ctx2d.clearRect(0, 0, W, H);
    let busy = false;
    for (let i = 0; i < STRINGS.length; i++) {
      const s = strings[i];
      const t = (now - s.t0) / 1000;
      let a = s.amp * Math.exp(-t * (2.4 + i * 0.35));
      if (a < 0.12) a = 0; else busy = true;
      const glow = s.glow ? Math.max(0, 1 - t / 0.9) : 0;
      if (glow > 0) busy = true;
      const osc = Math.sin(t * Math.PI * 2 * (14 + i * 2.2));

      strokeString(i, a, s.px, osc);
      ctx2d.lineWidth = STRINGS[i].width;
      ctx2d.lineCap = 'round';
      ctx2d.globalAlpha = 0.88;
      ctx2d.strokeStyle = colors.ink;
      ctx2d.stroke();

      if (STRINGS[i].wound) {
        ctx2d.setLineDash([0.8, 1.6]);
        ctx2d.globalAlpha = 0.35;
        ctx2d.strokeStyle = colors.bg;
        ctx2d.stroke();
        ctx2d.setLineDash([]);
      }

      if (glow > 0) {
        ctx2d.globalAlpha = glow;
        ctx2d.strokeStyle = colors.accent;
        ctx2d.lineWidth = STRINGS[i].width + 1.2;
        ctx2d.stroke();
      }
    }
    ctx2d.globalAlpha = 1;
    return busy;
  }

  function frame(now) {
    raf = 0;
    if (draw(now)) raf = requestAnimationFrame(frame);
  }

  function kick() {
    if (!raf) raf = requestAnimationFrame(frame);
  }

  /* ---------- plucking ---------- */

  const lastPluck = STRINGS.map(() => 0);

  function pluck(i, opts) {
    const now = performance.now();
    if (now - lastPluck[i] < 45 && !opts.force) return;
    lastPluck[i] = now;
    const s = strings[i];
    const vel = clamp(opts.vel == null ? 0.7 : opts.vel, 0.1, 1);
    s.amp = (5 + vel * 11) * (reduceMotion.matches ? 0.3 : 1);
    s.t0 = now;
    s.px = clamp(opts.x == null ? 0.5 : opts.x, 0.08, 0.92);
    s.glow = opts.glow ? 1 : 0;
    kick();
    ring(i, vel, s.px, opts.delay);
  }

  function nearest(y) {
    let best = -1;
    let dist = Infinity;
    ys.forEach((sy, i) => {
      const d = Math.abs(sy - y);
      if (d < dist) { dist = d; best = i; }
    });
    return dist <= gap * 0.6 ? best : -1;
  }

  // Returns false when the visitor's pluck should be ignored.
  function userPluck(i, x, vel, isTap, delay) {
    if (game.state === 'listening' || game.state === 'between') return;
    if (game.state === 'yours') {
      if (!isTap) return;
      pluck(i, { x, vel, glow: true });
      check(i);
      return;
    }
    pluck(i, { x, vel, delay });
  }

  let last = null;

  function point(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, t: e.timeStamp };
  }

  canvas.addEventListener('pointerdown', (e) => {
    wake();
    const p = point(e);
    last = p;
    const i = nearest(p.y);
    if (i >= 0) userPluck(i, p.x / W, 0.8, true);
    if (e.pointerType !== 'mouse' && canvas.setPointerCapture) {
      canvas.setPointerCapture(e.pointerId);
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const p = point(e);
    if (last) {
      const dy = p.y - last.y;
      const dt = Math.max(1, p.t - last.t);
      const vel = clamp(Math.abs(dy) / dt / 2.5, 0.25, 1);
      const crossed = [];
      ys.forEach((sy, i) => {
        if ((last.y - sy) * (p.y - sy) < 0) crossed.push(i);
      });
      if (dy < 0) crossed.reverse();
      crossed.forEach((i, k) => {
        const f = (ys[i] - last.y) / dy;
        const x = (last.x + (p.x - last.x) * f) / W;
        userPluck(i, x, vel, false, k * 0.012);
      });
    }
    last = p;
  });

  const forget = () => { last = null; };
  canvas.addEventListener('pointerleave', forget);
  canvas.addEventListener('pointercancel', forget);
  canvas.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') forget(); });

  window.addEventListener('keydown', (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const n = Number(e.key);
    if (n >= 1 && n <= 6) {
      wake();
      userPluck(n - 1, 0.5, 0.7, true);
    }
  });

  /* ---------- the little game: hear it, play it back ---------- */

  const game = { state: 'idle', seq: [], pos: 0, best: loadBest(), timers: [] };

  function loadBest() {
    try { return Number(localStorage.getItem('tk-best')) || 0; } catch (e) { return 0; }
  }

  function saveBest(n) {
    game.best = n;
    try { localStorage.setItem('tk-best', String(n)); } catch (e) { /* private mode */ }
    renderBest();
  }

  function renderBest() {
    bestEl.textContent = game.best ? 'best: ' + game.best : '';
  }

  function later(fn, ms) {
    game.timers.push(setTimeout(fn, ms));
  }

  function randomString() {
    const seq = game.seq;
    let n;
    do {
      n = (Math.random() * STRINGS.length) | 0;
    } while (seq.length >= 2 && n === seq[seq.length - 1] && n === seq[seq.length - 2]);
    return n;
  }

  function startGame() {
    game.timers.forEach(clearTimeout);
    game.timers = [];
    game.seq = [];
    for (let k = 0; k < 3; k++) game.seq.push(randomString());
    listen();
  }

  function listen() {
    const len = game.seq.length;
    const step = len > 6 ? 430 : 540;
    game.state = 'listening';
    game.pos = 0;
    gameBtn.disabled = true;
    statusEl.textContent = 'Listen…';
    game.seq.forEach((n, k) => {
      later(() => pluck(n, { x: 0.5, vel: 0.75, glow: true, force: true }), 400 + k * step);
    });
    later(() => {
      game.state = 'yours';
      statusEl.textContent = 'Your turn — 0/' + len;
    }, 400 + len * step);
  }

  function check(i) {
    const len = game.seq.length;
    if (i === game.seq[game.pos]) {
      game.pos++;
      if (game.pos < len) {
        statusEl.textContent = game.pos + '/' + len;
        return;
      }
      if (len > game.best) saveBest(len);
      game.state = 'between';
      statusEl.textContent = len < 5 ? 'Nice. One more.' : len < 8 ? 'Good ear.' : 'Okay, show-off.';
      later(() => {
        game.seq.push(randomString());
        listen();
      }, 1100);
    } else {
      game.state = 'idle';
      gameBtn.disabled = false;
      gameBtn.textContent = 'Try again';
      statusEl.textContent = len > 3 ? 'Missed. You got ' + (len - 1) + ' in a row.' : 'Not that one.';
      // Show which string it was.
      pluck(game.seq[game.pos], { x: 0.5, vel: 0.3, glow: true, force: true });
    }
  }

  gameBtn.addEventListener('click', () => {
    wake();
    startGame();
  });

  /* ---------- boot ---------- */

  readColors();
  renderBest();
  renderSoundBtn();
  resize();
  if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas);
  else window.addEventListener('resize', resize);
  const onScheme = () => { readColors(); draw(performance.now()); };
  if (darkScheme.addEventListener) darkScheme.addEventListener('change', onScheme);

  // A quiet hello so people notice the strings are alive.
  setTimeout(() => {
    [0, 1, 2, 3, 4, 5].forEach((i) => {
      setTimeout(() => pluck(i, { x: 0.3, vel: 0.35 }), i * 70);
    });
  }, 900);
})();
