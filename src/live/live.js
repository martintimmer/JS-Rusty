// Live camera mode. The phone camera is shown full screen in portrait, with a live preview of the chosen palette and
// algorithm at a 480-pixel short side. A strip at the top changes the palette and the algorithm (the same settings as
// the editor). The camera switch button cycles through the lenses the browser exposes. A tap on the picture focuses
// where the browser allows it. Holding the record button records the plain camera picture for up to 10 seconds into
// the clip library on this device. Opening a clip hands it to the normal video path in app.js. Nothing is uploaded.

import { createArtwork } from '../rendering/artwork.js';
import { DT_PALETTE_LIBRARY } from '../rendering/dither/palettes.js';
import { pickMp4Mime, pickWebmMime } from '../export/video-exporter.js';
import { formatBytes } from '../ui.js';
import {
  cameraSupported, listCameras, openLens, stopCamera, cameraError, isFrontLabel, lensName,
} from './camera.js';
import { saveClip, listClips, getClip, deleteClip, storageEstimate } from './clip-store.js';

// The preview's short side in pixels: 854×480 for a landscape camera, 480×854 for a portrait one.
const PREVIEW_SHORT_SIDE = 480;
// Recording stops at this length. A press shorter than the minimum is not kept.
const RECORD_SECONDS = 10;
const MIN_RECORD_SECONDS = 0.3;
const RECORD_BITS_PER_SECOND = 8000000;

// Live mode opens with this palette (the six-colour Apple II hi-res palette). The strip starts with it and with the
// Classic Mac OS palette, then the other presets.
const FORCED_PALETTE = 'apple-ii';
const STRIP_PALETTES_FIRST = ['apple-ii', 'classic-mac'];

// The algorithms, in the order of the sidebar.
const ALGORITHMS = [
  { id: 'dither', label: 'Dither' },
  { id: 'waves', label: 'Wave lines' },
  { id: 'oil', label: 'Oil paint' },
  { id: 'halftone', label: 'Halftone' },
  { id: 'ascii', label: 'ASCII' },
  { id: 'lowpoly', label: 'Low poly' },
  { id: 'engraving', label: 'Engraving' },
  { id: 'stippling', label: 'Stippling' },
  { id: 'contour', label: 'Contour' },
  { id: 'contour-drawing', label: 'Contour drawing' },
  { id: 'pencil', label: 'Pencil sketch' },
  { id: 'linocut', label: 'Linocut' },
  { id: 'sort', label: 'Pixel sort' },
];

// Until the camera list is known (before the first permission), two lenses: the rear camera and the front camera.
const DEFAULT_LENSES = [
  { facing: 'environment', name: '1×', front: false },
  { facing: 'user', name: 'Front', front: true },
];

const $ = (id) => document.getElementById(id);

const live = {
  options: null,
  open: false,
  starting: false,
  switching: false,
  stream: null,
  video: null,
  canvas: null,
  stage: null,
  grabCtx: null,
  W: 0,
  H: 0,
  data: null,
  art: null,
  firstFrame: true,
  startedAt: 0,
  gen: 0,
  scheduled: false,
  frames: 0,
  fpsSince: 0,
  renderMs: 0,
  mirror: false,
  lenses: DEFAULT_LENSES.slice(),
  lensIndex: 0,
  lensesKnown: false,
  focusTimer: 0,
  recorder: null,
  recStart: 0,
  recTimer: 0,
  recStop: 0,
  wake: null,
};

let statusTimer = 0;

