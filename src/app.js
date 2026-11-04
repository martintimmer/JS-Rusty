// Application entry point: wires the UI to the media pipeline, renderer and exporters.

import { DEFAULT_PARAMS, normalizeParams, CANVAS_SCALE } from './rendering/core.js';
import { autoLevels } from './media/tone.js';
import { createArtwork } from './rendering/artwork.js';
import { AnimationController } from './rendering/animation-controller.js';
import { loadImage, imageToFrames } from './media/image-loader.js';
import { loadVideo, estimateFrameRate } from './media/video-loader.js';
import { extractVideoFrames } from './media/frame-extractor.js';
import { isTouchDevice, frameBudgetBytes, FRAME_BYTES_PER_PIXEL, MAX_FRAMES } from './device.js';
import { analyseMotion } from './media/motion-analysis.js';
import { exportStandaloneJs, downloadBlob } from './export/javascript-exporter.js';
import { exportStandaloneHtml } from './export/html-exporter.js';
import { recordCanvasWebm, pickWebmMime, recordCanvasVideo, pickMp4Mime, mp4BitsPerSecond, supportedMp4Codecs } from './export/video-exporter.js';
import { exportStill, exportGif, outputSize } from './export/image-exporter.js';
import * as UI from './ui.js';
import { initPalettePanel, setActivePalette } from './palette-panel.js';
import { initAlgorithmIcons } from './algorithm-icons.js';
import { initExportDialog, openExportDialog, refreshExportDialog, setExportMessage, isExportDialogOpen } from './export/export-dialog.js';
import { initLayout, initUiScale } from './layout.js';
import { initEmptyStateArt } from './empty-state-art.js';
import { initLive, isLiveOpen } from './live/live.js';
import { dtFindPreset } from './rendering/dither/palettes.js';

// Processing boxes: media is fitted inside the box, keeping its aspect ratio.
// 'original' fits the source at its own size (no downscale). The other choices are the 16:9 heights.
const RESOLUTIONS = {
  '1080': { w: 1920, h: 1080 },
  '720': { w: 1280, h: 720 },
  '480': { w: 854, h: 480 },
};
const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/i;
// Sampling rate limits (frames per second) for the custom rate, and the rate assumed when the browser
// cannot report the source frame rate.
const FPS_MIN = 1;
const FPS_MAX = 120;
const DEFAULT_SOURCE_FPS = 30;
// The Animation choices (snake, pulse, hover, ripple) are hidden in the interface for now. Set this to true
// to show them again. Animation applies to still images only.
const ANIMATIONS_ENABLED = false;
const $ = UI.DOM.get;

const state = {
  media: null,        // { kind, name, size, width, height, duration, url, element }
  data: null,         // processed frame sequence + motion (see rendering/artwork.js)
  artwork: null,
  controller: null,
  params: Object.assign({}, DEFAULT_PARAMS),
  zoom: 1,
  processing: false,
  pendingProcess: false,
  recording: false,
  exporting: false,
  loading: false,
  loadToken: 0,
};

const video = $('orig-video');
const img = $('orig-img');

// ---------- Boot ----------

function init() {
  initAlgorithmIcons();
  initLayout();
  initUiScale();
  initEmptyStateArt();
  // Live camera: a clip from the library opens here, in the normal video path, at the output size.
  initLive({ getParams: () => state.params, setParam: liveSetParam, onOpenClip: (file) => handleFile(file) });
  bindDock();
  if (!ANIMATIONS_ENABLED) state.params.animation = 'off';
  // The default output is 1080p on every device. Long clips are made smaller automatically when their frames would
  // not fit the memory budget, so phones do not need a smaller default. Phones and tablets get a tap to choose a file.
  $('p-res').value = '1080';
  if (isTouchDevice()) {
    document.querySelector('.empty-title').textContent = 'Choose a photo or video';
    $('empty-sub').textContent = 'or tap to choose a photo or video · JPG, PNG, WebP, MP4, MOV (video up to 5000 frames)';
  }
  UI.syncRenderControls(state.params);
  UI.setAlgorithm(state.params.algorithm);
  UI.setViewMode('rendered');
  UI.bindRenderControls(onParamChange);
  initPalettePanel({ onChange: onPaletteChange, onMethod: onSuggestedMethod });
  setActivePalette(state.params.dtPalette, state.params.dtColours);

  document.querySelectorAll('#algorithm-selector .seg').forEach((btn) => {
    btn.addEventListener('click', () => setAlgorithm(btn.dataset.algo));
  });
  document.querySelectorAll('#animation-selector .seg').forEach((btn) => {
    btn.addEventListener('click', () => setAnimation(btn.dataset.anim));
  });
  document.querySelectorAll('#view-mode .seg').forEach((btn) => {
    btn.addEventListener('click', () => {
      UI.setViewMode(btn.dataset.view);
      if (state.controller) state.controller.markDirty(false);
    });
  });

  bindUpload();
  bindProcessing();
  bindTransport();
  bindZoom();
  bindExports();

  $('btn-reset-params').addEventListener('click', resetParams);
  window.addEventListener('keydown', onKeyDown);
  video.addEventListener('ended', () => updatePlayButton());
  updateEnabledState();
}

