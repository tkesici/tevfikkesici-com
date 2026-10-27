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
  const playBtn = document.getElementById('game');
  const hint = document.querySelector('.hint');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const darkScheme = window.matchMedia('(prefers-color-scheme: dark)');

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /* ---------- sound ---------- */

  let audio = null;
  let master = null;
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

  // Browsers only allow audio after a click, tap or key press.
  function wake() {
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
    if (audio.state === 'suspended') audio.resume().then(() => hint.classList.remove('locked'));
    else hint.classList.remove('locked');
  }

  // Any first click, tap or key press anywhere on the page unlocks the sound.
  ['pointerdown', 'touchend', 'click', 'keydown'].forEach((type) => {
    document.addEventListener(type, wake, { capture: true, passive: true });
  });

  function ring(i, vel, pan, delay, fret) {
    if (!audio || audio.state !== 'running') return;
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
    const rate = Math.pow(2, (fret || 0) / 12) * (1 + (Math.random() - 0.5) * 0.002);
    src.playbackRate.value = rate;
    // Picked near the ends a string sounds thin and bright, in the middle soft and round.
    const warmth = clamp((Math.min(pan, 1 - pan) - 0.08) / 0.42, 0, 1);
    const tone = audio.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 9000 * Math.pow(1400 / 9000, warmth);
    tone.Q.value = 0.6;
    const gain = audio.createGain();
    gain.gain.value = (0.25 + vel * 0.6) * (1 + warmth * 0.3);
    src.connect(tone);
    tone.connect(gain);
    if (audio.createStereoPanner) {
      const p = audio.createStereoPanner();
      p.pan.value = (pan - 0.5) * 0.8;
      gain.connect(p);
      p.connect(master);
    } else {
      gain.connect(master);
    }
    src.start(t);
    const voice = { src, gain, rate };
    voices[i] = voice;
    src.onended = () => { if (voices[i] === voice) voices[i] = null; };
  }

  function bendPitch(i, semis, glide) {
    const v = voices[i];
    if (!v || !audio) return;
    v.src.playbackRate.setTargetAtTime(v.rate * Math.pow(2, semis / 12), audio.currentTime, glide);
  }

  /* ---------- drawing ---------- */

  let W = 0;
  let H = 0;
  let ys = [];
  let gap = 0;
  let raf = 0;
  const colors = { ink: '#121212', accent: '#000', bg: '#f4f4f2' };
  const strings = STRINGS.map(() => ({ amp: 0, t0: 0, px: 0.5, glow: 0, hold: 0, holdX: 0.5 }));
  let bend = null;

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

  // A string pulled at one point makes a triangle between the two ends.
  function tri(x, at) {
    const p = at * W;
    return x < p ? x / p : (W - x) / (W - p);
  }

  function strokeString(i, a, osc) {
    const s = strings[i];
    ctx2d.beginPath();
    const steps = 64;
    for (let k = 0; k <= steps; k++) {
      const x = (k / steps) * W;
      const y = ys[i] + s.hold * tri(x, s.holdX) + a * tri(x, s.px) * osc;
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

      // Let go of a bend and the string snaps back.
      if (bend && bend.active && bend.i === i) busy = true;
      else if (s.hold) {
        s.hold *= 0.6;
        if (Math.abs(s.hold) < 0.3) s.hold = 0; else busy = true;
      }

      strokeString(i, a, osc);
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
    ring(i, vel, s.px, opts.delay, opts.fret);
    if (opts.touch) buzz();
  }

  // A tiny tick under the finger on phones that support it.
  let lastBuzz = 0;
  function buzz() {
    const now = performance.now();
    if (!navigator.vibrate || now - lastBuzz < 30) return;
    lastBuzz = now;
    try { navigator.vibrate(8); } catch (e) { /* not allowed yet */ }
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

  let last = null;

  function point(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, t: e.timeStamp };
  }

  /* ---------- bending: press on a string and pull ---------- */

  const MAX_BEND = 2; // semitones — a whole-step bend

  function startBend() {
    bend.active = true;
    strings[bend.i].holdX = clamp(bend.x / W, 0.08, 0.92);
    kick();
  }

  function moveBend(p) {
    const reach = gap * 0.9;
    const dy = clamp(p.y - bend.y, -reach, reach);
    strings[bend.i].hold = dy;
    strings[bend.i].holdX = clamp(p.x / W, 0.04, 0.96);
    bendPitch(bend.i, (MAX_BEND * Math.abs(dy)) / reach, 0.012);
    kick();
  }

  function endBend() {
    if (!bend) return;
    clearTimeout(bend.timer);
    if (bend.active) {
      bendPitch(bend.i, 0, 0.04);
      kick();
    }
    bend = null;
  }

  canvas.addEventListener('pointerdown', (e) => {
    wake();
    endBend();
    const p = point(e);
    last = p;
    const i = nearest(p.y);
    if (i >= 0) pluck(i, { x: p.x / W, vel: 0.8, touch: e.pointerType === 'touch' });
    if (i >= 0 && Math.abs(ys[i] - p.y) <= gap * 0.35) {
      bend = { i, x: p.x, y: p.y, id: e.pointerId, active: false, timer: 0 };
      // On touch a short hold starts the bend, so a quick swipe still strums.
      if (e.pointerType === 'mouse') startBend();
      else bend.timer = setTimeout(startBend, 180);
    }
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
  });

  canvas.addEventListener('pointermove', (e) => {
    const p = point(e);
    if (bend && bend.id === e.pointerId) {
      if (bend.active) {
        moveBend(p);
        last = p;
        return;
      }
      if (Math.hypot(p.x - bend.x, p.y - bend.y) > 6) endBend();
    }
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
        pluck(i, { x, vel, delay: k * 0.012, touch: e.pointerType === 'touch' });
      });
      // Strumming before the browser allows sound: say how to turn it on.
      if (crossed.length && (!audio || audio.state !== 'running')) hint.classList.add('locked');
    }
    last = p;
  });

  const forget = () => { last = null; };
  canvas.addEventListener('pointerleave', forget);
  canvas.addEventListener('pointercancel', () => { endBend(); forget(); });
  // A long press is a bend, not a request for the browser's menu.
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('selectstart', (e) => e.preventDefault());
  canvas.addEventListener('lostpointercapture', endBend);
  canvas.addEventListener('pointerup', (e) => {
    endBend();
    if (e.pointerType !== 'mouse') forget();
  });

  window.addEventListener('keydown', (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const n = Number(e.key);
    if (n >= 1 && n <= 6) {
      wake();
      pluck(n - 1, { x: 0.5, vel: 0.7 });
    }
  });

  /* ---------- play me something ---------- */

  // Frets per string, low E to high e; -1 means the string isn't played.
  const CHORDS = {
    C: [-1, 3, 2, 0, 1, 0],
    Cmaj7: [-1, 3, 2, 0, 0, 0],
    Cadd9: [-1, 3, 2, 0, 3, 0],
    D: [-1, -1, 0, 2, 3, 2],
    Dsus2: [-1, -1, 0, 2, 3, 0],
    Dm: [-1, -1, 0, 2, 3, 1],
    Dm7: [-1, -1, 0, 2, 1, 1],
    E: [0, 2, 2, 1, 0, 0],
    E7: [0, 2, 0, 1, 0, 0],
    Em: [0, 2, 2, 0, 0, 0],
    Em7: [0, 2, 0, 0, 0, 0],
    F: [-1, -1, 3, 2, 1, 1],
    Fmaj7: [-1, -1, 3, 2, 1, 0],
    G: [3, 2, 0, 0, 0, 3],
    G7: [3, 2, 0, 0, 0, 1],
    A: [-1, 0, 2, 2, 2, 0],
    Asus2: [-1, 0, 2, 2, 0, 0],
    Am: [-1, 0, 2, 2, 1, 0],
    Am7: [-1, 0, 2, 0, 1, 0],
    Bm: [-1, 2, 4, 4, 3, 2],
  };

  // 'b' is the chord's lowest string; numbers are string indexes (0 = low E).
  const PATTERNS = [
    ['b', 3, 4, 5, 4, 3],
    ['b', 3, 4, 3, 5, 3, 4, 3],
    ['b', 2, 3, 4, 5, 4, 3, 2],
    ['b', 4, 3, 5, 3, 4, 3, 5],
    ['b', 3, 5, 3, 4, 3, 5, 3],
    ['b', 2, 3, 4, 5, 3, 4, 2],
  ];

  const SONGS = [
    { chords: ['Am', 'F', 'C', 'G'], pattern: 0, step: 190 },
    { chords: ['C', 'G', 'Am', 'F'], pattern: 1, step: 170 },
    { chords: ['Em', 'C', 'G', 'D'], pattern: 2, step: 160 },
    { chords: ['Am', 'Dm', 'E', 'Am'], pattern: 0, step: 200 },
    { chords: ['Cmaj7', 'Fmaj7'], pattern: 3, step: 210 },
    { chords: ['G', 'Em', 'C', 'D'], pattern: 1, step: 160 },
    { chords: ['Dm', 'Am', 'E7', 'Am'], pattern: 4, step: 180 },
    { chords: ['Am7', 'Dm7', 'G7', 'Cmaj7'], pattern: 2, step: 170 },
    { chords: ['Em', 'Em7', 'Cadd9', 'Dsus2'], pattern: 5, step: 165 },
    { chords: ['D', 'A', 'Bm', 'G'], pattern: 1, step: 170 },
    { chords: ['A', 'Asus2', 'D', 'Dsus2'], pattern: 0, step: 190 },
    { chords: ['Am', 'G', 'F', 'E'], pattern: 3, step: 175 },
    { chords: ['C', 'Am', 'Dm', 'G7'], pattern: 0, step: 185 },
    { chords: ['Em', 'Bm', 'C', 'G'], pattern: 2, step: 165 },
    { chords: ['Fmaj7', 'Em7', 'Dm7', 'Cmaj7'], pattern: 4, step: 190 },
    { chords: ['E', 'A', 'E', 'D'], pattern: 1, step: 160 },
    { chords: ['Cadd9', 'G', 'Em7', 'Dsus2'], pattern: 5, step: 170 },
    { chords: ['Am', 'C', 'D', 'F'], pattern: 0, step: 180 },
    { chords: ['G', 'D', 'Em', 'C'], pattern: 3, step: 165 },
    { chords: ['Bm', 'G', 'D', 'A'], pattern: 4, step: 175 },
  ];

  const LENGTH = 10000;
  let lastSong = -1;
  let timers = [];

  function later(fn, ms) {
    timers.push(setTimeout(fn, ms));
  }

  function noteFor(shape, role) {
    let i = role === 'b' ? shape.findIndex((f) => f >= 0) : role;
    while (i < 6 && shape[i] < 0) i++;
    return i < 6 ? i : -1;
  }

  function playSomething() {
    timers.forEach(clearTimeout);
    timers = [];

    let n;
    do { n = (Math.random() * SONGS.length) | 0; } while (n === lastSong);
    lastSong = n;
    const song = SONGS[n];
    const pattern = PATTERNS[song.pattern];

    playBtn.disabled = true;

    let t = 300;
    let c = 0;
    while (t + pattern.length * song.step <= LENGTH - 1500) {
      const shape = CHORDS[song.chords[c % song.chords.length]];
      pattern.forEach((role, k) => {
        const i = noteFor(shape, role);
        if (i < 0) return;
        const vel = k === 0 ? 0.8 : 0.5 + Math.random() * 0.15;
        later(() => pluck(i, { x: 0.3, vel, glow: true, force: true, fret: shape[i] }), t);
        t += song.step;
      });
      c++;
    }

    // Close on a slow strum of the first chord.
    const home = CHORDS[song.chords[0]];
    home.forEach((fret, i) => {
      if (fret < 0) return;
      later(() => pluck(i, { x: 0.4, vel: 0.6, glow: true, force: true, fret }), t + i * 45);
    });

    later(() => {
      playBtn.disabled = false;
      playBtn.textContent = 'Play me something else';
    }, t + 1600);
  }

  playBtn.addEventListener('click', () => {
    wake();
    playSomething();
  });

  /* ---------- boot ---------- */

  readColors();
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
