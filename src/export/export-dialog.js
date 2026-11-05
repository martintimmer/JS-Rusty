// Export window. It holds the format, the output size and its options (width, JPG quality, GIF frame rate,
// Output blur), and shows a preview of the centre of the output at its real size, with the blur applied.
// It is opened from the Export button in the left sidebar. The export itself runs in app.js: this module
// collects the settings and reports them through onExport(settings). The size and timing shown are
// computed by the same functions the exporters use, so they match what is written.

import { outputSize, standaloneSize, gifTiming } from './image-exporter.js';
import { loopFrameTiming, packedLoopTiming, STANDALONE_WINDOW_BYTES } from './javascript-exporter.js';
import { blurRGBA } from './blur.js';

const $ = (id) => document.getElementById(id);

// The preview is a crop of the output at its real size. A smaller preview would hide a blur of a pixel or two.
const PREVIEW_W = 320;
const PREVIEW_H = 200;

const FORMAT_ORDER = ['png', 'jpg', 'gif', 'webm', 'mp4', 'html', 'js'];
const FORMATS = {
  png: { label: 'PNG', blur: true },
  jpg: { label: 'JPG', blur: true },
  gif: { label: 'GIF', blur: true },
  webm: { label: 'WebM', blur: false },
  mp4: { label: 'MP4', blur: false },
  html: { label: 'HTML', blur: false },
  js: { label: 'JS', blur: false },
};

// Which option groups each format shows.
const SHOWN = {
  png: ['raster', 'colour', 'blur'],
  jpg: ['raster', 'quality', 'colour', 'blur'],
  gif: ['raster', 'gif', 'colour', 'blur'],
  webm: [],
  mp4: ['mp4'],
  html: ['standalone', 'loopRender', 'loopFps', 'loopRepeat'],
  js: ['standalone', 'loopRender', 'loopFps'],
};

// The colour choices each format can carry. PNG and JPG get a colour profile in the file. A GIF has no profile, so it
// takes Rec. 709 values only, which a viewer shows as sRGB. Movies and the HTML and JS pages stay sRGB.
const COLOUR_CHOICES = {
  png: ['srgb', 'rec709', 'p3'],
  jpg: ['srgb', 'rec709', 'p3'],
  gif: ['srgb', 'rec709'],
};
const COLOUR_NOTES = {
  rec709: 'Rec. 709: the colours are encoded with the Rec. 709 curve, and the file says so.',
  p3: 'Display P3: the colours are converted to the P3 gamut, and the file carries the Display P3 profile.',
  gifRec709: 'Rec. 709 values in a GIF, which has no colour profile. Viewers show them as sRGB, so the difference is only the curve.',
  // The preview is sRGB, so colour outside sRGB in a wide-gamut clip is already clipped when the frames are sampled.
  p3Clipped: 'This clip has colour beyond sRGB, which the preview clips to sRGB, so the P3 file keeps only the colours sRGB shows.',
};

const NOTES = {
  png: 'Blur is applied to the saved file as well as to the preview.',
  jpg: 'Blur is applied to the saved file as well as to the preview.',
  gif: '256-colour GIF. Blur is applied to every frame. The frame rate you choose is kept as long as the frames fit the memory budget (about 500 frames at 960 × 540 px, fewer at larger sizes). A longer clip is sampled at a lower rate, so the whole clip is still covered.',
  webm: 'Recorded live from the canvas at its own size, in sRGB. Width and blur do not apply.',
  mp4: 'Recorded live from the canvas at its own size, as H.264 or HEVC in an MP4 file, in sRGB. Compression sets the bit rate. Width and blur do not apply.',
  html: 'A standalone page that embeds the renderer and the frames, in sRGB. Blur does not apply.',
  js: 'A standalone module that embeds the renderer and the frames, in sRGB. Blur does not apply.',
};

// Dither artwork is exported as packed palette indices at the processed size, so the width does not apply.
const PACKED_NOTE = 'Dither artwork is packed as palette indices at the processed size and coded losslessly. Width and blur do not apply.';
const PACKED_LOOP_NOTE = 'An animated still is exported as a loop of frames at the Loop fps, so the page moves.';
// Added to the GIF note when a size limit is set. The export plans the frame rate and width to fit it.
const GIF_LIMIT_NOTE = 'The frame rate and width are planned to fit the size limit, and the file is checked before it is saved. 1 MB is 1,000,000 bytes.';