// ---------- Upload ----------

// Files can be dropped anywhere on the window. A hint shows while a file is held over it.
function bindUpload() {
  const input = $('file-input');
  input.addEventListener('change', () => {
    if (input.files && input.files[0]) handleFile(input.files[0]);
    input.value = '';
  });
  // The Source panel's button opens the same picker; it stays available after a file is loaded.
  $('btn-open').addEventListener('click', () => input.click());
  // The empty canvas area is the file picker. The keyboard can open it as well.
  $('empty-state').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });
  const hint = $('drop-hint');
  let dragDepth = 0;
  const carriesFiles = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') >= 0;
  window.addEventListener('dragenter', (e) => {
    if (!carriesFiles(e)) return;
    dragDepth++;
    hint.hidden = false;
  });
  window.addEventListener('dragleave', (e) => {
    if (!carriesFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) hint.hidden = true;
  });
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (carriesFiles(e)) e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    hint.hidden = true;
    const file = e.dataTransfer && e.dataTransfer.files[0];
    if (file) handleFile(file);
  });
}

async function handleFile(file) {
  const isImage = IMAGE_EXT.test(file.name) || (file.type || '').startsWith('image/');
  const isVideo = !isImage && (VIDEO_EXT.test(file.name) || (file.type || '').startsWith('video/'));
  if (!isImage && !isVideo) {
    setStatus('Unsupported file type. Use JPG, PNG, WebP, MP4, WebM or MOV.', true);
    return;
  }
  if (state.processing || state.recording) {
    setStatus('Wait for the current operation to finish.', true);
    return;
  }

  const token = ++state.loadToken;
  state.loading = true;
  updateEnabledState();
  teardownCurrent();
  // The canvas area shows the progress bar from the start. The source is not previewed after upload.
  $('empty-state').hidden = true;
  $('canvas-pair').hidden = false;
  UI.setViewMode('rendered');
  UI.layoutPreview(RESOLUTIONS['1080'].w, RESOLUTIONS['1080'].h, state.zoom);
  UI.setProgress(0.02, 'Loading ' + file.name);
  setStatus('Loading ' + file.name + '…', false);
  try {
    if (isImage) {
      const loaded = await loadImage(file);
      if (token !== state.loadToken) {
        URL.revokeObjectURL(loaded.url);
        return;
      }
      img.src = loaded.url;
      img.hidden = false;
      video.hidden = true;
      state.media = {
        kind: 'image', name: file.name, size: file.size,
        width: loaded.width, height: loaded.height, duration: 0,
        url: loaded.url, element: loaded.element,
      };
    } else {
      const loaded = await loadVideo(file, video);
      if (token !== state.loadToken) {
        URL.revokeObjectURL(loaded.url);
        return;
      }
      video.hidden = false;
      img.hidden = true;
      state.media = {
        kind: 'video', name: file.name, size: file.size,
        width: loaded.width, height: loaded.height, duration: loaded.duration,
        url: loaded.url, element: video,
      };
    }
    // Animation applies to still images only. A video plays as recorded, with no animation layer.
    if (state.media.kind === 'video') state.params.animation = 'off';
    showSourceInfo();
    UI.layoutPreview(state.media.width, state.media.height, state.zoom);
    // Processing starts as soon as the media has loaded; there is no separate button.
    processMedia();
  } catch (err) {
    if (token !== state.loadToken) return;
    state.media = null;
    UI.setProgress(null);
    $('empty-state').hidden = false;
    $('canvas-pair').hidden = true;
    setStatus(err.message || 'Could not load this file.', true);
  } finally {
    if (token === state.loadToken) {
      state.loading = false;
      updateEnabledState();
    }
  }
}

function teardownCurrent() {
  if (state.controller) {
    state.controller.setPlaying(false);
    state.controller.stop();
  }
  state.controller = null;
  state.artwork = null;
  state.data = null;
  $('canvas-pair').classList.remove('has-art');
  UI.setText('canvas-px', '');
  if (state.media && state.media.url) URL.revokeObjectURL(state.media.url);
  state.media = null;
  video.removeAttribute('src');
  video.load();
  img.removeAttribute('src');
}

function showSourceInfo() {
  const m = state.media;
  UI.setText('info-name', m.name);
  UI.setText('info-type', m.kind === 'video' ? 'Video' : 'Image');
  UI.setText('info-size', m.width + '×' + m.height + ' · ' + UI.formatBytes(m.size));
  UI.setText('info-duration', m.kind === 'video' ? m.duration.toFixed(2) + ' s' : '—');
  UI.setText('info-processed', 'No');
}

// ---------- Processing pipeline ----------

// Sampling rate and resolution change the artwork, so they re-process the loaded media.
function bindProcessing() {
  $('p-fps').addEventListener('input', syncFpsControl);
  $('p-fps').addEventListener('change', processMedia);
  $('p-fps-auto').addEventListener('change', () => {
    syncFpsControl();
    processMedia();
  });
  $('p-res').addEventListener('change', processMedia);
  syncFpsControl();
}

