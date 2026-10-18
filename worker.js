import { audioToNotes } from './analysis.js';

self.onmessage = (e) => {
  const { samples, sr, opts } = e.data;
  try {
    const res = audioToNotes(samples, sr, (p) => self.postMessage({ progress: p }), opts || {});
    self.postMessage({ done: true, notes: res.notes, duration: res.duration });
  } catch (err) {
    self.postMessage({ error: String(err && err.message || err) });
  }
};
