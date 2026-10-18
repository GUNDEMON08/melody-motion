import { MusicScene } from './scene.js';
import { parseMidi, renderNotesToWav, packNotes, unpackNotes, makeDemoNotes, notesToMidi } from './notes.js';

const $ = (s) => document.querySelector(s);
const canvas = $('#gl'), audio = $('#audio');
const toast = (msg, ms = 4200) => { const t = $('#toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(toast.id); toast.id = setTimeout(() => (t.style.display = 'none'), ms); };
const fmt = (s) => { s = Math.max(0, s | 0); return `${(s / 60) | 0}:${String(s % 60).padStart(2, '0')}`; };

// ---------------------------------------------------------------- renderer
let scene;
try { scene = new MusicScene(canvas, { maxDpr: matchMedia('(pointer:coarse)').matches ? 1.5 : 2 }); }
catch (e) { document.body.insertAdjacentHTML('beforeend', `<p style="position:fixed;inset:40% 20px auto;text-align:center">${e.message}</p>`); throw e; }
window.__scene = scene;
addEventListener('resize', () => scene.resize());

// ---------------------------------------------------------------- storage (IndexedDB)
const db = {
  _p: null,
  open() {
    return (this._p ||= new Promise((res, rej) => {
      const r = indexedDB.open('melody-motion', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('songs', { keyPath: 'id' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
  },
  async tx(mode, fn) {
    const d = await this.open();
    return new Promise((res, rej) => {
      const t = d.transaction('songs', mode);
      const out = fn(t.objectStore('songs'));
      t.oncomplete = () => res(out && out.result);
      t.onerror = () => rej(t.error);
    });
  },
  all: () => db.tx('readonly', (s) => s.getAll()),
  get: (id) => db.tx('readonly', (s) => s.get(id)),
  put: (v) => db.tx('readwrite', (s) => s.put(v)),
  del: (id) => db.tx('readwrite', (s) => s.delete(id)),
};

let library = [];
let current = null;   // song record
let objectUrl = null;
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

// ---------------------------------------------------------------- busy overlay
const busy = {
  show(msg, sub = '') { $('#busy').classList.add('open'); $('#busyMsg').textContent = msg; $('#busySub').textContent = sub; $('#busyBar').style.width = '0%'; },
  set(p, sub) { $('#busyBar').style.width = Math.round(p * 100) + '%'; if (sub !== undefined) $('#busySub').textContent = sub; },
  hide() { $('#busy').classList.remove('open'); },
};

// ---------------------------------------------------------------- audio -> notes
async function decodeMono(file) {
  const ab = await file.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC({ sampleRate: 22050 });
  let buf;
  try { buf = await ctx.decodeAudioData(ab.slice(0)); } finally { ctx.close && ctx.close(); }
  const n = buf.length, ch = buf.numberOfChannels;
  let mono = new Float32Array(n);
  for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / ch; }
  let sr = buf.sampleRate;
  if (Math.abs(sr - 22050) > 1) { // browser ignored the requested rate: resample linearly
    const ratio = sr / 22050, m = Math.floor(n / ratio), out = new Float32Array(m);
    for (let i = 0; i < m; i++) { const x = i * ratio, i0 = x | 0, f = x - i0; out[i] = mono[i0] * (1 - f) + (mono[i0 + 1] || 0) * f; }
    mono = out; sr = 22050;
  }
  return { samples: mono, sr, duration: buf.duration };
}

const DETAIL = { melody: { maxVoices: 2, floorMult: 1.6 }, balanced: { maxVoices: 5, floorMult: 1 }, full: { maxVoices: 8, floorMult: 0.7 } };
function analyze(samples, sr, onProgress, opts) {
  return new Promise((resolve, reject) => {
    let w;
    const fallback = async () => {
      const { audioToNotes } = await import('./analysis.js');
      resolve(audioToNotes(samples, sr, onProgress, opts));
    };
    try {
      w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    } catch { return fallback(); }
    w.onmessage = (e) => {
      if (e.data.progress !== undefined) onProgress(e.data.progress);
      else if (e.data.done) { w.terminate(); resolve({ notes: e.data.notes, duration: e.data.duration }); }
      else if (e.data.error) { w.terminate(); reject(new Error(e.data.error)); }
    };
    w.onerror = () => { w.terminate(); fallback().catch(reject); };
    w.postMessage({ samples, sr, opts });
  });
}

// ---------------------------------------------------------------- add songs
let pendingMeta = null; // from a Spotify link

async function addFile(file) {
  const isMidi = /\.midi?$/i.test(file.name) || /midi/.test(file.type);
  const meta = pendingMeta; pendingMeta = null; renderChip();
  const title = (meta && meta.title) || file.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ');
  try {
    busy.show(isMidi ? 'Reading MIDI…' : 'Decoding audio…', title);
    let notes, duration, audioBlob;
    if (isMidi) {
      const r = parseMidi(await file.arrayBuffer());
      notes = r.notes; duration = r.duration;
      busy.show('Rendering piano sound…', `${notes.length} notes`);
      busy.set(0.5);
      audioBlob = await renderNotesToWav(notes, duration);
    } else {
      const dec = await decodeMono(file);
      if (dec.duration > 20 * 60) throw new Error('That file is longer than 20 minutes.');
      busy.show('Finding the notes…', 'Listening to every frame — this can take a little while');
      const r = await analyze(dec.samples, dec.sr, (p) => busy.set(p), DETAIL[$('#detail').value] || DETAIL.balanced);
      notes = r.notes; duration = dec.duration; audioBlob = file;
      if (notes.length < 8) throw new Error('Not enough clear notes were found. Try a solo piano / melodic track, or a MIDI file.');
    }
    const rec = { id: uid(), title, artist: (meta && meta.artist) || (isMidi ? 'MIDI' : ''), cover: (meta && meta.cover) || '', duration, count: notes.length,
      notes: packNotes(notes), audio: audioBlob, mime: audioBlob.type || file.type, created: Date.now() };
    await db.put(rec);
    await refreshLibrary();
    busy.hide();
    closePanel();
    await openSong(rec.id, true);
  } catch (err) {
    busy.hide();
    console.error(err);
    toast(err.message || 'Could not convert that file.');
  }
}

async function addDemo() {
  busy.show('Building the demo…');
  const r = makeDemoNotes();
  const blob = await renderNotesToWav(r.notes, r.duration);
  const rec = { id: uid(), title: 'Demo Tune', artist: 'Melody Motion', cover: '', duration: r.duration, count: r.notes.length, notes: packNotes(r.notes), audio: blob, mime: 'audio/wav', created: Date.now() };
  await db.put(rec);
  await refreshLibrary();
  busy.hide(); closePanel();
  await openSong(rec.id, true);
}

// Spotify link -> title + cover only (audio can never come from Spotify)
function renderChip() {
  const el = $('#spChip');
  if (!pendingMeta) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="chip">${pendingMeta.cover ? `<img src="${pendingMeta.cover}" alt="">` : ''}<div><b>${esc(pendingMeta.title)}</b><br><span style="color:var(--muted);font-size:12px">Now add the audio or MIDI file for this song ↑</span></div><button class="btn x" id="chipX">✕</button></div>`;
  $('#chipX').onclick = () => { pendingMeta = null; renderChip(); };
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function useSpotify() {
  const url = $('#spUrl').value.trim();
  if (!/open\.spotify\.com\/(intl-[a-z]+\/)?track\//i.test(url)) { toast('Paste a link like open.spotify.com/track/…'); return; }
  if (!navigator.onLine) { toast('You are offline — the link lookup needs internet. You can still add a file.'); return; }
  try {
    const r = await fetch('https://open.spotify.com/oembed?url=' + encodeURIComponent(url));
    if (!r.ok) throw new Error('lookup failed');
    const j = await r.json();
    let cover = '';
    try { const b = await (await fetch(j.thumbnail_url)).blob(); cover = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); }); } catch { cover = j.thumbnail_url || ''; }
    pendingMeta = { title: j.title || 'Spotify track', artist: 'Spotify', cover };
    renderChip();
  } catch { toast('Could not read that Spotify link. You can still add your file — it will use the file name.'); }
}

function saveBlob(blob, name) {
  const u = URL.createObjectURL(blob), el = document.createElement('a');
  el.href = u; el.download = name; document.body.appendChild(el); el.click(); el.remove();
  setTimeout(() => URL.revokeObjectURL(u), 10000);
}

// ---------------------------------------------------------------- library UI
async function refreshLibrary() {
  library = (await db.all()).sort((a, b) => b.created - a.created);
  const el = $('#list');
  if (!library.length) { el.innerHTML = '<p>Nothing here yet — add a file above, or try the demo tune.</p>'; }
  else el.innerHTML = library.map((s) => `
    <div class="song ${current && current.id === s.id ? 'cur' : ''}" data-id="${s.id}">
      <div class="cv">${s.cover ? `<img src="${s.cover}" alt="">` : '♪'}</div>
      <div class="m"><b>${esc(s.title)}</b><span>${fmt(s.duration)} · ${s.count} notes${s.artist ? ' · ' + esc(s.artist) : ''}</span></div>
      <button data-act="play" aria-label="Play">▶</button><button data-act="midi" aria-label="Download as MIDI" title="Download notes as MIDI">MIDI</button><button data-act="del" aria-label="Delete">🗑</button>
    </div>`).join('');
  updateNet();
}
$('#list').addEventListener('click', async (e) => {
  const row = e.target.closest('.song'); if (!row) return;
  const id = row.dataset.id, act = e.target.closest('button') && e.target.closest('button').dataset.act;
  if (act === 'midi') {
    const rec = library.find((s) => s.id === id);
    if (rec) saveBlob(notesToMidi(unpackNotes(rec.notes)), rec.title.replace(/[^\w\- ]+/g, '') + '.mid');
    return;
  }
  if (act === 'del') {
    if (!confirm('Delete this song from your device?')) return;
    await db.del(id);
    if (current && current.id === id) { audio.pause(); current = null; audio.removeAttribute('src'); scene.setSong([], 0); setCaption('', ''); }
    await refreshLibrary();
  } else { closePanel(); openSong(id, true); }
});

function openPanel() { $('#panel').classList.add('open'); refreshLibrary(); updateStorageInfo(); }
function closePanel() { $('#panel').classList.remove('open'); }
$('#openLib').onclick = openPanel; $('#closeLib').onclick = closePanel;
$('#panel').addEventListener('pointerdown', (e) => { if (e.target.id === 'panel') closePanel(); });
$('#pick').onclick = () => $('#file').click();
$('#file').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) addFile(f); };
$('#spGo').onclick = useSpotify;
$('#spUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') useSpotify(); });
$('#demo').onclick = addDemo;
const drop = $('#drop');
['dragenter', 'dragover'].forEach((ev) => addEventListener(ev, (e) => { e.preventDefault(); if ($('#panel').classList.contains('open')) drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
addEventListener('drop', (e) => { const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) addFile(f); });

// settings
const prefs = (() => { try { return JSON.parse(localStorage.getItem('mm-prefs') || '{}'); } catch { return {}; } })();
const savePrefs = () => { try { localStorage.setItem('mm-prefs', JSON.stringify(prefs)); } catch {} };
$('#guess').checked = !!prefs.guess; $('#lowfx').checked = !!prefs.lowfx;
$('#guess').onchange = (e) => { prefs.guess = e.target.checked; savePrefs(); };
$('#lowfx').onchange = (e) => { prefs.lowfx = e.target.checked; savePrefs(); applyFx(); };
$('#palette').value = prefs.palette || 'google'; scene.setPalette($('#palette').value);
$('#palette').onchange = (e) => { prefs.palette = e.target.value; savePrefs(); scene.setPalette(e.target.value); };
$('#detail').value = prefs.detail || 'balanced';
$('#detail').onchange = (e) => { prefs.detail = e.target.value; savePrefs(); };
$('#loop').checked = !!prefs.loop; audio.loop = !!prefs.loop;
$('#loop').onchange = (e) => { prefs.loop = e.target.checked; savePrefs(); audio.loop = e.target.checked; };
$('#speed').onchange = (e) => { audio.defaultPlaybackRate = audio.playbackRate = +e.target.value; };
function applyFx() { scene.maxDpr = prefs.lowfx ? 1 : (matchMedia('(pointer:coarse)').matches ? 1.5 : 2); scene.bloom = prefs.lowfx ? 0.7 : 1; scene.resize(); }
applyFx();

async function updateStorageInfo() {
  let s = '';
  try {
    if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); s = `Stored on this device: ${(e.usage / 1048576).toFixed(1)} MB used`; }
    if (navigator.storage && navigator.storage.persisted && !(await navigator.storage.persisted()) && navigator.storage.persist) { const ok = await navigator.storage.persist(); s += ok ? ' · protected from auto-clean' : ''; }
  } catch {}
  $('#storeInfo').textContent = s;
}

// ---------------------------------------------------------------- player
let exporter = null;
let vt = 0, lastNow = performance.now(), seekedFlag = false, pipActive = false, rafId = 0, timerId = 0, capMode = '';
const seek = $('#seek');

function setCaption(t, a) { $('#capT').textContent = t; $('#capA').textContent = a; }
function updateCaption() {
  if (!current) return;
  let showTitle = true;
  if (prefs.guess) showTitle = vt > Math.min(18, current.duration * 0.3) || audio.ended;
  const mode = showTitle ? 'title' : 'guess';
  if (mode !== capMode) {
    capMode = mode;
    const t = $('#capT'), a = $('#capA');
    t.style.opacity = a.style.opacity = 0;
    setTimeout(() => { if (mode === 'title') { t.textContent = current.title; a.textContent = current.artist || ''; } else { t.textContent = 'Can you name this song?'; a.textContent = ''; } t.style.opacity = a.style.opacity = 1; }, 450);
  }
}

async function openSong(id, autoplay) {
  const rec = library.find((s) => s.id === id) || (await db.get(id));
  if (!rec) return;
  audio.pause();
  current = rec;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(rec.audio);
  audio.src = objectUrl;
  audio.load();
  scene.setSong(unpackNotes(rec.notes), rec.duration);
  vt = 0; capMode = ''; updateCaption();
  try { localStorage.setItem('mm-last', id); } catch {}
  setMediaSession();
  refreshLibrary();
  if (autoplay) { try { await audio.play(); } catch { toast('Tap play to start.'); } }
}
function step(dir) {
  if (!library.length) return;
  const i = Math.max(0, library.findIndex((s) => current && s.id === current.id));
  openSong(library[(i + dir + library.length) % library.length].id, true);
}
$('#prev').onclick = () => { if (audio.currentTime > 3) audio.currentTime = 0; else step(-1); };
$('#next').onclick = () => step(1);
$('#play').onclick = () => { if (!current) { openPanel(); return; } audio.paused ? audio.play() : audio.pause(); };
audio.addEventListener('ended', () => { if (library.length > 1) step(1); });
const PLAY = '<path d="M8 5v14l11-7z"/>', PAUSE = '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/>';
function syncPlayIcon() { $('#playIcon').innerHTML = audio.paused ? PLAY : PAUSE; if ('mediaSession' in navigator) navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing'; if (!audio.paused) keepAwake(); }
audio.addEventListener('play', syncPlayIcon); audio.addEventListener('pause', syncPlayIcon);
audio.addEventListener('seeking', () => { seekedFlag = true; });

let dragging = false;
seek.addEventListener('input', () => { dragging = true; if (current) { audio.currentTime = (seek.value / 1000) * current.duration; } paintSeek(); });
seek.addEventListener('change', () => { dragging = false; });
function paintSeek() { seek.style.setProperty('--p', seek.value / 10 + '%'); }
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
  if (e.code === 'Space') { e.preventDefault(); $('#play').click(); }
  else if (e.code === 'ArrowRight') audio.currentTime += 5;
  else if (e.code === 'ArrowLeft') audio.currentTime -= 5;
  else if (e.key === 'f') toggleFs();
});

// Media Session: lock-screen / notification controls, and keeps the OS treating this as a media app
function setMediaSession() {
  if (!('mediaSession' in navigator) || !current) return;
  const art = current.cover && current.cover.startsWith('data:') ? [{ src: current.cover, sizes: '300x300' }] : [{ src: 'icon-512.png', sizes: '512x512', type: 'image/png' }];
  navigator.mediaSession.metadata = new MediaMetadata({ title: current.title, artist: current.artist || 'Melody Motion', album: 'Melody Motion', artwork: art });
  const h = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch {} };
  h('play', () => audio.play()); h('pause', () => audio.pause());
  h('previoustrack', () => step(-1)); h('nexttrack', () => step(1));
  h('seekbackward', (d) => { audio.currentTime = Math.max(0, audio.currentTime - ((d && d.seekOffset) || 10)); });
  h('seekforward', (d) => { audio.currentTime = Math.min(audio.duration || 1e9, audio.currentTime + ((d && d.seekOffset) || 10)); });
  h('seekto', (d) => { audio.currentTime = d.seekTime; });
}
let lastPos = 0;
function updatePosition() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState || !isFinite(audio.duration)) return;
  const now = performance.now(); if (now - lastPos < 1000) return; lastPos = now;
  try { navigator.mediaSession.setPositionState({ duration: audio.duration, position: Math.min(audio.currentTime, audio.duration), playbackRate: audio.playbackRate }); } catch {}
}

// keep the screen on while the animation is visible
let wake = null;
async function keepAwake() { try { if ('wakeLock' in navigator && !wake && !document.hidden) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => (wake = null)); } } catch {} }

// ---------------------------------------------------------------- frame loop
function frame() {
  const now = performance.now(), dt = (now - lastNow) / 1000; lastNow = now;
  const ct = audio.currentTime, playing = !audio.paused && !audio.ended && audio.readyState > 2;
  let seeked = seekedFlag; seekedFlag = false;
  if (playing) {
    vt += dt * audio.playbackRate;
    const err = ct - vt;
    if (Math.abs(err) > 0.25) { vt = ct; seeked = true; } else vt += err * 0.12;
  } else if (Math.abs(ct - vt) > 0.005) { vt = ct; seeked = true; }
  scene.render(vt, dt, playing, seeked);
  if (exporter) exporter.frame();
  if (current) {
    $('#tCur').textContent = fmt(ct); $('#tDur').textContent = fmt(current.duration);
    if (!dragging) { seek.value = Math.round((ct / Math.max(1, current.duration)) * 1000); paintSeek(); }
    updateCaption(); updatePosition();
  }
}
function tick() { try { frame(); } catch (e) { console.error(e); return; } schedule(); }
function schedule() {
  cancelAnimationFrame(rafId); clearTimeout(timerId);
  if (!document.hidden) rafId = requestAnimationFrame(tick);
  else if (pipActive) timerId = setTimeout(tick, 33); // keeps drawing into the pop-out window
}
document.addEventListener('visibilitychange', () => { lastNow = performance.now(); if (!document.hidden) keepAwake(); schedule(); });
schedule();

// ---------------------------------------------------------------- pop-out window (Picture-in-Picture)
const pipBtn = $('#pip');
if (document.pictureInPictureEnabled && canvas.captureStream) {
  pipBtn.style.display = '';
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none';
  document.body.appendChild(v);
  v.addEventListener('leavepictureinpicture', () => { pipActive = false; });
  pipBtn.onclick = async () => {
    try {
      if (document.pictureInPictureElement) { await document.exitPictureInPicture(); return; }
      if (!v.srcObject) v.srcObject = canvas.captureStream(30);
      await v.play();
      await v.requestPictureInPicture();
      pipActive = true;
    } catch (e) { toast('Pop-out is not available in this browser.'); }
  };
}

// full screen
function toggleFs() { if (document.fullscreenElement) document.exitFullscreen(); else (document.documentElement.requestFullscreen || (() => {})).call(document.documentElement); }
$('#fs').onclick = toggleFs;
if (!document.documentElement.requestFullscreen) $('#fs').style.display = 'none';

// ---------------------------------------------------------------- calm mode: controls fade while music plays
let idleTimer;
function wakeUi() {
  document.body.classList.remove('idle'); clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!audio.paused && !$('#panel').classList.contains('open')) document.body.classList.add('idle'); }, 3500);
}
['pointermove', 'pointerdown', 'keydown', 'touchstart'].forEach((ev) => addEventListener(ev, wakeUi, { passive: true }));
audio.addEventListener('play', wakeUi); audio.addEventListener('pause', wakeUi);

// ---------------------------------------------------------------- video export
const canRecord = !!(window.MediaRecorder && HTMLCanvasElement.prototype.captureStream && audio.captureStream);
if (!canRecord) { $('#xGo').disabled = true; $('#xHelp').textContent = 'Video recording is not supported in this browser. Try Chrome, Edge or Firefox on a computer or Android phone.'; }
$('#xGo').onclick = startExport;
$('#rClose').onclick = () => { $('#result').classList.remove('open'); const v = $('#rVid'); v.pause(); if (v.src) URL.revokeObjectURL(v.src); v.removeAttribute('src'); };

async function startExport() {
  if (!current || exporter) { if (!current) toast('Add or open a song first.'); return; }
  const SIZES = { reel: [720, 1280], square: [810, 810], wide: [1280, 720] };
  const [W, H] = SIZES[$('#xPreset').value];
  const lenSel = +$('#xLen').value;
  const start = audio.currentTime > current.duration - 5 ? 0 : audio.currentTime;
  const end = lenSel ? Math.min(current.duration, start + lenSel) : current.duration;
  const wasLoop = audio.loop; audio.loop = false;
  closePanel();
  document.body.classList.add('exporting');
  const fit = Math.min(innerWidth / W, (innerHeight - 70) / H, 1);
  canvas.style.cssText = `inset:auto;width:${W}px;height:${H}px;left:${(innerWidth - W * fit) / 2}px;top:${Math.max(8, (innerHeight - 70 - H * fit) / 2)}px;transform-origin:0 0;transform:scale(${fit})`;
  scene.fixedDpr = 1; scene.resize();

  const rec = document.createElement('canvas'); rec.width = W; rec.height = H;
  const rc = rec.getContext('2d');
  const guessUntil = Math.min(18, current.duration * 0.3);
  const drawCaption = (t) => {
    const showTitle = !prefs.guess || t > guessUntil;
    const text = showTitle ? current.title : 'Can you name this song?';
    const sub = showTitle ? (current.artist || '') : '';
    const fade = Math.min(1, (t - start) / 1.2, (end - t) / 0.8 + 0.01);
    let size = Math.round(Math.min(W, H) * 0.065);
    rc.textAlign = 'center'; rc.textBaseline = 'alphabetic';
    do { rc.font = `small-caps ${size}px Georgia, "Times New Roman", serif`; size -= 2; } while (rc.measureText(text).width > W * 0.88 && size > 14);
    rc.save(); rc.globalAlpha = Math.max(0, fade); rc.shadowColor = '#000'; rc.shadowBlur = 18; rc.fillStyle = '#eef2fa';
    const y = H * (H > W ? 0.86 : 0.88);
    rc.fillText(text, W / 2, y);
    if (sub) { rc.font = `small-caps ${Math.round(size * 0.55)}px Georgia, serif`; rc.globalAlpha *= 0.75; rc.fillText(sub, W / 2, y + size * 0.9); }
    rc.restore();
  };

  const types = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  const mime = types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  const st = { cancelled: false, done: false };
  const chunks = [];
  let recorder;

  const cleanup = () => {
    exporter = null;
    document.body.classList.remove('exporting');
    canvas.removeAttribute('style');
    scene.fixedDpr = 0; scene.resize();
    audio.loop = wasLoop;
  };
  const stop = () => { if (st.done) return; st.done = true; audio.pause(); try { recorder.stop(); } catch { cleanup(); } };
  $('#xCancel').onclick = () => { st.cancelled = true; stop(); };

  try {
    audio.currentTime = start; vt = start; seekedFlag = true;
    let astream = audio.captureStream();
    if (!astream.getAudioTracks().length) { await audio.play(); await new Promise((r) => setTimeout(r, 400)); astream = audio.captureStream(); audio.pause(); audio.currentTime = start; vt = start; await new Promise((r) => setTimeout(r, 150)); }
    const vstream = rec.captureStream(30);
    const stream = new MediaStream([...vstream.getVideoTracks(), ...astream.getAudioTracks()]);
    recorder = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: 7e6, audioBitsPerSecond: 160000 });
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      const cancelled = st.cancelled;
      cleanup();
      if (cancelled) { toast('Recording cancelled.'); return; }
      const type = (recorder.mimeType || mime || 'video/webm').split(';')[0];
      const blob = new Blob(chunks, { type });
      if (blob.size < 2000) { toast('The recording came out empty. Try again with the tab in front.'); return; }
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      const name = current.title.replace(/[^\w\- ]+/g, '').trim() || 'melody-motion';
      const url = URL.createObjectURL(blob);
      $('#rVid').src = url; $('#rDl').href = url; $('#rDl').download = `${name}.${ext}`;
      const file = new File([blob], `${name}.${ext}`, { type });
      const canShare = navigator.canShare && navigator.canShare({ files: [file] });
      $('#rShare').hidden = !canShare;
      $('#rShare').onclick = () => navigator.share({ files: [file], title: current.title }).catch(() => {});
      $('#result').classList.add('open');
    };
    recorder.start(250);
    await audio.play();
    exporter = {
      frame() {
        const t = audio.currentTime;
        rc.drawImage(canvas, 0, 0, W, H);
        drawCaption(t);
        $('#xTxt').textContent = `Recording ${fmt(t - start)} / ${fmt(end - start)}`;
        if (t >= end - 0.03 || audio.ended) stop();
      },
    };
  } catch (err) {
    console.error(err); st.done = true; cleanup(); toast('Could not start recording: ' + (err.message || err));
  }
}

// ---------------------------------------------------------------- install + offline
let deferred;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; $('#install').style.display = ''; });
$('#install').onclick = async () => { if (deferred) { deferred.prompt(); await deferred.userChoice; deferred = null; $('#install').style.display = 'none'; } };
addEventListener('appinstalled', () => { $('#install').style.display = 'none'; });

let swReady = false;
function updateNet() {
  const el = $('#net');
  if (!navigator.onLine) el.textContent = 'Offline';
  else el.textContent = swReady && library.length ? 'Offline-ready' : '';
}
addEventListener('online', updateNet); addEventListener('offline', updateNet);
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready).then(() => { swReady = true; updateNet(); }).catch(() => {});
}

// ---------------------------------------------------------------- boot
(async () => {
  try { await refreshLibrary(); } catch (e) { toast('Saved songs are unavailable in this browser mode.'); }
  let last = null; try { last = localStorage.getItem('mm-last'); } catch {}
  const pick = library.find((s) => s.id === last) || library[0];
  if (pick) openSong(pick.id, false); else openPanel();
  syncPlayIcon();
})();