// Shows the sampling rate: the source rate while Match source is on, otherwise the typed rate.
function syncFpsControl() {
  const input = $('p-fps');
  const auto = $('p-fps-auto').checked;
  const media = state.media;
  const source = media && media.kind === 'video' ? media.sourceFps : 0;
  input.disabled = auto;
  if (auto && source > 0) input.value = String(source);
  UI.setText('fps-val', auto ? (source > 0 ? source + ' fps' : 'auto') : input.value + ' fps');
}

// The sampling rate used for processing, in frames per second of the clip.
function currentFps() {
  const media = state.media;
  if ($('p-fps-auto').checked && media && media.kind === 'video' && media.sourceFps > 0) return media.sourceFps;
  const typed = Number($('p-fps').value);
  return Number.isFinite(typed) ? Math.min(FPS_MAX, Math.max(FPS_MIN, typed)) : DEFAULT_SOURCE_FPS;
}

// A processed video plays from the start and loops. The artwork runs on its own clock, so it does not
// depend on the source <video> element, which is only shown in the Original and Split views.
function playProcessedVideo() {
  if (!state.controller || !state.media || state.media.kind !== 'video') return;
  state.controller.restartClock();
  state.controller.setPlaying(true);
  updatePlayButton();
}

// Processes the loaded media. Called automatically after an upload, and when the sampling rate or
// resolution changes. A request made while a run is in progress runs once that run has finished.
async function processMedia() {
  if (!state.media) return;
  if (state.processing) {
    state.pendingProcess = true;
    return;
  }
  state.processing = true;
  updateEnabledState();
  const media = state.media;
  // The source frame rate is measured once per clip, on the first processing run.
  if (media.kind === 'video' && !(media.sourceFps > 0)) {
    setStatus('Reading the frame rate…', false);
    UI.setProgress(0.02, 'Reading the frame rate');
    media.sourceFps = (await estimateFrameRate(video, 1)) || DEFAULT_SOURCE_FPS;
    if (media.sourceFps > FPS_MAX) media.sourceFps = FPS_MAX;
  }
  syncFpsControl();
  const fps = currentFps();
  // Fit the media inside the chosen resolution box, keeping its aspect ratio.
  const choice = $('p-res').value;
  const box = choice === 'original' ? { w: media.width, h: media.height } : (RESOLUTIONS[choice] || RESOLUTIONS['1080']);
  // The output size is set by the short side: 1080p is 1080 pixels high for landscape media and 1080 wide for portrait.
  const fit = choice === 'original' ? 1 : Math.min(box.w, box.h) / Math.min(media.width, media.height);
  let W = Math.max(16, Math.round((media.width * fit) / 2) * 2);
  let H = Math.max(16, Math.round((media.height * fit) / 2) * 2);
  // Frames at the chosen rate. The rate is never lowered. A clip over MAX_FRAMES is refused. Otherwise, when the frames
  // would not fit the memory budget, the picture is made smaller (keeping its shape) and the rate is kept.
  const frameCount = media.kind === 'video' ? Math.max(1, Math.floor(media.duration * fps + 1e-6)) : 1;
  if (frameCount > MAX_FRAMES) {
    setStatus('This clip has ' + frameCount + ' frames at ' + fps + ' fps. The limit is ' + MAX_FRAMES +
      ' frames: use a shorter clip.', true);
    state.processing = false;
    updateEnabledState();
    return;
  }
  let sizeNote = '';
  if (media.kind === 'video') {
    const bytes = frameCount * W * H * FRAME_BYTES_PER_PIXEL;
    const budget = frameBudgetBytes();
    if (bytes > budget) {
      const fullW = W;
      const fullH = H;
      const s = Math.sqrt(budget / bytes);
      W = Math.max(256, Math.round((W * s) / 2) * 2);
      H = Math.max(144, Math.round((H * s) / 2) * 2);
      sizeNote = ' The picture is ' + W + '×' + H + ' instead of ' + fullW + '×' + fullH + ', so that ' +
        frameCount + ' frames at ' + fps + ' fps fit in memory. The frame rate is kept.';
    }
  }

  if (state.controller) state.controller.setPlaying(false);
  video.pause();
  UI.setProgress(0.01, 'Processing ' + media.name);
  setStatus('Processing ' + media.name + '…', false);

  try {
    let sequence;
    if (media.kind === 'image') {
      UI.setProgress(0.5, 'Decoding image');
      sequence = imageToFrames(media.element, W, H);
    } else {
      sequence = await extractVideoFrames(video, {
        fps: fps,
        width: W,
        height: H,
        duration: media.duration,
        onProgress: (f) => UI.setProgress(f * 0.6, 'Sampling ' + Math.round(f * 100) + '%'),
      });
    }

    // One tone mapping for the whole sequence, applied to display and analysis frames.
    // The colour frames get the same tone mapping, so their colours keep the tones of the grey frames.
    autoLevels([sequence.frames, sequence.analysisFrames, sequence.analysisColour]);

    let motion = null;
    if (media.kind === 'video') {
      UI.setProgress(0.6, 'Analysing motion 0%');
      // Motion runs at half resolution; vectors are scaled back to display pixels.
      motion = await analyseMotionAsync(sequence.analysisFrames, sequence.analysisWidth,
        sequence.analysisHeight, 2, (f) => {
          UI.setProgress(0.6 + f * 0.4, 'Analysing motion ' + Math.round(f * 100) + '%');
        });
    }

    state.data = {
      width: W,
      height: H,
      fps: sequence.fps,
      duration: sequence.duration,
      count: sequence.count,
      frames: sequence.frames,
      colour: sequence.analysisColour,
      motion: motion,
    };
    UI.setProgress(0.98, 'Preparing the artwork');
    buildArtwork();
    UI.setProgress(null);
    UI.setText('info-processed', media.kind === 'video'
      ? sequence.count + ' frames at ' + Math.round(sequence.fps * 100) / 100 + ' fps, ' + W + '×' + H
      : '1 frame at ' + W + '×' + H);
    setStatus('Artwork ready.' + sizeNote, false);
    if (media.kind === 'video') playProcessedVideo();
  } catch (err) {
    UI.setProgress(null);
    setStatus('Processing failed: ' + (err.message || err), true);
  } finally {
    state.processing = false;
    updateEnabledState();
    if (state.pendingProcess) {
      state.pendingProcess = false;
      processMedia();
    }
  }
}