// loopMode: 'live' (the page runs the animation) or 'frames' (the page plays a rendered loop); loopFps is that loop's
// frame rate, and loopRepeat says whether the page repeats it. gifTargetMB is the GIF size limit in megabytes (0 = none).
const settings = {
  format: 'png', width: 1920, standaloneWidth: 960, quality: 92, gifFps: 12, gifTargetMB: 0, blur: 0, colour: 'srgb', mp4Codec: 'h264', mp4Level: 'medium',
  loopMode: 'live', loopFps: 12, loopRepeat: true,
};
let options = null;
let open = false;

// options:
//   getSource()  -> { canvas, data, isVideo, animated, loopSeconds, recordSeconds } for the current artwork, or null
//   isBusy()     -> true while processing, recording or exporting
//   canWebm      -> true when the browser can record WebM
//   mp4Codecs    -> the MP4 codecs ('h264', 'hevc') the browser can record; an empty list hides MP4
//   onExport(s)  -> runs the export for settings s (returns a promise)
export function initExportDialog(opts) {
  options = opts;
  for (const button of document.querySelectorAll('#export-formats .seg')) {
    button.addEventListener('click', () => {
      if (button.disabled) return;
      settings.format = button.dataset.format;
      refresh();
    });
  }
  $('export-width').addEventListener('change', onInput);
  $('export-standalone-width').addEventListener('change', onInput);
  $('export-quality').addEventListener('input', onInput);
  $('export-gif-fps').addEventListener('change', onInput);
  $('export-gif-limit').addEventListener('change', onInput);
  $('export-colour').addEventListener('change', onInput);
  $('export-loop-mode').addEventListener('change', onInput);
  $('export-loop-fps').addEventListener('change', onInput);
  $('export-loop-repeat').addEventListener('change', onInput);
  $('export-blur').addEventListener('input', onInput);
  $('export-mp4-codec').addEventListener('change', onInput);
  $('export-mp4-level').addEventListener('change', onInput);
  applyMp4Support();
  $('export-close').addEventListener('click', closeExportDialog);
  $('export-cancel').addEventListener('click', closeExportDialog);
  $('export-backdrop').addEventListener('click', (e) => {
    if (e.target === $('export-backdrop')) closeExportDialog();
  });
  $('export-run').addEventListener('click', runExport);
  window.addEventListener('keydown', (e) => {
    if (open && e.key === 'Escape') closeExportDialog();
  });
  readControls();
  refresh();
}

export function openExportDialog() {
  if (!options) return;
  open = true;
  $('export-backdrop').hidden = false;
  refresh();
  const active = document.querySelector('#export-formats .seg.active');
  if (active) active.focus();
}

export function closeExportDialog() {
  open = false;
  $('export-backdrop').hidden = true;
}

export function isExportDialogOpen() {
  return open;
}

// Called when the app's state changes (processing, export, recording), so the window stays current.
export function refreshExportDialog() {
  if (open) refresh();
}

// Shows a message from an export in the window (the app mirrors its status line here).
export function setExportMessage(text, isError) {
  const el = $('export-status');
  el.hidden = !text;
  el.textContent = text || '';
  el.classList.toggle('error', !!isError);
}

// Only the MP4 codecs this browser can record are enabled. If the chosen one is not available, the first
// available one is chosen. With none available, the MP4 format is not offered (see available()).
function applyMp4Support() {
  const supported = (options && options.mp4Codecs) || [];
  const select = $('export-mp4-codec');
  for (const option of select.options) {
    option.disabled = supported.indexOf(option.value) < 0;
  }
  if (supported.length && supported.indexOf(settings.mp4Codec) < 0) settings.mp4Codec = supported[0];
  select.value = settings.mp4Codec;
}

function onInput() {
  readControls();
  refresh();
}

function readControls() {
  settings.width = Number($('export-width').value);
  settings.standaloneWidth = Number($('export-standalone-width').value);
  settings.quality = Number($('export-quality').value);
  settings.gifFps = Number($('export-gif-fps').value);
  settings.gifTargetMB = Number($('export-gif-limit').value);
  settings.loopMode = $('export-loop-mode').value;
  settings.loopFps = Number($('export-loop-fps').value);
  settings.loopRepeat = $('export-loop-repeat').value === 'yes';
  settings.blur = Number($('export-blur').value);
  settings.colour = $('export-colour').value;
  settings.mp4Codec = $('export-mp4-codec').value;
  settings.mp4Level = $('export-mp4-level').value;
  $('export-quality-val').textContent = String(settings.quality);
  $('export-blur-val').textContent = settings.blur > 0 ? settings.blur + ' px' : 'Off';
}

