// analysis.js — turns decoded mono audio into notes, entirely in the browser (no models, no network).
// Method: windowed FFT -> spectral peaks snapped to semitones -> harmonic suppression ->
// per-pitch tracking into note events. Works best on piano / guitar / clear melodic music.

class FFT {
  constructor(n) {
    this.n = n;
    this.rev = new Uint32Array(n);
    this.cos = new Float32Array(n / 2);
    this.sin = new Float32Array(n / 2);
    const bits = Math.log2(n) | 0;
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
      this.rev[i] = r;
    }
    for (let i = 0; i < n / 2; i++) { this.cos[i] = Math.cos((2 * Math.PI * i) / n); this.sin[i] = -Math.sin((2 * Math.PI * i) / n); }
  }
  transform(re, im) {
    const n = this.n, rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j, b = a + half;
          const tr = re[b] * this.cos[k] - im[b] * this.sin[k];
          const ti = re[b] * this.sin[k] + im[b] * this.cos[k];
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  }
}

const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

export function audioToNotes(samples, sr, onProgress = () => {}, opts = {}) {
  const maxVoices = opts.maxVoices || 6, floorMult = opts.floorMult || 1;
  const N = 4096, HOP = 512;
  const fft = new FFT(N);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const nFrames = Math.max(0, Math.floor((samples.length - N) / HOP) + 1);
  const binHz = sr / N;
  const kLo = Math.max(2, Math.floor(midiHz(36) / binHz));
  const kHi = Math.min(N / 2 - 3, Math.ceil(midiHz(100) / binHz) + 1);
  const re = new Float32Array(N), im = new Float32Array(N), mag = new Float32Array(N / 2);

  const framePitch = new Array(nFrames);
  const frameVal = new Array(nFrames);
  const frameMax = new Float32Array(nFrames);

  // pass 1: spectral peaks per frame
  for (let f = 0; f < nFrames; f++) {
    const off = f * HOP;
    for (let i = 0; i < N; i++) { re[i] = samples[off + i] * win[i]; im[i] = 0; }
    fft.transform(re, im);
    let fm = 0;
    for (let k = kLo - 1; k <= kHi + 1; k++) { const m = Math.hypot(re[k], im[k]); mag[k] = m; if (m > fm) fm = m; }
    frameMax[f] = fm;
    const peaks = new Map();
    const thr = fm * 0.1;
    for (let k = kLo; k <= kHi; k++) {
      const m0 = mag[k];
      if (m0 < thr || m0 <= mag[k - 1] || m0 < mag[k + 1]) continue;
      const a = mag[k - 1], c = mag[k + 1];
      const den = a - 2 * m0 + c;
      const delta = den !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
      const midi = 69 + 12 * Math.log2(((k + delta) * binHz) / 440);
      const p = Math.round(midi);
      if (Math.abs(midi - p) > 0.4 || p < 36 || p > 100) continue;
      if (!peaks.has(p) || peaks.get(p) < m0) peaks.set(p, m0);
    }
    // suppress harmonics of lower, stronger peaks
    const list = [...peaks.entries()].sort((x, y) => x[0] - y[0]);
    const kept = [];
    for (const [p, v] of list) {
      let harmonic = false;
      for (const [q, w] of kept) {
        const dlt = p - q;
        if ((dlt === 12 && w > 0.6 * v) || ((dlt === 19 || dlt === 24 || dlt === 28) && w > 1.2 * v)) { harmonic = true; break; }
      }
      if (!harmonic) kept.push([p, v]);
    }
    kept.sort((x, y) => y[1] - x[1]);
    const top = kept.slice(0, maxVoices);
    framePitch[f] = top.map((e) => e[0]);
    frameVal[f] = top.map((e) => e[1]);
    if (f % 200 === 0) onProgress((f / nFrames) * 0.9);
  }

  // reference loudness = 90th percentile of the per-frame maxima
  const sorted = Float32Array.from(frameMax).sort();
  const ref = sorted.length ? sorted[Math.floor(sorted.length * 0.9)] : 1;
  const floor = ref * 0.12 * floorMult;

  // pass 2: track pitches over time into notes
  const GAP = 3, MIN_FRAMES = 4;
  const start = new Int32Array(128).fill(-1);
  const last = new Int32Array(128).fill(-1);
  const peakV = new Float32Array(128);
  const smooth = new Float32Array(128);
  const notes = [];
  const tOf = (f) => (f * HOP + 0.65 * N) / sr; // onset sits near the leading edge of the window (calibrated on synthetic data)
  const close = (p, endFrame) => {
    const s = start[p];
    if (s >= 0 && last[p] - s + 1 >= MIN_FRAMES) {
      const t = Math.max(0, tOf(s) - 0.02);
      const d = Math.max(0.08, tOf(endFrame) - 0.02 - t);
      notes.push({ p, t, d, v: Math.min(1, 0.3 + 0.7 * (peakV[p] / ref)), tr: p >= 60 ? 0 : 1 });
    }
    start[p] = -1;
  };
  for (let f = 0; f < nFrames; f++) {
    const seen = new Set();
    const ps = framePitch[f], vs = frameVal[f];
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i], v = vs[i];
      if (v < floor) continue;
      seen.add(p);
      if (start[p] >= 0 && f - last[p] <= GAP) {
        // re-attack of the same pitch (sudden jump in energy) starts a new note
        if (v > 2.3 * smooth[p] && f - start[p] >= 6 && smooth[p] > 0) { close(p, f); start[p] = f; peakV[p] = v; }
        last[p] = f; peakV[p] = Math.max(peakV[p], v);
      } else {
        if (start[p] >= 0) close(p, last[p] + 1);
        start[p] = f; last[p] = f; peakV[p] = v;
      }
      smooth[p] = smooth[p] ? 0.7 * smooth[p] + 0.3 * v : v;
    }
    for (let p = 36; p <= 100; p++) {
      if (!seen.has(p)) {
        smooth[p] *= 0.85;
        if (start[p] >= 0 && f - last[p] > GAP) close(p, last[p] + 1);
      }
    }
  }
  for (let p = 36; p <= 100; p++) if (start[p] >= 0) close(p, last[p] + 1);

  notes.sort((a, b) => a.t - b.t || a.p - b.p);
  onProgress(1);
  let duration = samples.length / sr;
  return { notes, duration };
}