// Runs motion estimation in a module Worker; falls back to the main thread if
// Workers are unavailable (for example when the page is opened from file://).
function analyseMotionAsync(frames, W, H, scale, onProgress) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL('./workers/processing-worker.js', import.meta.url), { type: 'module' });
    } catch (err) {
      resolve(analyseMotion(frames, W, H, { scale: scale, onProgress: onProgress }));
      return;
    }
    worker.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === 'progress') {
        onProgress(msg.progress);
      } else if (msg.type === 'done') {
        worker.terminate();
        resolve(msg.motion);
      } else if (msg.type === 'error') {
        worker.terminate();
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || 'Motion analysis worker failed.'));
    };
    worker.postMessage({ type: 'analyse', frames: frames, width: W, height: H, scale: scale });
  });
}

function buildArtwork() {
  if (state.controller) state.controller.stop();
  const canvas = $('render-canvas');
  state.artwork = createArtwork(canvas, state.data);
  // Some artwork is now on the canvas, so a new size shows it greyed out under the progress bar.
  $('canvas-pair').classList.add('has-art');
  UI.setText('canvas-px', state.data.width * CANVAS_SCALE + ' × ' + state.data.height * CANVAS_SCALE + ' px');
  state.artwork.setParams(state.params);
  // A new size keeps every setting the user chose. Re-showing them in the controls makes sure the panel matches them.
  UI.syncRenderControls(state.params);
  state.controller = new AnimationController({
    artwork: state.artwork,
    duration: state.media.kind === 'video' ? state.data.duration : 0,
    isVideo: state.media.kind === 'video',
    onTick: onClockTick,
    onStats: onRenderStats,
  });
  relayout();
  state.controller.markDirty(true);
  if (state.media.kind !== 'video') state.controller.setPlaying(isAnimated());
  state.controller.start();
  UI.setViewMode('rendered');
  updateEnabledState();
  updatePlayButton();
}

// ---------- Parameters ----------

// Palette choices and colour edits from the palette panel reach the renderer as ordinary parameters.
function onPaletteChange(dtPalette, dtColours) {
  // An 8 bit palette shows its own colours, so Grayscale turns off. Other palettes leave Grayscale as it is.
  const preset = dtFindPreset(dtPalette);
  if (preset && preset.category === 'retro-gaming' && state.params.grayscale !== false) {
    onParamChange('grayscale', false);
    UI.syncRenderControls(state.params);
  }
  onParamChange('dtPalette', dtPalette);
  onParamChange('dtColours', dtColours);
}

// Applies the dithering method a palette suggests. Choosing a palette itself never changes the method.
function onSuggestedMethod(method) {
  onParamChange('dtMethod', method);
  UI.syncRenderControls(state.params);
}

function onParamChange(key, value) {
  state.params = normalizeParams(Object.assign({}, state.params, { [key]: value }));
  // These change which controls apply (pattern, dither method, colour set).
  if (key === 'pattern' || key === 'dtMethod' || key === 'dtPalette') refreshControls();
  if (state.artwork) {
    state.artwork.setParams({ [key]: value });
    state.controller.markDirty(false);
  }
}

// Chooses the animation type. Animation applies to still images only, so this does nothing for video.
function setAnimation(type) {
  if (!ANIMATIONS_ENABLED || (state.media && state.media.kind === 'video')) return;
  state.params.animation = type;
  if (state.artwork) {
    state.artwork.setParams({ animation: type });
    state.controller.markDirty(true);
    // A still starts moving as soon as a motion type is chosen, and holds still when it is turned off.
    if (state.media.kind !== 'video') state.controller.setPlaying(type !== 'off');
  }
  refreshControls();
  updatePlayButton();
  updateEnabledState();
}

// Live mode's palette and algorithm strip changes the same settings as the editor, so a clip opened later keeps them.
function liveSetParam(key, value) {
  if (key === 'algorithm') {
    setAlgorithm(value);
    return;
  }
  // A palette from the strip goes through the same path as one from the palette panel, so 8 bit palettes turn Grayscale off.
  if (key === 'dtPalette') {
    onPaletteChange(value, '');
    setActivePalette(state.params.dtPalette, state.params.dtColours);
    return;
  }
  onParamChange(key, value);
}