function runExport() {
  const src = options.getSource();
  if (!src || options.isBusy() || !available(settings.format, src)) return;
  readControls();
  const format = settings.format;
  const result = options.onExport({
    format: format,
    width: settings.width,
    standaloneWidth: settings.standaloneWidth,
    quality: settings.quality / 100,
    gifFps: settings.gifFps,
    gifTargetMB: settings.gifTargetMB,
    loopMode: settings.loopMode,
    loopFps: settings.loopFps,
    loopRepeat: settings.loopRepeat,
    blur: FORMATS[format].blur ? settings.blur : 0,
    colour: colourFor(format, settings.colour),
    mp4Codec: settings.mp4Codec,
    mp4Level: settings.mp4Level,
  });
  refresh();
  return result;
}

// The colour an export of this format is written in: the chosen one where the format can carry it, otherwise sRGB.
function colourFor(format, colour) {
  const choices = COLOUR_CHOICES[format];
  return choices && choices.indexOf(colour) >= 0 ? colour : 'srgb';
}

// Shows only the colour choices the current format can carry (Display P3 is not offered for a GIF).
function syncColour() {
  const select = $('export-colour');
  const choices = COLOUR_CHOICES[settings.format] || ['srgb'];
  for (const option of select.options) option.disabled = choices.indexOf(option.value) < 0;
  settings.colour = colourFor(settings.format, settings.colour);
  select.value = settings.colour;
}

function colourNoteFor(format, colour) {
  if (colour === 'srgb') return '';
  if (colour === 'p3') return COLOUR_NOTES.p3;
  return format === 'gif' ? COLOUR_NOTES.gifRec709 : COLOUR_NOTES.rec709;
}

// Whether a format can be exported from the current artwork. Stills are PNG and JPG; WebM needs motion.
function available(format, src) {
  if (!src) return false;
  if (format === 'png' || format === 'jpg') return !src.isVideo;
  if (format === 'webm') return !!options.canWebm && src.animated;
  if (format === 'mp4') return !!options.mp4Codecs && options.mp4Codecs.length > 0 && src.animated;
  return true;
}

function refresh() {
  if (!options) return;
  const src = options.getSource();
  const busy = options.isBusy();
  if (src && !available(settings.format, src)) {
    const first = FORMAT_ORDER.find((f) => available(f, src));
    if (first) settings.format = first;
  }
  for (const button of document.querySelectorAll('#export-formats .seg')) {
    const format = button.dataset.format;
    const on = format === settings.format;
    button.classList.toggle('active', on);
    button.setAttribute('aria-checked', on ? 'true' : 'false');
    button.disabled = !available(format, src) || busy;
  }
  const packed = !!src && !!src.packed && (settings.format === 'html' || settings.format === 'js');
  // A rendered loop needs an animated still that is not packed Dither. The repeat choice also serves a video.
  const framesAvailable = !!src && src.animated && !src.isVideo && !packed;
  const framesOn = framesAvailable && settings.loopMode === 'frames' && (settings.format === 'html' || settings.format === 'js');
  // A Dither still that animates is always a loop, at the Loop fps.
  const packedLoop = packed && !src.isVideo && src.animated;
  for (const field of document.querySelectorAll('[data-export]')) {
    const group = field.dataset.export;
    let show = SHOWN[settings.format].indexOf(group) >= 0;
    if (group === 'standalone') show = show && !packed;
    if (group === 'loopRender') show = show && framesAvailable;
    if (group === 'loopFps') show = show && (framesOn || packedLoop);
    // Repeat means something for a video, and for a loop; a live still runs on by itself.
    if (group === 'loopRepeat') show = show && !!src && (src.isVideo || framesOn || packedLoop);
    field.hidden = !show;
  }
  syncColour();
  let note = packed ? PACKED_NOTE : NOTES[settings.format];
  if (packedLoop) note += ' ' + PACKED_LOOP_NOTE;
  if (settings.format === 'gif' && settings.gifTargetMB > 0) note += ' ' + GIF_LIMIT_NOTE;
  const chosenColour = colourFor(settings.format, settings.colour);
  const colourNote = colourNoteFor(settings.format, chosenColour);
  if (colourNote) note += ' ' + colourNote;
  if (chosenColour === 'p3' && src && src.wideGamut) note += ' ' + COLOUR_NOTES.p3Clipped;
  $('export-note').textContent = note;
  $('export-size').textContent = describe(src);
  $('export-run').disabled = !src || busy || !available(settings.format, src);
  $('export-run').textContent = 'Export ' + FORMATS[settings.format].label;
  renderPreview(src);
}

