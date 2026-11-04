// Live camera mode. The phone camera is shown full screen in portrait, with a dithered preview: the Dither engine at a
// 480-pixel short side, with the dither settings the user has chosen. Holding the record button records the plain
// camera picture for up to 10 seconds into the clip library on this device. Opening a clip hands it to the normal
// video path in app.js, where it is processed at the output size with every setting. Nothing is uploaded.

import { createArtwork } from '../rendering/artwork.js';
import { dtFindPreset } from '../rendering/dither/palettes.js';
import { pickMp4Mime, pickWebmMime } from '../export/video-exporter.js';
import { formatBytes } from '../ui.js';
import { cameraSupported, openCamera, stopCamera, cameraError } from './camera.js';
import { saveClip, listClips, getClip, deleteClip, storageEstimate } from './clip-store.js';

// The preview's short side in pixels: 854×480 for a landscape camera, 480×854 for a portrait one.
const PREVIEW_SHORT_SIDE = 480;
// Recording stops at this length. A press shorter than the minimum is not kept.
const RECORD_SECONDS = 10;
const MIN_RECORD_SECONDS = 0.3;
const RECORD_BITS_PER_SECOND = 8000000;

const METHOD_LABELS = {
  atkinson: 'Atkinson',
  'floyd-steinberg': 'Floyd–Steinberg',
  jjn: 'Jarvis–Judice–Ninke',
  bayer: 'Bayer 8×8',
  bayer4: 'Bayer 4×4',
  random: 'Random threshold',
  'blue-noise': 'Blue noise',
  none: 'Direct',
};

const $ = (id) => document.getElementById(id);

const live = {
  options: null,
  open: false,
  starting: false,
  switching: false,
  facing: 'environment',
  stream: null,
  video: null,
  canvas: null,
  grabCtx: null,
  W: 0,
  H: 0,
  data: null,
  art: null,
  firstFrame: true,
  startedAt: 0,
  scheduled: false,
  rafId: 0,
  frames: 0,
  fpsSince: 0,
  renderMs: 0,
  recorder: null,
  recStart: 0,
  recTimer: 0,
  recStop: 0,
  wake: null,
};

let statusTimer = 0;

// options: getParams() returns the current settings; onOpenClip(file) opens a clip in the normal editor.
export function initLive(options) {
  live.options = options;
  live.video = $('live-video');
  live.canvas = $('live-canvas');
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
  updateTimer();
}

export function isLiveOpen() {
  return live.open;
}

// ---------- Opening and closing ----------

async function openLive() {
  if (live.open || !cameraSupported()) return;
  live.open = true;
  live.starting = true;
  live.startedAt = performance.now();
  live.frames = 0;
  live.fpsSince = live.startedAt;
  $('live-screen').hidden = false;
  setPreset();
  setLiveStatus('Starting the camera…', false);
  holdScreenAwake();
  try {
    live.stream = await openCamera(live.facing);
  } catch (err) {
    setLiveStatus(cameraError(err), true);
    return;
  }
  if (!live.open) {
    // Closed while the camera was opening.
    stopCamera(live.stream);
    live.stream = null;
    return;
  }
  attachStream();
}

// Closes live mode and stops the camera. A recording in progress keeps the screen open, unless force is set.
function closeLive(force) {
  if (!live.open) return;
  if (live.recorder && !force) return;
  live.open = false;
  live.starting = false;
  live.scheduled = false;
  if (live.rafId) cancelAnimationFrame(live.rafId);
  live.rafId = 0;
  stopCamera(live.stream);
  live.stream = null;
  live.video.srcObject = null;
  releaseScreen();
  $('live-screen').hidden = true;
  setLiveStatus(null);
}

async function switchCamera() {
  if (!live.open || live.recorder || live.switching) return;
  live.switching = true;
  const next = live.facing === 'environment' ? 'user' : 'environment';
  stopCamera(live.stream);
  live.stream = null;
  live.video.srcObject = null;
  live.facing = next;
  live.starting = true;
  setLiveStatus('Switching camera…', false);
  try {
    live.stream = await openCamera(next);
  } catch (err) {
    live.switching = false;
    setLiveStatus(cameraError(err), true);
    return;
  }
  live.switching = false;
  if (!live.open) {
    stopCamera(live.stream);
    live.stream = null;
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
  scheduleNext();
}

// ---------- The preview ----------

// Calls onVideoFrame each time the camera presents a new frame (or on the next animation frame where the browser
// cannot report frames). One callback is pending at a time.
function scheduleNext() {
  if (!live.open || live.scheduled) return;
  live.scheduled = true;
  if (typeof live.video.requestVideoFrameCallback === 'function') {
    live.video.requestVideoFrameCallback(onVideoFrame);
  } else {
    live.rafId = requestAnimationFrame(onVideoFrame);
  }
}

function onVideoFrame() {
  live.scheduled = false;
  if (!live.open) return;
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

// The settings the preview uses: the current dither settings, always with the Dither engine and no motion.
function liveParams() {
  return Object.assign({}, live.options.getParams(), { algorithm: 'dither', animation: 'off' });
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
  if (live.facing === 'user') {
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

function setPreset() {
  const p = live.options.getParams();
  const method = METHOD_LABELS[p.dtMethod] || 'Dither';
  const preset = dtFindPreset(p.dtPalette);
  let palette = 'Paper and ink';
  if (p.dtPalette === 'custom') palette = 'Custom palette';
  else if (preset) palette = preset.name;
  $('live-preset').textContent = 'Dither · ' + method + ' · ' + palette;
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