function setAlgorithm(algo) {
  state.params.algorithm = algo;
  UI.setAlgorithm(algo);
  if (state.artwork) {
    state.artwork.setParams({ algorithm: algo });
    state.controller.markDirty(true);
  }
  updateEnabledState();
  updatePlayButton();
}

function resetParams() {
  state.params = Object.assign({}, DEFAULT_PARAMS, { algorithm: state.params.algorithm });
  UI.syncRenderControls(state.params);
  setActivePalette(state.params.dtPalette, state.params.dtColours);
  refreshControls();
  if (state.artwork) {
    state.artwork.setParams(state.params);
    state.controller.markDirty(true);
  }
}

// ---------- Transport, timeline and zoom ----------

function bindTransport() {
  $('btn-play').addEventListener('click', togglePlay);
  $('btn-restart').addEventListener('click', restart);
  const timeline = $('timeline');
  timeline.addEventListener('input', () => {
    if (state.controller && state.media && state.media.kind === 'video') {
      state.controller.seek((Number(timeline.value) / 1000) * state.media.duration);
    }
  });
}

function isAnimated() {
  return state.params.animation !== 'off';
}

function canTogglePlay() {
  if (!state.data || state.recording) return false;
  if (state.media.kind === 'video') return true;
  return isAnimated();
}

function togglePlay() {
  if (!canTogglePlay()) return;
  const next = !state.controller.playing;
  state.controller.setPlaying(next);
  updatePlayButton();
}

function restart() {
  if (!state.controller) return;
  state.controller.restartClock();
  updatePlayButton();
}

function updatePlayButton() {
  const playing = !!(state.controller && state.controller.playing);
  $('btn-play').textContent = playing ? '❚❚' : '▶';
  $('btn-play').title = playing ? 'Pause (Space)' : 'Play (Space)';
  $('btn-play').disabled = !canTogglePlay();
  $('btn-restart').disabled = !state.data || state.recording;
}

// Keeps the source <video> in step with the artwork clock while the Original or Split view shows it.
// In the Artwork view the element is paused, so nothing plays off screen.
function syncOriginalVideo() {
  if (!state.media || state.media.kind !== 'video' || !state.controller) return;
  const view = $('canvas-pair').dataset.view;
  if (view !== 'original' && view !== 'split') {
    if (!video.paused) video.pause();
    return;
  }
  const t = state.controller.currentTime();
  if (Math.abs(video.currentTime - t) > 0.2) video.currentTime = t;
  if (state.controller.playing) {
    if (video.paused) video.play().catch(() => {});
  } else if (!video.paused) {
    video.pause();
  }
}

function onClockTick(t, playing) {
  if (!state.data) return;
  syncOriginalVideo();
  const dur = state.media.kind === 'video' ? state.media.duration : 0;
  UI.setText('time-cur', UI.formatTime(t));
  UI.setText('time-dur', UI.formatTime(dur));
  const timeline = $('timeline');
  if (dur > 0 && document.activeElement !== timeline) {
    timeline.value = String(Math.round((t / dur) * 1000));
  }
  if (playing !== state.lastPlaying) {
    state.lastPlaying = playing;
    updatePlayButton();
  }
}

function onRenderStats(stats) {
  UI.setText('perf-render', stats.ms.toFixed(1));
  UI.setText('perf-frame', stats.fps ? stats.fps.toFixed(0) + ' fps' : '—');
  UI.setText('perf-elements', stats.elements.toLocaleString());
}

function bindZoom() {
  $('zoom-in').addEventListener('click', () => setZoom(state.zoom * 1.25));
  $('zoom-out').addEventListener('click', () => setZoom(state.zoom / 1.25));
  $('zoom-fit').addEventListener('click', () => setZoom(1));
  window.addEventListener('resize', relayout);
  // The canvas is sized to the stage, which also changes when a sidebar is dragged wider or narrower.
  if (window.ResizeObserver) new ResizeObserver(() => relayout()).observe($('stage'));
  $('canvas-pair').addEventListener('pointerup', onCanvasTap);
  bindPhoneGestures();
  blockBrowserZoom();
}

let lastTap = { t: 0, x: 0, y: 0 };

// Double-click (or double-tap) on the artwork toggles between fit and 200%. The point under the pointer stays
// under it, so the view zooms into what was clicked.
function onCanvasTap(e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const now = performance.now();
  const double = now - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 24;
  lastTap = { t: double ? 0 : now, x: e.clientX, y: e.clientY };
  if (!double || !state.data) return;
  const pair = $('canvas-pair');
  const stage = $('stage');
  const before = pair.getBoundingClientRect();
  const fx = before.width ? (e.clientX - before.left) / before.width : 0.5;
  const fy = before.height ? (e.clientY - before.top) / before.height : 0.5;
  setZoom(state.zoom > 1.01 ? 1 : 2);
  const after = pair.getBoundingClientRect();
  stage.scrollLeft += after.left + fx * after.width - e.clientX;
  stage.scrollTop += after.top + fy * after.height - e.clientY;
}

// The menu that a drag up opens: the last one the user chose (Settings at first).
let lastOpenDock = 'right';