// Output size in pixels for the current format and settings.
function dimsFor(src) {
  const d = src.data;
  const format = settings.format;
  if (format === 'png' || format === 'jpg' || format === 'gif') return outputSize(d, settings.width);
  if (format === 'webm' || format === 'mp4') return { w: d.width, h: d.height };
  if (src.packed) return { w: d.width, h: d.height };
  return standaloneSize(d, settings.standaloneWidth);
}

function describe(src) {
  if (!src) return 'No artwork yet. Upload and process media to export.';
  const dims = dimsFor(src);
  const size = dims.w + ' × ' + dims.h + ' px';
  const format = settings.format;
  if (format === 'png' || format === 'jpg') return size + ' · ' + FORMATS[format].label;
  if (format === 'gif') {
    const t = gifTiming(src.data, settings.gifFps, src.animated, src.loopSeconds, dims);
    const frames = t.frameCount === 1 ? '1 frame' : t.frameCount + ' frames at ' + t.rate.toFixed(1) + ' fps';
    const limit = settings.gifTargetMB > 0 ? ' · up to ' + settings.gifTargetMB + ' MB' : '';
    return size + ' · ' + frames + ' · ' + (src.animated ? t.duration.toFixed(1) + ' s loop' : 'still') + limit;
  }
  if (format === 'webm' || format === 'mp4') return size + ' · ' + FORMATS[format].label + ' · ' + src.recordSeconds.toFixed(1) + ' s recording';
  if ((format === 'html' || format === 'js') && src.packed && src.animated && !src.isVideo) {
    const t = packedLoopTiming(src.loopSeconds, settings.loopFps, src.data.width * src.data.height);
    return size + ' · ' + t.count + ' loop frames at ' + t.rate.toFixed(1) + ' fps · ' + t.seconds.toFixed(1) + ' s loop';
  }
  if ((format === 'html' || format === 'js') && settings.loopMode === 'frames' && src.animated && !src.isVideo && !src.packed) {
    const timing = loopFrameTiming(src.loopSeconds, settings.loopFps, dims.w * dims.h * 3);
    return size + ' · ' + timing.count + ' loop frames at ' + timing.rate.toFixed(1) + ' fps · ' +
      timing.seconds.toFixed(1) + ' s loop';
  }
  // A page holds its frames in memory when they are small. A longer clip is decoded as it plays, a few frames at a time.
  const bytes = src.data.count * dims.w * dims.h;
  const memory = bytes > STANDALONE_WINDOW_BYTES
    ? ' · the page decodes its frames as it plays'
    : ' · about ' + Math.round(bytes / 1e6) + ' MB in the page';
  return size + ' · standalone · ' + src.data.count + ' frames' + memory;
}

// Draws the centre of the output at its real size: the crop is taken from the artwork canvas, scaled to
// the output resolution, and blurred with the same radius the export uses.
function renderPreview(src) {
  const canvas = $('export-preview');
  const caption = $('export-preview-note');
  if (!src) {
    canvas.hidden = true;
    $('export-preview-empty').hidden = false;
    caption.textContent = '';
    return;
  }
  canvas.hidden = false;
  $('export-preview-empty').hidden = true;
  const dims = dimsFor(src);
  const scale = dims.w / src.canvas.width;
  const cw = Math.min(PREVIEW_W, dims.w);
  const ch = Math.min(PREVIEW_H, dims.h);
  const sx = (dims.w - cw) / 2 / scale;
  const sy = (dims.h - ch) / 2 / scale;
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src.canvas, sx, sy, cw / scale, ch / scale, 0, 0, cw, ch);
  const blurs = FORMATS[settings.format].blur && settings.blur > 0;
  if (blurs) {
    const img = ctx.getImageData(0, 0, cw, ch);
    blurRGBA(img.data, cw, ch, settings.blur);
    ctx.putImageData(img, 0, 0);
  }
  caption.textContent = '1:1 crop of the centre, at output size' +
    (FORMATS[settings.format].blur ? (blurs ? ' · blur ' + settings.blur + ' px' : ' · no blur') : '');
}
