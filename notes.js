// notes.js — MIDI parsing, a small piano-ish synth (notes -> WAV), and a built-in demo tune.
// A "note" is { p: midiPitch, t: startSeconds, d: durationSeconds, v: 0..1, tr: 0 (upper hand) | 1 (lower hand) }

export function parseMidi(arrayBuffer) {
  const d = new DataView(arrayBuffer);
  const u8 = new Uint8Array(arrayBuffer);
  const tag = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  if (tag(0) !== 'MThd') throw new Error('This does not look like a MIDI file.');
  const headLen = d.getUint32(4);
  const ntrk = d.getUint16(10);
  const division = d.getUint16(12);
  if (division & 0x8000) throw new Error('SMPTE-timed MIDI files are not supported.');
  const ppq = division;

  let pos = 8 + headLen;
  const tempos = [{ tick: 0, mpq: 500000 }];
  const raw = []; // { tick, on, ch, p, v, trk }

  for (let trk = 0; trk < ntrk && pos + 8 <= u8.length; trk++) {
    if (tag(pos) !== 'MTrk') break;
    const len = d.getUint32(pos + 4);
    let o = pos + 8;
    const end = Math.min(o + len, u8.length);
    let tick = 0;
    let running = 0;
    const vlq = () => {
      let v = 0, b;
      do { b = u8[o++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80 && o < end);
      return v;
    };
    while (o < end) {
      tick += vlq();
      let st = u8[o];
      if (st === 0xff) { // meta
        const type = u8[o + 1]; o += 2;
        const l = vlq();
        if (type === 0x51 && l === 3) tempos.push({ tick, mpq: (u8[o] << 16) | (u8[o + 1] << 8) | u8[o + 2] });
        o += l;
        running = 0;
        continue;
      }
      if (st === 0xf0 || st === 0xf7) { o++; o += vlq(); running = 0; continue; }
      if (st & 0x80) { running = st; o++; } else { st = running; }
      const kind = st & 0xf0, ch = st & 0x0f;
      if (kind === 0x80 || kind === 0x90) {
        const p = u8[o++], v = u8[o++];
        raw.push({ tick, on: kind === 0x90 && v > 0, ch, p, v, trk });
      } else if (kind === 0xc0 || kind === 0xd0) {
        o += 1;
      } else {
        o += 2;
      }
    }
    pos = end;
  }

  // tick -> seconds through the tempo map
  tempos.sort((a, b) => a.tick - b.tick);
  const segs = [];
  let sec = 0;
  for (let i = 0; i < tempos.length; i++) {
    if (i > 0) sec += ((tempos[i].tick - tempos[i - 1].tick) / ppq) * (tempos[i - 1].mpq / 1e6);
    segs.push({ tick: tempos[i].tick, sec, mpq: tempos[i].mpq });
  }
  const toSec = (tick) => {
    let lo = 0, hi = segs.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (segs[m].tick <= tick) lo = m; else hi = m - 1; }
    return segs[lo].sec + ((tick - segs[lo].tick) / ppq) * (segs[lo].mpq / 1e6);
  };

  raw.sort((a, b) => a.tick - b.tick);
  const open = new Map();
  const notes = [];
  for (const e of raw) {
    if (e.ch === 9) continue; // drums
    const key = e.trk * 4096 + e.ch * 128 + e.p;
    if (e.on) {
      if (!open.has(key)) open.set(key, []);
      open.get(key).push(e);
    } else {
      const q = open.get(key);
      if (q && q.length) {
        const s = q.shift();
        const t = toSec(s.tick);
        notes.push({ p: s.p, t, d: Math.max(0.05, toSec(e.tick) - t), v: s.v / 127, tr: s.p >= 60 ? 0 : 1 });
      }
    }
  }
  for (const q of open.values()) for (const s of q) { // notes never released
    const t = toSec(s.tick);
    notes.push({ p: s.p, t, d: 0.5, v: s.v / 127, tr: s.p >= 60 ? 0 : 1 });
  }
  notes.sort((a, b) => a.t - b.t || a.p - b.p);
  if (!notes.length) throw new Error('No notes were found in this MIDI file.');
  return finish(notes);
}

export function finish(notes) {
  let dur = 0;
  for (const n of notes) dur = Math.max(dur, n.t + n.d);
  return { notes, duration: dur };
}

// ---- compact storage ------------------------------------------------------
export function packNotes(notes) {
  const a = new Float32Array(notes.length * 4);
  notes.forEach((n, i) => { a[i * 4] = n.p; a[i * 4 + 1] = n.t; a[i * 4 + 2] = n.d; a[i * 4 + 3] = n.v; });
  return a;
}
export function unpackNotes(a) {
  const out = [];
  for (let i = 0; i < a.length; i += 4) out.push({ p: a[i], t: a[i + 1], d: a[i + 2], v: a[i + 3], tr: a[i] >= 60 ? 0 : 1 });
  return out;
}