// Phones: the browser must not pinch or refresh the page. The photo is pinched and panned in the app instead (see
// bindPhoneGestures). iOS Safari pinches the whole page with gesture events; other browsers pinch with two fingers.
function blockBrowserZoom() {
  if (!isTouchDevice()) return;
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  }
  document.addEventListener('touchmove', (e) => {
    if (e.touches.length > 1) e.preventDefault();
  }, { passive: false });
}

// Phones: a drag up on the photo or the menu tabs opens the settings, and a drag down closes them. On the photo, one
// finger pans a zoomed photo and two fingers pinch it. Mouse and trackpad keep the desktop behaviour.
const SHEET_DRAG_PX = 48;
const touchPoints = new Map();
let touchDrag = null;
let pinchStart = null;
let tabDrag = null;

function bindPhoneGestures() {
  if (!isTouchDevice()) return;
  const stage = $('stage');
  stage.addEventListener('pointerdown', onPhonePointerDown);
  stage.addEventListener('pointermove', onPhonePointerMove);
  stage.addEventListener('pointerup', onPhonePointerEnd);
  stage.addEventListener('pointercancel', onPhonePointerEnd);
  const tabs = $('dock-tabs');
  tabs.addEventListener('pointerdown', onTabsPointerDown);
  tabs.addEventListener('pointermove', onTabsPointerMove);
  tabs.addEventListener('pointerup', onTabsPointerEnd);
  tabs.addEventListener('pointercancel', onTabsPointerEnd);
}

function onPhonePointerDown(e) {
  if (e.pointerType !== 'touch') return;
  touchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (touchPoints.size === 2) {
    touchDrag = null;
    startPinch();
  } else if (touchPoints.size === 1) {
    touchDrag = { id: e.pointerId, x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, decided: false };
  }
}

// Remembers the zoom, the distance between the fingers, and the point of the photo under their midpoint.
function startPinch() {
  const [a, b] = [...touchPoints.values()];
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const r = $('canvas-pair').getBoundingClientRect();
  pinchStart = {
    dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
    zoom: state.zoom,
    fx: r.width ? (mx - r.left) / r.width : 0.5,
    fy: r.height ? (my - r.top) / r.height : 0.5,
  };
}

function onPhonePointerMove(e) {
  if (!touchPoints.has(e.pointerId)) return;
  touchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (touchPoints.size >= 2 && pinchStart) {
    pinchTo();
    return;
  }
  const d = touchDrag;
  if (!d || d.id !== e.pointerId) return;
  if (state.zoom > 1.01) {
    // Zoomed: the drag pans the photo.
    const stage = $('stage');
    stage.scrollLeft -= e.clientX - d.lastX;
    stage.scrollTop -= e.clientY - d.lastY;
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    return;
  }
  // At fit: a vertical drag on the photo opens the settings (up) or closes them (down).
  if (d.decided) return;
  const dx = e.clientX - d.x;
  const dy = e.clientY - d.y;
  if (Math.abs(dy) < SHEET_DRAG_PX || Math.abs(dy) < Math.abs(dx)) return;
  d.decided = true;
  if (dy < 0) openSheet();
  else closeSheet();
}

function pinchTo() {
  const [a, b] = [...touchPoints.values()];
  const dist = Math.hypot(a.x - b.x, a.y - b.y);
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  setZoom(pinchStart.zoom * dist / pinchStart.dist);
  // The point of the photo the fingers started on stays under the fingers.
  const r = $('canvas-pair').getBoundingClientRect();
  const stage = $('stage');
  stage.scrollLeft += r.left + pinchStart.fx * r.width - mx;
  stage.scrollTop += r.top + pinchStart.fy * r.height - my;
}

function onPhonePointerEnd(e) {
  touchPoints.delete(e.pointerId);
  if (touchPoints.size < 2) pinchStart = null;
  if (touchDrag && touchDrag.id === e.pointerId) touchDrag = null;
}

function onTabsPointerDown(e) {
  if (e.pointerType !== 'touch') return;
  tabDrag = { id: e.pointerId, y: e.clientY, done: false };
}

function onTabsPointerMove(e) {
  const t = tabDrag;
  if (!t || t.id !== e.pointerId || t.done) return;
  const dy = e.clientY - t.y;
  if (Math.abs(dy) < SHEET_DRAG_PX) return;
  t.done = true;
  if (dy < 0) openSheet();
  else closeSheet();
}

function onTabsPointerEnd(e) {
  if (tabDrag && tabDrag.id === e.pointerId) tabDrag = null;
}

// Opens the last menu the user chose, unless a menu is already open.
function openSheet() {
  const current = document.body.dataset.dock;
  if (current === 'left' || current === 'right') return;
  setDock(lastOpenDock);
}

function closeSheet() {
  if (document.body.dataset.dock !== 'closed') setDock('closed');
}

// Phones and tablets: the menus sit in a dock under the canvas. 'left' is Algorithm, 'right' is Settings,
// and 'closed' gives the canvas the whole screen.
function bindDock() {
  for (const button of document.querySelectorAll('#dock-tabs [data-dock]')) {
    button.addEventListener('click', () => setDock(button.dataset.dock));
  }
  // Phones start with the photo alone. A drag up on the photo or the tabs opens the settings.
  if (window.matchMedia('(max-width: 900px)').matches) setDock('closed');
}

