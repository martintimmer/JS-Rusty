// Live camera mode. The phone camera is shown full screen in portrait, with a live preview of the chosen palette and
// algorithm at a 480-pixel short side. A strip under the top bar changes the palette and the algorithm (the same
// settings as the editor). The lens button cycles through the cameras the browser exposes. Settings opens the editor's
// controls over the picture. A tap on the picture focuses where the browser allows it. Holding the record button
// records the plain camera picture for up to 10 seconds, with a vibration scheme of your choice, into the clip library
// on this device. Opening a clip hands it to the normal video path in app.js. Nothing is uploaded.

import { createArtwork } from '../rendering/artwork.js';
import { DT_PALETTE_LIBRARY } from '../rendering/dither/palettes.js';
import { pickMp4Mime, pickWebmMime } from '../export/video-exporter.js';
import { formatBytes } from '../ui.js';
import {
  cameraSupported, listCameras, openLens, stopCamera, cameraError, isFrontLabel, lensName, zoomRange, setZoom,
} from './camera.js';
import { saveClip, listClips, getClip, deleteClip, storageEstimate } from './clip-store.js';
import { HAPTIC_SCHEMES, vibrate, startRecordingHaptics, hapticMechanism } from './haptics.js';

// The preview's short side in pixels, from the largest step down. A step down is taken when a camera frame takes longer
// than FRAME_BUDGET_MS to draw, so the picture keeps its rate (60 frames a second leaves about 16 ms a frame).
const PREVIEW_STEPS = [480, 400, 320, 256];
const FRAME_BUDGET_MS = 12;
// The most the zoom reaches. Holding the record button and sliding up zooms; the zoom crops the picture, so the higher
// it goes the less detail there is.
const MAX_ZOOM = 5;
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

const HAPTIC_KEY = 'js-rusty-haptics';
const DEFAULT_HAPTIC = 'heartbeat';

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
  step: 0,
  workEma: 0,
  workFrames: 0,
  cameraFps: 0,
  paramSig: '',
  recTicks: 0,
  frameCanvas: null,
  frameCtx: null,
  rot: false,
  zoom: 1,
  press: null,
  lenses: DEFAULT_LENSES.slice(),
  lensIndex: 0,
  lensesKnown: false,
  focusTimer: 0,
  recorder: null,
  recStart: 0,
  recTimer: 0,
  recStop: 0,
  hapticRun: null,
  haptic: DEFAULT_HAPTIC,
  sheetOpen: false,
  sidebarHome: null,
  wake: null,
};

let statusTimer = 0;