// options: getParams() returns the current settings; setParam(key, value) changes one (the same as the editor's
// controls); onOpenClip(file) opens a clip in the normal editor.
export function initLive(options) {
  live.options = options;
  live.video = $('live-video');
  live.canvas = $('live-canvas');
  live.stage = $('live-stage');
  const supported = cameraSupported() && window.isSecureContext;
  const openButton = $('btn-live');
  openButton.disabled = !supported;
  openButton.title = supported
    ? 'Record from the camera with a live dithered preview'
    : 'Live needs a camera and a secure (https) page';
  openButton.addEventListener('click', openLive);
  $('live-close').addEventListener('click', () => closeLive(false));
  $('live-switch').addEventListener('click', switchCamera);
  $('live-library').addEventListener('click', openLibrary);
  live.stage.addEventListener('pointerdown', onStageTap);
  const record = $('live-record');
  record.addEventListener('pointerdown', onRecordDown);
  record.addEventListener('pointerup', stopRecording);
  record.addEventListener('pointercancel', stopRecording);
  record.addEventListener('lostpointercapture', stopRecording);
  record.addEventListener('contextmenu', (e) => e.preventDefault());
  $('clip-close').addEventListener('click', closeLibrary);
  $('clip-library').addEventListener('click', (e) => {
    if (e.target === $('clip-library')) closeLibrary();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('clip-library').hidden) closeLibrary();
    else if (live.open) closeLive(false);
  });
  // A phone that leaves the page stops its camera. A recording in progress is kept before the screen closes.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && live.open) {
      stopRecording();
      closeLive(true);
    }
  });
  buildStrip();
  updateLensButton();
  updateTimer();
}

export function isLiveOpen() {
  return live.open;
}

// ---------- The strip of palettes and algorithms ----------

function stripPalettes() {
  const first = STRIP_PALETTES_FIRST
    .map((id) => DT_PALETTE_LIBRARY.find((p) => p.id === id))
    .filter(Boolean);
  const rest = DT_PALETTE_LIBRARY.filter((p) => STRIP_PALETTES_FIRST.indexOf(p.id) < 0);
  return first.concat(rest, [{ id: 'paper-ink', name: 'Paper and ink' }]);
}

function buildStrip() {
  const strip = $('live-strip');
  strip.textContent = '';
  for (const palette of stripPalettes()) strip.appendChild(stripChip(palette.name, 'palette', palette.id));
  const separator = document.createElement('span');
  separator.className = 'live-strip-sep';
  separator.setAttribute('aria-hidden', 'true');
  strip.appendChild(separator);
  for (const algorithm of ALGORITHMS) strip.appendChild(stripChip(algorithm.label, 'algorithm', algorithm.id));
  updateStrip();
}

function stripChip(label, kind, id) {
  const chip = el('button', 'live-chip', label);
  chip.type = 'button';
  chip.dataset.kind = kind;
  chip.dataset.id = id;
  chip.addEventListener('click', () => {
    live.options.setParam(kind === 'palette' ? 'dtPalette' : 'algorithm', id);
    updateStrip();
  });
  return chip;
}