function setDock(name) {
  if (name !== 'closed') lastOpenDock = name;
  document.body.dataset.dock = name;
  for (const button of document.querySelectorAll('#dock-tabs [data-dock]')) {
    button.setAttribute('aria-pressed', button.dataset.dock === name ? 'true' : 'false');
  }
  relayout();
}

function setZoom(z) {
  state.zoom = Math.min(4, Math.max(0.25, z));
  UI.setText('zoom-val', Math.abs(state.zoom - 1) < 0.01 ? 'Fit' : Math.round(state.zoom * 100) + '%');
  relayout();
}

function relayout() {
  const dims = currentDims();
  if (dims) UI.layoutPreview(dims.w, dims.h, state.zoom);
}

function currentDims() {
  if (state.data) return { w: state.data.width * CANVAS_SCALE, h: state.data.height * CANVAS_SCALE };
  if (state.media) return { w: state.media.width, h: state.media.height };
  return null;
}

// ---------- Export ----------

// The export window opens from the Export button. Its Export action runs the chosen format.
function bindExports() {
  $('btn-export-open').addEventListener('click', openExportDialog);
  initExportDialog({
    getSource: exportSource,
    isBusy: () => state.processing || state.recording || state.exporting || state.loading,
    canWebm: !!pickWebmMime(),
    mp4Codecs: supportedMp4Codecs(),
    onExport: runExportFromDialog,
  });
}

// What the export window needs about the current artwork, or null when nothing has been processed yet.
function exportSource() {
  if (!state.data || !state.artwork) return null;
  const isVideo = state.media.kind === 'video';
  return {
    canvas: state.artwork.canvas,
    data: state.data,
    isVideo: isVideo,
    animated: isVideo || isAnimated(),
    recordSeconds: isVideo ? state.data.duration : 8,
    // Dither artwork is exported as packed palette indices (see javascript-exporter.js).
    packed: state.artwork.params.algorithm === 'dither',
  };
}

// Runs the export chosen in the export window with its settings.
function runExportFromDialog(s) {
  switch (s.format) {
    case 'html': return runExport('html', s.standaloneWidth);
    case 'js': return runExport('js', s.standaloneWidth);
    case 'png': return exportImage('png', s);
    case 'jpg': return exportImage('jpg', s);
    case 'gif': return exportGifFile(s);
    case 'webm': return exportWebm();
    case 'mp4': return exportMp4(s);
    default: return undefined;
  }
}

async function runExport(kind, maxWidth) {
  if (!state.data) return;
  const params = state.artwork.params;
  setStatus('Building ' + (kind === 'html' ? 'HTML' : 'JavaScript') + ' export…', false);
  try {
    const bytes = kind === 'html'
      ? await exportStandaloneHtml(state.data, params, 'js-rusty-art.html', maxWidth)
      : await exportStandaloneJs(state.data, params, 'js-rusty-art.js', maxWidth);
    setStatus('Exported (' + UI.formatBytes(bytes) + ').', false);
  } catch (err) {
    setStatus('Export failed: ' + err.message + ' (exports need the app served over http, see README).', true);
  }
}

// PNG or JPG of the current frame, at the chosen size.
async function exportImage(format, s) {
  if (!state.data || state.exporting || state.recording) return;
  state.exporting = true;
  updateEnabledState();
  try {
    const size = outputSize(state.data, s.width);
    setStatus('Encoding ' + format.toUpperCase() + ' ' + size.w + '×' + size.h + '…', false);
    const blob = await exportStill(state.artwork.canvas, format, size.w, size.h, s.quality, undefined, s.blur);
    downloadBlob('js-rusty-frame.' + format, blob);
    setStatus(format.toUpperCase() + ' saved (' + size.w + '×' + size.h + ', ' +
      UI.formatBytes(blob.size) + ').', false);
  } catch (err) {
    setStatus('Export failed: ' + err.message, true);
  } finally {
    state.exporting = false;
    updateEnabledState();
  }
}

// Animated GIF for video and animated stills; a single frame for other stills.
async function exportGifFile(s) {
  if (!state.data || state.exporting || state.recording) return;
  state.exporting = true;
  updateEnabledState();
  const animated = state.media.kind === 'video' || isAnimated();
  try {
    const result = await exportGif({
      data: state.data,
      params: state.artwork.params,
      width: s.width,
      fps: s.gifFps,
      blur: s.blur,
      animated: animated,
      onProgress: (i, n) => setStatus('Rendering GIF frame ' + i + ' of ' + n + '…', false),
    });
    downloadBlob('js-rusty-animation.gif', result.blob);
    setStatus('GIF saved: ' + result.frames + ' frame(s), ' + result.width + '×' + result.height +
      ', ' + UI.formatBytes(result.blob.size) + '.', false);
  } catch (err) {
    setStatus('GIF export failed: ' + err.message, true);
  } finally {
    state.exporting = false;
    updateEnabledState();
  }
}