// options: getParams() returns the current settings; setParam(key, value) changes one, as the editor's controls do;
// onOpenClip(file) opens a clip in the normal editor.
export function initLive(options) {
  live.options = options;
  live.video = $('live-video');
  live.canvas = $('live-canvas');
  live.stage = $('live-stage');
  live.haptic = readHapticChoice();
  const supported = cameraSupported() && window.isSecureContext;
  const openButton = $('btn-live');
  openButton.disabled = !supported;
  openButton.title = supported
    ? 'Record from the camera with a live dithered preview'
    : 'Live needs a camera and a secure (https) page';
  openButton.addEventListener('click', openLive);
  $('live-close').addEventListener('click', () => closeLive(false));
  $('live-switch').addEventListener('click', switchCamera);
  $('live-settings').addEventListener('click', toggleSettings);
  $('live-sheet-close').addEventListener('click', closeSettings);
  $('live-haptic').addEventListener('click', cycleHaptic);
  $('live-library').addEventListener('click', openLibrary);
  live.stage.addEventListener('pointerdown', onStageTap);
  const record = $('live-record');
  record.addEventListener('pointerdown', onRecordDown);
  record.addEventListener('pointermove', onRecordMove);
  record.addEventListener('pointerup', endPress);
  record.addEventListener('pointercancel', endPress);
  record.addEventListener('lostpointercapture', endPress);
  record.addEventListener('contextmenu', (e) => e.preventDefault());
  $('clip-close').addEventListener('click', closeLibrary);
  $('clip-library').addEventListener('click', (e) => {
    if (e.target === $('clip-library')) closeLibrary();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('clip-library').hidden) closeLibrary();
    else if (live.sheetOpen) closeSettings();
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
  updateHapticButton();
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

// ---------- Settings: the editor's controls, shown over the picture ----------

// The right-hand panel is moved into the live screen while settings are open, so the same controls drive the preview.
// It goes back to its place in the editor when settings close.
function openSettings() {
  if (live.sheetOpen) return;
  const sidebar = $('sidebar-right');
  if (!live.sidebarHome) {
    live.sidebarHome = { parent: sidebar.parentNode, next: sidebar.nextSibling };
  }
  $('live-sheet-body').appendChild(sidebar);
  sidebar.classList.add('in-live-sheet');
  $('live-sheet').hidden = false;
  live.sheetOpen = true;
  $('live-settings').setAttribute('aria-expanded', 'true');
}

function closeSettings() {
  if (!live.sheetOpen) return;
  const sidebar = $('sidebar-right');
  if (live.sidebarHome) {
    live.sidebarHome.parent.insertBefore(sidebar, live.sidebarHome.next);
    live.sidebarHome = null;
  }
  sidebar.classList.remove('in-live-sheet');
  $('live-sheet').hidden = true;
  live.sheetOpen = false;
  $('live-settings').setAttribute('aria-expanded', 'false');
}

function toggleSettings() {
  if (live.sheetOpen) closeSettings();
  else openSettings();
}

// ---------- Vibration ----------

function hapticScheme() {
  return HAPTIC_SCHEMES.find((s) => s.id === live.haptic) || HAPTIC_SCHEMES[0];
}

function readHapticChoice() {
  try {
    const saved = localStorage.getItem(HAPTIC_KEY);
    if (HAPTIC_SCHEMES.some((s) => s.id === saved)) return saved;
  } catch (err) {
    // Storage is unavailable: use the default.
  }
  return DEFAULT_HAPTIC;
}

function updateHapticButton() {
  const scheme = hapticScheme();
  const button = $('live-haptic');
  button.textContent = scheme.label;
  button.setAttribute('aria-label', 'Vibration: ' + scheme.label + '. Tap to change.');
}

// Steps to the next scheme and gives its press cue, so the choice can be felt at once.
function cycleHaptic() {
  const index = HAPTIC_SCHEMES.findIndex((s) => s.id === live.haptic);
  const next = HAPTIC_SCHEMES[(index + 1) % HAPTIC_SCHEMES.length];
  live.haptic = next.id;
  try {
    localStorage.setItem(HAPTIC_KEY, live.haptic);
  } catch (err) {
    // Not kept between visits when storage is unavailable.
  }
  updateHapticButton();
  vibrate(next.start);
}

// ---------- Opening and closing ----------

async function openLive() {
  if (live.open || !cameraSupported()) return;
  live.open = true;
  live.starting = true;
  live.startedAt = performance.now();
  live.frames = 0;
  live.fpsSince = live.startedAt;
  live.zoom = 1;
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
  closeSettings();
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
  // The rate the camera actually delivers, which can be below the 60 asked for.
  const track = stream.getVideoTracks()[0];
  live.cameraFps = Math.round((track && track.getSettings && track.getSettings().frameRate) || 0);
  if (lens.zoom) setZoom(stream, lens.zoom);
  return true;
}

// The lens button cycles through every lens in the list.
async function switchCamera() {
  if (!live.open || live.recorder || live.switching) return;
  live.switching = true;
  live.lensIndex = (live.lensIndex + 1) % live.lenses.length;
  live.zoom = 1;
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

// The lenses the browser exposes: every rear camera, then the front camera. Labels appear once the permission has been
// granted, so the list is read after the first camera opens. If the browser lists only one rear camera but allows
// zoom, the rear camera is offered at its zoom levels (0.5×, 1×, 2×, 3× where the camera allows them).
async function refreshLenses() {
  if (live.lensesKnown || !live.stream) return;
  const cameras = await listCameras();
  if (!cameras.length) return;
  const order = { '0.5×': 0, '1×': 1, '2×': 2, '3×': 3 };
  const rear = cameras
    .filter((c) => !isFrontLabel(c.label))
    .map((c) => ({ deviceId: c.deviceId, facing: 'environment', front: false, name: lensName(c.label) }))
    .sort((a, b) => (order[a.name] ?? 9) - (order[b.name] ?? 9));
  const front = cameras
    .filter((c) => isFrontLabel(c.label))
    .slice(0, 1)
    .map((c) => ({ deviceId: c.deviceId, facing: 'user', front: true, name: 'Front' }));
  let lenses = rear.concat(front);
  if (rear.length === 1) {
    const range = zoomRange(live.stream);
    if (range) {
      const levels = [0.5, 1, 2, 3].filter((z) => z >= range.min - 0.01 && z <= range.max + 0.01);
      if (levels.length) {
        lenses = levels.map((z) => Object.assign({}, rear[0], { zoom: z, name: z + '×' })).concat(front);
      }
    }
  }
  if (!lenses.length) return;
  live.lenses = lenses;
  live.lensesKnown = true;
  const current = lenses.findIndex((l) => l.name === '1×');
  live.lensIndex = current >= 0 ? current : 0;
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
  const t0 = performance.now();
  const size = drawFrame(video.videoWidth, video.videoHeight);
  ensureArtwork(size.w, size.h);
  grabFrame();
  // The settings reach the preview only when they change: the signature is cheap to compare.
  const sig = JSON.stringify(live.options.getParams());
  if (sig !== live.paramSig) {
    live.paramSig = sig;
    live.art.setParams(liveParams());
  }
  const started = performance.now();
  const result = live.art.render((started - live.startedAt) / 1000, 0, { reset: live.firstFrame });
  live.firstFrame = false;
  live.renderMs = result.ms;
  adaptPreview(performance.now() - t0);
  if (live.starting) {
    live.starting = false;
    setLiveStatus(null);
  }
  live.frames++;
  const now = performance.now();
  if (now - live.fpsSince >= 500) {
    const fps = (live.frames * 1000) / (now - live.fpsSince);
    $('live-fps').textContent = fps.toFixed(0) + ' fps · ' + live.renderMs.toFixed(0) + ' ms · camera ' +
      (live.cameraFps || '?') + ' fps · preview ' + PREVIEW_STEPS[live.step] + ' px';
    live.frames = 0;
    live.fpsSince = now;
    // The strip follows the settings, including changes made in the settings sheet.
    updateStrip();
  }
}

// Draws the camera frame into the frame canvas: turned upright for a portrait screen, cropped by the zoom, and mirrored
// for the front camera. The preview and the recording are both taken from this canvas, so both show the zoom.
// Returns the picture's size in the screen's orientation.
function drawFrame(vw, vh) {
  const rot = vw > vh && window.innerHeight > window.innerWidth;
  live.rot = rot;
  const ow = rot ? vh : vw;
  const oh = rot ? vw : vh;
  if (!live.frameCanvas) {
    live.frameCanvas = document.createElement('canvas');
    live.frameCtx = live.frameCanvas.getContext('2d');
  }
  const fc = live.frameCanvas;
  if (fc.width !== ow || fc.height !== oh) {
    fc.width = ow;
    fc.height = oh;
  }
  const cw = vw / live.zoom;
  const ch = vh / live.zoom;
  const sx = (vw - cw) / 2;
  const sy = (vh - ch) / 2;
  const ctx = live.frameCtx;
  if (rot) {
    // A landscape sensor on a portrait screen is turned a quarter turn clockwise. A mirrored picture is transposed.
    if (live.mirror) ctx.setTransform(0, 1, 1, 0, 0, 0);
    else ctx.setTransform(0, 1, -1, 0, ow, 0);
    ctx.drawImage(live.video, sx, sy, cw, ch, 0, 0, oh, ow);
  } else {
    if (live.mirror) ctx.setTransform(-1, 0, 0, 1, ow, 0);
    else ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(live.video, sx, sy, cw, ch, 0, 0, ow, oh);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return { w: ow, h: oh };
}

// Sets the zoom. 1× is the whole picture. The label shows while the button is held, and whenever the picture is zoomed.
function setDigitalZoom(z) {
  live.zoom = Math.min(MAX_ZOOM, Math.max(1, z));
  const label = $('live-zoom');
  label.textContent = live.zoom.toFixed(1) + '×';
  label.hidden = live.zoom <= 1.001 && !live.press;
}

// A tap point on the visible picture (0 to 1 across, from the top left), as a point on the camera's own frame: it undoes
// the turn, the mirror and the crop of the zoom. The camera focuses on that point.
function tapToSensor(xo, yo) {
  let u;
  let v;
  if (live.rot) {
    u = yo;
    v = live.mirror ? xo : 1 - xo;
  } else {
    u = live.mirror ? 1 - xo : xo;
    v = yo;
  }
  const edge = (1 - 1 / live.zoom) / 2;
  return { x: edge + u / live.zoom, y: edge + v / live.zoom };
}

// Keeps the preview fast enough. When the average work per camera frame is over the budget, the next frames are drawn
// at the next smaller size; when it is well under, the size grows back. Each change needs 30 frames of evidence.
function adaptPreview(work) {
  live.workEma = live.workEma === 0 ? work : live.workEma * 0.9 + work * 0.1;
  live.workFrames++;
  if (live.workFrames < 30) return;
  live.workFrames = 0;
  if (live.workEma > FRAME_BUDGET_MS && live.step < PREVIEW_STEPS.length - 1) live.step++;
  else if (live.workEma < FRAME_BUDGET_MS / 2 && live.step > 0) live.step--;
  else return;
  live.workEma = 0;
  live.art = null; // rebuilt at the new size on the next frame
}

// The settings the preview uses: the palette and algorithm in use, with no motion layer.
function liveParams() {
  return Object.assign({}, live.options.getParams(), { animation: 'off' });
}

// Creates the artwork for the camera's size. The data is one frame, replaced on every camera frame.
function ensureArtwork(vw, vh) {
  const scale = PREVIEW_STEPS[live.step] / Math.min(vw, vh);
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
  live.paramSig = '';
  const grab = document.createElement('canvas');
  grab.width = W;
  grab.height = H;
  live.grabCtx = grab.getContext('2d');
  live.firstFrame = true;
}

// Copies the current camera frame into the artwork's data: display-size luminance and analysis-size colour.
// The picture comes from the frame canvas, which drawFrame has already turned, cropped and mirrored.
function grabFrame() {
  const W = live.W;
  const H = live.H;
  const ctx = live.grabCtx;
  ctx.drawImage(live.frameCanvas, 0, 0, W, H);
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

// Where the picture is drawn inside the canvas in screen pixels. It fills the canvas, and the edges that do not fit are cut.
function pictureRect() {
  const rect = live.canvas.getBoundingClientRect();
  const scale = Math.max(rect.width / live.W, rect.height / live.H);
  const width = live.W * scale;
  const height = live.H * scale;
  return {
    left: rect.left + (rect.width - width) / 2,
    top: rect.top + (rect.height - height) / 2,
    width: width,
    height: height,
  };
}

// A tap on the picture shows the focus square, and asks the camera to focus and expose there, where it can. Taps on
// the settings sheet do not count.
function onStageTap(e) {
  if (!live.open || !live.stream || !live.W) return;
  if (e.target.closest && e.target.closest('.live-top, .live-strip, .live-bottom, .live-sheet')) return;
  const pic = pictureRect();
  const x = (e.clientX - pic.left) / pic.width;
  const y = (e.clientY - pic.top) / pic.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;
  const stageRect = live.stage.getBoundingClientRect();
  showFocusSquare(e.clientX - stageRect.left, e.clientY - stageRect.top);
  const sensor = tapToSensor(x, y);
  setFocusPoint(sensor.x, sensor.y);
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
  if ('pointsOfInterest' in caps) advanced.pointsOfInterest = [{ x: x, y: y }];
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
  // Sliding up while the button is held zooms, as in Instagram and Snapchat. The zoom starts from the current one.
  live.press = { y: e.clientY, zoom: live.zoom };
  setDigitalZoom(live.zoom);
  startRecording();
}

function onRecordMove(e) {
  if (!live.press) return;
  // Up is positive: each 180 px upward doubles the zoom.
  setDigitalZoom(live.press.zoom * Math.pow(2, (live.press.y - e.clientY) / 180));
}

// The finger lifted, or the press was cancelled. The recording stops, and the zoom stays where the finger left it.
function endPress() {
  live.press = null;
  setDigitalZoom(live.zoom);
  stopRecording();
}

// Starts recording the camera stream (video only). It stops when the button is released, or at 10 seconds. The
// vibration scheme starts with the press and stops with the recording.
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
  // The clip is the picture from the frame canvas, so the zoom and the turn show in it. The camera stream is the fallback.
  const canvasStream = live.frameCanvas && live.frameCanvas.captureStream ? live.frameCanvas.captureStream(60) : null;
  job.stream = canvasStream;
  let recorder;
  try {
    recorder = new MediaRecorder(canvasStream || live.stream, { mimeType: mime, videoBitsPerSecond: RECORD_BITS_PER_SECOND });
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
  live.hapticRun = startRecordingHaptics(live.haptic, RECORD_SECONDS);
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
  if (live.hapticRun) {
    live.recTicks = live.hapticRun.stop();
    live.hapticRun = null;
  }
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
  if (job.stream) job.stream.getTracks().forEach((track) => track.stop());
  const seconds = Math.min(RECORD_SECONDS, (performance.now() - job.startedAt) / 1000);
  if (seconds < MIN_RECORD_SECONDS || job.chunks.length === 0) {
    setLiveStatus('Hold the button a little longer to record.', false, 2500);
    return;
  }
  const blob = new Blob(job.chunks, { type: job.mime.split(';')[0] });
  setLiveStatus('Saving the clip…', false);
  try {
    const clip = await saveClip({ blob: blob, duration: seconds, width: job.width, height: job.height });
    const haptic = ' Haptics (' + hapticMechanism() + '): ' + live.recTicks + ' ticks sent.';
    setLiveStatus('Saved ' + clip.duration.toFixed(1) + ' s to the clip library.' + haptic, false, 4000);
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