// Marks the palette and the algorithm in use.
function updateStrip() {
  const p = live.options.getParams();
  for (const chip of $('live-strip').querySelectorAll('.live-chip')) {
    const on = chip.dataset.kind === 'palette' ? p.dtPalette === chip.dataset.id : p.algorithm === chip.dataset.id;
    chip.classList.toggle('active', on);
    chip.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}

// ---------- Opening and closing ----------

async function openLive() {
  if (live.open || !cameraSupported()) return;
  live.open = true;
  live.starting = true;
  live.startedAt = performance.now();
  live.frames = 0;
  live.fpsSince = live.startedAt;
  live.lensIndex = 0;
  $('live-screen').hidden = false;
  if (live.options.getParams().dtPalette !== FORCED_PALETTE) live.options.setParam('dtPalette', FORCED_PALETTE);
  updateStrip();
  updateLensButton();
  setLiveStatus('Starting the camera…', false);
  holdScreenAwake();
  try {
    if (!(await startLens(live.lenses[live.lensIndex]))) return;
  } catch (err) {
    setLiveStatus(cameraError(err), true);
    return;
  }
  attachStream();
  refreshLenses();
}

// Closes live mode and stops the camera. A recording in progress keeps the screen open, unless force is set.
function closeLive(force) {
  if (!live.open) return;
  if (live.recorder && !force) return;
  live.open = false;
  live.starting = false;
  live.gen++;
  live.scheduled = false;
  stopCamera(live.stream);
  live.stream = null;
  live.video.srcObject = null;
  releaseScreen();
  $('live-screen').hidden = true;
  setLiveStatus(null);
}

// Opens a lens. Returns false when live mode was closed while the camera was opening.
async function startLens(lens) {
  const stream = await openLens(lens);
  if (!live.open) {
    stopCamera(stream);
    return false;
  }
  live.stream = stream;
  live.mirror = !!lens.front;
  return true;
}

// The camera switch button cycles through the lenses.
async function switchCamera() {
  if (!live.open || live.recorder || live.switching) return;
  live.switching = true;
  live.lensIndex = (live.lensIndex + 1) % live.lenses.length;
  const lens = live.lenses[live.lensIndex];
  stopCamera(live.stream);
  live.stream = null;
  live.video.srcObject = null;
  live.starting = true;
  updateLensButton();
  setLiveStatus('Switching to ' + lens.name + '…', false);
  try {
    const ok = await startLens(lens);
    live.switching = false;
    if (!ok) return;
  } catch (err) {
    live.switching = false;
    setLiveStatus(cameraError(err), true);
    return;
  }
  live.firstFrame = true;
  attachStream();
}

function attachStream() {
  const video = live.video;
  video.srcObject = live.stream;
  video.muted = true;
  video.setAttribute('playsinline', '');
  const playing = video.play();
  if (playing && playing.catch) playing.catch(() => {});
  // A new stream starts a new frame loop; the loop of the old stream stops at its next callback.
  live.gen++;
  live.scheduled = false;
  scheduleNext();
}

// The lenses the browser exposes. Their labels appear once the permission has been granted, so the list is read after
// the first camera opens.
async function refreshLenses() {
  if (live.lensesKnown) return;
  const cameras = await listCameras();
  if (!cameras.length) return;
  const byZoom = { '0.5×': 0, '1×': 1, '3×': 2 };
  const rear = cameras
    .filter((c) => !isFrontLabel(c.label))
    .map((c) => ({ deviceId: c.deviceId, front: false, name: lensName(c.label) }))
    .sort((a, b) => (byZoom[a.name] ?? 9) - (byZoom[b.name] ?? 9));
  const front = cameras
    .filter((c) => isFrontLabel(c.label))
    .slice(0, 1)
    .map((c) => ({ deviceId: c.deviceId, front: true, name: 'Front' }));
  const lenses = rear.concat(front);
  if (!lenses.length) return;
  live.lenses = lenses;
  live.lensesKnown = true;
  live.lensIndex = 0;
  updateLensButton();
}

function updateLensButton() {
  const lens = live.lenses[live.lensIndex] || DEFAULT_LENSES[0];
  const button = $('live-switch');
  button.textContent = lens.name;
  button.setAttribute('aria-label', 'Switch lens. Now ' + lens.name);
}

// ---------- The preview ----------

// Calls onVideoFrame each time the camera presents a new frame (or on the next animation frame where the browser
// cannot report frames). One callback is pending at a time; each callback knows the stream it was made for.
function scheduleNext() {
  if (!live.open || live.scheduled) return;
  live.scheduled = true;
  const gen = live.gen;
  const frame = () => onVideoFrame(gen);
  if (typeof live.video.requestVideoFrameCallback === 'function') {
    live.video.requestVideoFrameCallback(frame);
  } else {
    requestAnimationFrame(frame);
  }
}

function onVideoFrame(gen) {
  if (gen !== live.gen || !live.open) return;
  live.scheduled = false;
  try {
    processFrame();
  } catch (err) {
    setLiveStatus('The preview stopped: ' + (err.message || err), true);
  }
  scheduleNext();
}

function processFrame() {
  const video = live.video;
  if (!video.videoWidth || video.readyState < 2) return;
  ensureArtwork(video.videoWidth, video.videoHeight);
  grabFrame();
  live.art.setParams(liveParams());
  const started = performance.now();
  const result = live.art.render((started - live.startedAt) / 1000, 0, { reset: live.firstFrame });
  live.firstFrame = false;
  live.renderMs = result.ms;
  if (live.starting) {
    live.starting = false;
    setLiveStatus(null);
  }
  live.frames++;
  const now = performance.now();
  if (now - live.fpsSince >= 500) {
    const fps = (live.frames * 1000) / (now - live.fpsSince);
    $('live-fps').textContent = fps.toFixed(0) + ' fps · ' + live.renderMs.toFixed(0) + ' ms per frame';
    live.frames = 0;
    live.fpsSince = now;
  }
}

// The settings the preview uses: the palette and algorithm in use, with no motion layer.
function liveParams() {
  return Object.assign({}, live.options.getParams(), { animation: 'off' });
}

// Creates the artwork for the camera's size. The data is one frame, replaced on every camera frame.
function ensureArtwork(vw, vh) {
  const scale = PREVIEW_SHORT_SIDE / Math.min(vw, vh);
  const W = Math.max(16, Math.round((vw * scale) / 2) * 2);
  const H = Math.max(16, Math.round((vh * scale) / 2) * 2);
  if (live.art && W === live.W && H === live.H) return;
  live.W = W;
  live.H = H;
  live.data = {
    width: W,
    height: H,
    fps: 30,
    duration: 0,
    count: 1,
    frames: [new Uint8Array(W * H)],
    colour: [new Uint8Array((W / 2) * (H / 2) * 3)],
    motion: null,
  };
  live.art = createArtwork(live.canvas, live.data);
  const grab = document.createElement('canvas');
  grab.width = W;
  grab.height = H;
  live.grabCtx = grab.getContext('2d', { willReadFrequently: true });
  live.firstFrame = true;
}

// Copies the current camera frame into the artwork's data: display-size luminance and analysis-size colour.
// The front camera is mirrored, as in a mirror.
function grabFrame() {
  const W = live.W;
  const H = live.H;
  const ctx = live.grabCtx;
  ctx.save();
  if (live.mirror) {
    ctx.translate(W, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(live.video, 0, 0, W, H);
  ctx.restore();
  const rgba = ctx.getImageData(0, 0, W, H).data;
  const luma = live.data.frames[0];
  for (let i = 0, j = 0; i < W * H; i++, j += 4) {
    luma[i] = (77 * rgba[j] + 150 * rgba[j + 1] + 29 * rgba[j + 2]) >> 8;
  }
  const gw = W / 2;
  const gh = H / 2;
  const colour = live.data.colour[0];
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const j = ((2 * y) * W + 2 * x) * 4;
      const k = (y * gw + x) * 3;
      colour[k] = rgba[j];
      colour[k + 1] = rgba[j + 1];
      colour[k + 2] = rgba[j + 2];
    }
  }
}

// ---------- Focus ----------

// Where the picture is drawn inside the canvas (the canvas letterboxes it), in screen pixels.
function pictureRect() {
  const rect = live.canvas.getBoundingClientRect();
  const scale = Math.min(rect.width / live.W, rect.height / live.H);
  const width = live.W * scale;
  const height = live.H * scale;
  return {
    left: rect.left + (rect.width - width) / 2,
    top: rect.top + (rect.height - height) / 2,
    width: width,
    height: height,
  };
}

// A tap on the picture shows the focus square, and asks the camera to focus and expose there, where it can.
function onStageTap(e) {
  if (!live.open || !live.stream || !live.W) return;
  const pic = pictureRect();
  const x = (e.clientX - pic.left) / pic.width;
  const y = (e.clientY - pic.top) / pic.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;
  const stageRect = live.stage.getBoundingClientRect();
  showFocusSquare(e.clientX - stageRect.left, e.clientY - stageRect.top);
  setFocusPoint(x, y);
}

function showFocusSquare(x, y) {
  const square = $('live-focus');
  square.style.left = x + 'px';
  square.style.top = y + 'px';
  square.hidden = false;
  clearTimeout(live.focusTimer);
  live.focusTimer = setTimeout(() => {
    square.hidden = true;
  }, 1000);
}

// x and y are 0 to 1 across the picture, from the top left. A mirrored (front) picture flips x.
function setFocusPoint(x, y) {
  const track = live.stream && live.stream.getVideoTracks()[0];
  const caps = track && track.getCapabilities ? track.getCapabilities() : {};
  const advanced = {};
  if ('pointsOfInterest' in caps) advanced.pointsOfInterest = [{ x: live.mirror ? 1 - x : x, y: y }];
  if (caps.focusMode && caps.focusMode.indexOf('single-shot') >= 0) advanced.focusMode = 'single-shot';
  if (caps.exposureMode && caps.exposureMode.indexOf('single-shot') >= 0) advanced.exposureMode = 'single-shot';
  if (!Object.keys(advanced).length) {
    setLiveStatus('This browser does not let the page set focus on this camera. The square marks the tap only.', false, 2500);
    return;
  }
  track.applyConstraints({ advanced: [advanced] }).catch((err) => {
    setLiveStatus('Focus was not changed: ' + (err.message || err), false, 2500);
  });
}

// ---------- Recording ----------

function onRecordDown(e) {
  if (e.button !== undefined && e.button !== 0) return;
  e.preventDefault();
  if (e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId);
  startRecording();
}

// Starts recording the camera stream (video only). It stops when the button is released, or at 10 seconds.
function startRecording() {
  if (!live.open || live.recorder || !live.stream || live.switching) return;
  const mime = pickMp4Mime('h264') || pickWebmMime();
  if (!mime || typeof MediaRecorder === 'undefined') {
    setLiveStatus('This browser cannot record video here.', true);
    return;
  }
  const chunks = [];
  const startedAt = performance.now();
  const job = {
    chunks: chunks,
    mime: mime,
    startedAt: startedAt,
    width: live.video.videoWidth,
    height: live.video.videoHeight,
  };
  let recorder;
  try {
    recorder = new MediaRecorder(live.stream, { mimeType: mime, videoBitsPerSecond: RECORD_BITS_PER_SECOND });
  } catch (err) {
    setLiveStatus('Recording could not start: ' + (err.message || err), true);
    return;
  }
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  recorder.onerror = (e) => {
    setLiveStatus('Recording failed: ' + ((e.error && e.error.message) || 'unknown error'), true);
  };
  recorder.onstop = () => finishRecording(job);
  live.recorder = recorder;
  live.recStart = startedAt;
  recorder.start(250);
  $('live-record').classList.add('recording');
  live.recTimer = setInterval(updateTimer, 100);
  live.recStop = setTimeout(stopRecording, RECORD_SECONDS * 1000);
  updateTimer();
}

function stopRecording() {
  const recorder = live.recorder;
  if (!recorder) return;
  live.recorder = null;
  clearInterval(live.recTimer);
  clearTimeout(live.recStop);
  live.recTimer = 0;
  live.recStop = 0;
  $('live-record').classList.remove('recording');
  updateTimer();
  if (recorder.state !== 'inactive') recorder.stop();
}

// Keeps the recorded clip in the library. A press that was too short is not kept.
async function finishRecording(job) {
  const seconds = Math.min(RECORD_SECONDS, (performance.now() - job.startedAt) / 1000);
  if (seconds < MIN_RECORD_SECONDS || job.chunks.length === 0) {
    setLiveStatus('Hold the button a little longer to record.', false, 2500);
    return;
  }
  const blob = new Blob(job.chunks, { type: job.mime.split(';')[0] });
  setLiveStatus('Saving the clip…', false);
  try {
    const clip = await saveClip({ blob: blob, duration: seconds, width: job.width, height: job.height });
    setLiveStatus('Saved ' + clip.duration.toFixed(1) + ' s to the clip library.', false, 2500);
  } catch (err) {
    setLiveStatus('The clip could not be saved: ' + (err.message || err), true);
  }
}

function updateTimer() {
  const timer = $('live-timer');
  if (!live.recorder) {
    timer.textContent = RECORD_SECONDS + ' s max';
    return;
  }
  const seconds = Math.min(RECORD_SECONDS, (performance.now() - live.recStart) / 1000);
  timer.textContent = seconds.toFixed(1) + ' s';
}

// ---------- Status and screen ----------

function setLiveStatus(message, isError, hideAfterMs) {
  const el = $('live-status');
  clearTimeout(statusTimer);
  el.hidden = !message;
  el.textContent = message || '';
  el.classList.toggle('error', !!isError);
  if (message && hideAfterMs) {
    statusTimer = setTimeout(() => {
      el.hidden = true;
    }, hideAfterMs);
  }
}

// Keeps the screen on while the camera is open, where the browser allows it.
async function holdScreenAwake() {
  try {
    if (navigator.wakeLock) live.wake = await navigator.wakeLock.request('screen');
  } catch (err) {
    live.wake = null;
  }
}

function releaseScreen() {
  if (live.wake) {
    live.wake.release().catch(() => {});
    live.wake = null;
  }
}

// ---------- Clip library ----------

function openLibrary() {
  $('clip-library').hidden = false;
  renderLibrary();
}

function closeLibrary() {
  $('clip-library').hidden = true;
}

async function renderLibrary() {
  const list = $('clip-list');
  list.textContent = '';
  let clips;
  try {
    clips = await listClips();
  } catch (err) {
    $('clip-storage').textContent = err.message || String(err);
    $('clip-empty').hidden = true;
    return;
  }
  $('clip-empty').hidden = clips.length > 0;
  const total = clips.reduce((sum, clip) => sum + clip.size, 0);
  let line = clips.length + (clips.length === 1 ? ' clip' : ' clips') + ' · ' + formatBytes(total) + ' on this phone';
  const estimate = await storageEstimate();
  if (estimate && estimate.quota) {
    line += ' · site storage ' + formatBytes(estimate.usage) + ' of ' + formatBytes(estimate.quota);
  }
  $('clip-storage').textContent = line;
  for (const clip of clips) list.appendChild(clipItem(clip));
}

function clipItem(clip) {
  const item = el('li', 'clip-item');
  item.appendChild(el('span', 'clip-name', clip.name));
  const size = clip.width ? clip.width + '×' + clip.height + ' · ' : '';
  const when = new Date(clip.createdAt).toLocaleString();
  item.appendChild(el('span', 'clip-meta', clip.duration.toFixed(1) + ' s · ' + size + formatBytes(clip.size) + ' · ' + when));
  const actions = el('div', 'clip-actions');
  actions.appendChild(actionButton('Edit', () => editClip(clip.id)));
  actions.appendChild(actionButton('Download', () => downloadClip(clip.id)));
  actions.appendChild(actionButton('Delete', () => removeClip(clip.id)));
  item.appendChild(actions);
  return item;
}

// Opens the clip in the normal editor: it is processed at the output size, with every setting.
async function editClip(id) {
  const clip = await loadClip(id);
  if (!clip) return;
  const file = new File([clip.blob], clip.name, { type: clip.type });
  closeLibrary();
  closeLive(true);
  live.options.onOpenClip(file);
}

async function downloadClip(id) {
  const clip = await loadClip(id);
  if (!clip) return;
  const url = URL.createObjectURL(clip.blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = clip.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function removeClip(id) {
  if (!window.confirm('Delete this clip from this phone? It cannot be undone.')) return;
  try {
    await deleteClip(id);
  } catch (err) {
    $('clip-storage').textContent = err.message || String(err);
    return;
  }
  renderLibrary();
}

async function loadClip(id) {
  try {
    return await getClip(id);
  } catch (err) {
    $('clip-storage').textContent = err.message || String(err);
    return null;
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function actionButton(label, onClick) {
  const button = el('button', 'btn small', label);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}