async function exportWebm() {
  if (!state.data || state.recording) return;
  const isVideo = state.media.kind === 'video';
  if (!isVideo && !isAnimated()) {
    setStatus('WebM needs motion: use a video source or turn on an animation type.', true);
    return;
  }
  state.recording = true;
  updateEnabledState();
  const wasPlaying = state.controller.playing;
  const seconds = isVideo ? state.data.duration : 8;
  try {
    if (isVideo) state.controller.restartClock();
    state.controller.markDirty(true);
    state.controller.setPlaying(true);
    updatePlayButton();
    const blob = await recordCanvasWebm($('render-canvas'), seconds, (f) => {
      setStatus('Recording ' + Math.round(f * 100) + '%…', false);
    }, recordFps());
    downloadBlob('js-rusty-animation.webm', blob);
    setStatus('WebM saved (' + UI.formatBytes(blob.size) + ').', false);
  } catch (err) {
    setStatus('Recording failed: ' + err.message, true);
  } finally {
    state.controller.setPlaying(wasPlaying);
    state.recording = false;
    updateEnabledState();
    updatePlayButton();
  }
}

// MP4 (H.264 or HEVC, whichever the browser records) at the chosen compression level. Like WebM, it records the
// live canvas, with the animation running.
// The frame rate of a recording: the clip's own rate for video (up to 60 frames per second), otherwise 30.
function recordFps() {
  return state.media && state.media.kind === 'video' && state.data ? Math.min(60, state.data.fps) : 30;
}

async function exportMp4(s) {
  if (!state.data || state.recording) return;
  const isVideo = state.media.kind === 'video';
  if (!isVideo && !isAnimated()) {
    setStatus('MP4 needs motion: use a video source or turn on an animation type.', true);
    return;
  }
  const mime = pickMp4Mime(s.mp4Codec);
  if (!mime) {
    setStatus('This browser cannot record MP4 with that codec.', true);
    return;
  }
  const canvas = $('render-canvas');
  const bits = mp4BitsPerSecond(canvas.width, canvas.height, s.mp4Level, recordFps());
  const codecName = s.mp4Codec === 'hevc' ? 'HEVC' : 'H.264';
  state.recording = true;
  updateEnabledState();
  const wasPlaying = state.controller.playing;
  const seconds = isVideo ? state.data.duration : 8;
  try {
    if (isVideo) state.controller.restartClock();
    state.controller.markDirty(true);
    state.controller.setPlaying(true);
    updatePlayButton();
    const blob = await recordCanvasVideo(canvas, seconds, mime, bits, (f) => {
      setStatus('Recording MP4 ' + Math.round(f * 100) + '%…', false);
    }, recordFps());
    downloadBlob('js-rusty-animation.mp4', blob);
    setStatus('MP4 saved (' + codecName + ', ' + UI.formatBytes(blob.size) + ').', false);
  } catch (err) {
    setStatus('Recording failed: ' + err.message, true);
  } finally {
    state.controller.setPlaying(wasPlaying);
    state.recording = false;
    updateEnabledState();
    updatePlayButton();
  }
}

// ---------- Keyboard ----------

function onKeyDown(e) {
  if (e.code !== 'Space' || isExportDialogOpen() || isLiveOpen()) return;
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'TEXTAREA') return;
  e.preventDefault();
  togglePlay();
}

// ---------- State helpers ----------

function setStatus(message, isError) {
  const el = $('status');
  el.hidden = !message;
  el.textContent = message;
  el.classList.toggle('error', !!isError);
  // The export window shows the same messages while it is open.
  setExportMessage(message, isError);
}

const ANIMATION_NOTES = {
  snake: 'Snakes crawl along the lines of the subject, over the algorithm.',
  pulse: 'The picture breathes and rings travel out from the centre, over the algorithm.',
  hover: 'Regions float slightly out of step with each other, over the algorithm.',
  ripple: 'A wave travels across the picture, over the algorithm.',
};

function animationNote(kind, anim) {
  if (kind === 'video') return 'Animation applies to still images only. The video plays as recorded.';
  if (anim === 'off') return 'Off: the algorithm draws a still image.';
  return ANIMATION_NOTES[anim] || '';
}

// Shows only the controls that make sense for the current algorithm and media.
function refreshControls() {
  const kind = state.media ? state.media.kind : null;
  const algo = state.params.algorithm;
  const anim = state.params.animation;
  UI.applyControlVisibility(algo, kind, state.params.pattern, anim,
    { dtMethod: state.params.dtMethod, dtPalette: state.params.dtPalette });
  UI.applyMediaVisibility(kind, isAnimated());
  // The algorithm is always available; a motion type is laid over its output.
  UI.setAlgorithmEnabled(true, '');
  UI.setAnimationEnabled(kind !== 'video');
  UI.setAnimationChoice(anim);
  UI.setAnimationNote(animationNote(kind, anim));
}

function updateEnabledState() {
  const hasData = !!state.data;
  const busy = state.processing || state.recording || state.exporting || state.loading;
  refreshControls();
  UI.setDisabled('btn-export-open', !hasData || busy);
  refreshExportDialog();
  UI.setDisabled('timeline', !(hasData && state.media.kind === 'video'));
  UI.setDisabled('btn-restart', !hasData || busy);
  UI.setDisabled('btn-play', !canTogglePlay() || busy);
}

init();