// ---- synth: notes -> WAV --------------------------------------------------
export async function renderNotesToWav(notes, duration, sampleRate = 22050) {
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new OAC(1, Math.ceil((duration + 3) * sampleRate), sampleRate);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16; comp.ratio.value = 5; comp.attack.value = 0.003; comp.release.value = 0.2;
  const master = ctx.createGain();
  master.gain.value = 0.55;
  master.connect(comp); comp.connect(ctx.destination);

  const harm = [0, 1, 0.45, 0.22, 0.1, 0.05, 0.025];
  const wave = ctx.createPeriodicWave(new Float32Array(harm.length), Float32Array.from(harm));

  for (const n of notes) {
    const f = 440 * Math.pow(2, (n.p - 69) / 12);
    const t0 = n.t;
    const t1 = n.t + Math.max(n.d, 0.14);
    const peak = 0.2 * (0.3 + 0.7 * n.v) * Math.min(1, 1.55 - n.p / 100);
    const g = ctx.createGain();
    g.connect(master);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.006);
    g.gain.setTargetAtTime(peak * 0.28, t0 + 0.006, 0.45);
    g.gain.setTargetAtTime(0, t1, 0.09);
    const o = ctx.createOscillator();
    o.setPeriodicWave(wave);
    o.frequency.value = f;
    o.connect(g);
    o.start(t0);
    o.stop(t1 + 0.8);
  }
  const buf = await ctx.startRendering();
  return encodeWav(buf.getChannelData(0), sampleRate);
}

export function encodeWav(samples, sampleRate) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) { const a = Math.abs(samples[i]); if (a > peak) peak = a; }
  const gain = peak > 0 ? 0.9 / peak : 1;
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); out.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, sampleRate, true); out.setUint32(28, sampleRate * 2, true);
  out.setUint16(32, 2, true); out.setUint16(34, 16, true); w(36, 'data'); out.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] * gain));
    out.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([out.buffer], { type: 'audio/wav' });
}

// ---- built-in demo (an original little tune: Am - F - C - G) --------------
export function makeDemoNotes() {
  const bpm = 96, beat = 60 / bpm;
  const chords = [
    { root: 45, tones: [57, 60, 64, 69] },  // Am
    { root: 41, tones: [57, 60, 65, 69] },  // F
    { root: 48, tones: [55, 60, 64, 67] },  // C
    { root: 43, tones: [55, 59, 62, 67] },  // G
  ];
  const pattern = [0, 1, 2, 3, 2, 1, 2, 3]; // 8th-note arpeggio
  const notes = [];
  const bars = 16;
  for (let bar = 0; bar < bars; bar++) {
    const c = chords[bar % 4];
    const t = bar * 4 * beat;
    notes.push({ p: c.root, t, d: 2 * beat, v: 0.8, tr: 1 });
    notes.push({ p: c.root + 12, t: t + 2 * beat, d: 2 * beat, v: 0.6, tr: 1 });
    const lift = bar >= 8 ? 12 : 0;
    for (let i = 0; i < 8; i++) {
      const p = c.tones[pattern[i]] + (bar >= 12 && i % 4 === 0 ? 12 : 0) + (bar >= 8 && bar < 12 ? 0 : 0);
      notes.push({ p: p + (lift && i === 7 ? 0 : 0), t: t + i * beat / 2, d: beat / 2 * 0.95, v: 0.55 + 0.3 * (i % 4 === 0), tr: 0 });
    }
    if (bar >= 8) notes.push({ p: c.tones[3] + 12, t: t + 0 * beat, d: 4 * beat * 0.9, v: 0.5, tr: 0 });
  }
  notes.sort((a, b) => a.t - b.t || a.p - b.p);
  return finish(notes);
}

// ---- notes -> standard MIDI file (so a result can be fixed up in other software and re-imported) ----
export function notesToMidi(notes) {
  const ppq = 480, tps = ppq * 2; // 120 bpm -> 960 ticks per second
  const ev = [];
  for (const n of notes) {
    const v = Math.max(1, Math.min(127, Math.round(n.v * 127)));
    ev.push([Math.round(n.t * tps), 1, n.p, v]);
    ev.push([Math.round((n.t + n.d) * tps), 0, n.p, 0]);
  }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const bytes = [0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20];
  const vlq = (v) => { const b = [v & 0x7f]; v >>= 7; while (v) { b.push((v & 0x7f) | 0x80); v >>= 7; } return b.reverse(); };
  let last = 0;
  for (const [t, on, p, v] of ev) { bytes.push(...vlq(t - last), on ? 0x90 : 0x80, p, v); last = t; }
  bytes.push(0x00, 0xff, 0x2f, 0x00);
  const head = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, ppq >> 8, ppq & 255];
  const len = bytes.length;
  const trk = [0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255];
  return new Blob([new Uint8Array([...head, ...trk, ...bytes])], { type: 'audio/midi' });
}
