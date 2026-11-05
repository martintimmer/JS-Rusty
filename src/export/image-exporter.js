// Raster exports: PNG and JPG of the current frame, and GIF (single frame or animation).
// The GIF is rendered on its own offscreen canvas, so the live preview is not disturbed.
// Output sizes keep the aspect ratio of the processed frames. The optional blur (Output blur in the
// export window) is applied to the exported pixels, so the saved file matches the preview.

import { createArtwork } from '../rendering/artwork.js';
import { resolvePalette, clamp, CANVAS_SCALE, STILL_LOOP_SECONDS } from '../rendering/core.js';
import { dtResolveColourSet } from '../rendering/dither/palettes.js';
import { encodeGif, gifDeltaRegions, gifRegionBytes } from './gif-encoder.js';
import { blurRGBA } from './blur.js';
import { exportConverter } from '../media/colour.js';
import { buildIccProfile, insertPngIcc, insertJpegIcc } from './icc.js';
import { exportWidth } from './javascript-exporter.js';

// A GIF holds its frames in memory while it is written: one palette index a pixel. The frame budget is what that takes
// (256 MB), so the frame count depends on the size of the frames. A 960 x 540 GIF holds about 500 frames; a 1920 x 1080
// one about 130. GIF_MAX_FRAMES is a ceiling on any size.
export const GIF_FRAME_BYTES = 256 * 1024 * 1024;
export const GIF_MAX_FRAMES = 1800;

function defaultCanvas() {
  return document.createElement('canvas');
}

// Output size for a requested width: never wider than the processed resolution.
export function outputSize(data, requestedWidth) {
  const nativeW = data.width * CANVAS_SCALE;
  const nativeH = data.height * CANVAS_SCALE;
  const w = Math.max(16, Math.min(nativeW, Math.round(requestedWidth)));
  const h = Math.max(16, Math.round((w * nativeH) / nativeW / 2) * 2);
  return { w: w, h: h };
}

// Size of a standalone export at a maximum width. Matches encodeData in javascript-exporter.js.
export function standaloneSize(data, maxWidth) {
  // The same width rule as the exporter (exportWidth), so the size shown is the size written.
  const w = exportWidth(data.width, maxWidth);
  const h = Math.max(16, Math.round((data.height * (w / data.width)) / 2) * 2);
  return { w: w, h: h };
}

// The most frames a GIF of this size can hold within the frame budget.
export function gifFrameLimit(w, h) {
  return Math.max(2, Math.min(GIF_MAX_FRAMES, Math.floor(GIF_FRAME_BYTES / Math.max(1, w * h))));
}

// Frame count, frame rate and length of a GIF of the sequence. exportGif and the export window both use it,
// so the window reports exactly what will be written.
// loopSeconds: the length of a still's loop (see stillLoopSeconds in core.js). Video uses its clip length.
// size: { w, h } of the GIF's frames, which sets how many frames fit the budget (optional).
export function gifTiming(data, fps, animated, loopSeconds, size) {
  const duration = data.duration > 0 ? data.duration : (animated ? (loopSeconds || STILL_LOOP_SECONDS) : 0);
  const wanted = animated ? Math.round(duration * fps) : 1;
  const limit = size ? gifFrameLimit(size.w, size.h) : GIF_MAX_FRAMES;
  const frameCount = animated ? Math.max(1, Math.min(limit, wanted)) : 1;
  // Only a clip that does not fit the budget at the chosen rate is sampled at a lower rate, so the GIF still covers it.
  const rate = animated && wanted > limit ? frameCount / duration : fps;
  return { duration: duration, frameCount: frameCount, rate: rate };
}

// Copies a canvas to a new canvas at the given size (high-quality resampling).
function scaledCopy(source, w, h, makeCanvas) {
  const out = makeCanvas();
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, w, h);
  return out;
}

// PNG or JPG of a canvas at the given size, with an optional blur radius in output pixels. colour ('srgb', 'rec709' or
// 'p3') is the colour space of the file: for Rec. 709 or Display P3 the pixels are converted, and the file carries the
// matching ICC profile. Resolves to a Blob.
export async function exportStill(source, format, w, h, quality, makeCanvas, blur, colour) {
  const canvas = scaledCopy(source, w, h, makeCanvas || defaultCanvas);
  const convert = colour ? exportConverter(colour) : null;
  if (blur > 0 || convert) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, w, h);
    if (blur > 0) blurRGBA(img.data, w, h, blur);
    if (convert) convert.rgbaInPlace(img.data);
    ctx.putImageData(img, 0, 0);
  }
  const mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
  const q = format === 'jpg' ? clamp(quality, 0.5, 1) : undefined;
  const blob = await new Promise((resolve, reject) => {
    if (typeof canvas.toBlob !== 'function') {
      reject(new Error('This browser cannot encode ' + format.toUpperCase() + ' images.'));
      return;
    }
    canvas.toBlob((encoded) => {
      if (encoded) resolve(encoded);
      else reject(new Error('The browser returned an empty image.'));
    }, mime, q);
  });
  if (!convert) return blob;
  return tagBlob(blob, format, colour);
}

// Adds the colour profile of a Rec. 709 or Display P3 export to a PNG or JPEG.
async function tagBlob(blob, format, colour) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const profile = buildIccProfile(colour === 'p3' ? 'p3' : 'rec709');
  const tagged = format === 'jpg' ? insertJpegIcc(bytes, profile) : await insertPngIcc(bytes, profile, deflateBytes);
  return new Blob([tagged], { type: blob.type });
}

// zlib-compressed bytes (the PNG iCCP chunk holds the profile this way).
async function deflateBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// The palette in the export colour space: the paper and ink of the ramp, converted with the pixels.
function colourPalette(pal, convert) {
  if (!convert) return pal;
  return Object.assign({}, pal, { bg: convertTriple(pal.bg, convert), stroke: convertTriple(pal.stroke, convert) });
}

// A dither palette in the export colour space, so its colours still match the converted pixels.
function colourSet(set, convert) {
  if (!set || !convert) return set;
  const rgb = new Float32Array(set.rgb.length);
  for (let k = 0; k < set.count; k++) {
    const out = new Uint8Array(3);
    convert.rgb(set.rgb[k * 3], set.rgb[k * 3 + 1], set.rgb[k * 3 + 2], out, 0);
    rgb[k * 3] = out[0] / 255;
    rgb[k * 3 + 1] = out[1] / 255;
    rgb[k * 3 + 2] = out[2] / 255;
  }
  return Object.assign({}, set, { rgb: rgb });
}

function convertTriple(rgb, convert) {
  const out = new Uint8Array(3);
  convert.rgb(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, out, 0);
  return [out[0], out[1], out[2]];
}

// Maps RGBA pixels to palette indices along the paper-to-ink line (0 = paper, 255 = ink).
function paletteIndices(rgba, bg, ink) {
  const count = rgba.length / 4;
  const out = new Uint8Array(count);
  const dr = ink[0] - bg[0];
  const dg = ink[1] - bg[1];
  const db = ink[2] - bg[2];
  const len2 = dr * dr + dg * dg + db * db || 1;
  for (let i = 0, j = 0; i < count; i++, j += 4) {
    const t = ((rgba[j] - bg[0]) * dr + (rgba[j + 1] - bg[1]) * dg + (rgba[j + 2] - bg[2]) * db) / len2;
    out[i] = clamp(Math.round(t * 255), 0, 255);
  }
  return out;
}

// Builds the 256-entry palette from paper to ink.
function gifPalette(bg, ink) {
  const palette = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    for (let c = 0; c < 3; c++) {
      palette[i * 3 + c] = Math.round(bg[c] + ((ink[c] - bg[c]) * i) / 255);
    }
  }
  return palette;
}

// The GIF palette for a dither palette: the palette's own colours, in order (up to 16).
function setGifPalette(set) {
  const palette = new Uint8Array(768);
  for (let k = 0; k < set.count; k++) {
    for (let c = 0; c < 3; c++) palette[k * 3 + c] = Math.round(set.rgb[k * 3 + c] * 255);
  }
  return palette;
}

// Nearest colour of a palette to an RGB value, by squared sRGB distance. Used for pixels that are not palette
// colours (blurred frames); exact palette colours always match their own entry.
function nearestSetColour(set, r, g, b) {
  let best = 0;
  let bestD = Infinity;
  for (let k = 0; k < set.count; k++) {
    const dr = r - set.rgb[k * 3] * 255;
    const dg = g - set.rgb[k * 3 + 1] * 255;
    const db = b - set.rgb[k * 3 + 2] * 255;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return best;
}

// Maps RGBA pixels to the palette's colour indices. Each distinct colour is looked up once per frame.
function paletteSetIndices(rgba, set) {
  const count = rgba.length / 4;
  const out = new Uint8Array(count);
  const cache = new Map();
  for (let i = 0, j = 0; i < count; i++, j += 4) {
    const r = rgba[j];
    const g = rgba[j + 1];
    const b = rgba[j + 2];
    const key = (r << 16) | (g << 8) | b;
    let q = cache.get(key);
    if (q === undefined) {
      q = nearestSetColour(set, r, g, b);
      cache.set(key, q);
    }
    out[i] = q;
  }
  return out;
}

// Size limit. A GIF can be planned to fit a target size in bytes (1 MB = 1,000,000 bytes). A few frames are rendered
// first to measure what each one costs. From those sizes the frame count and width that fit are solved for, and the
// GIF is rendered. Its real size is then checked, and the width is corrected from it for up to GIF_MAX_PASSES passes.
const GIF_PROBE_FRAMES = 6; // frames rendered to measure the size
const GIF_MIN_RATE = 8; // the planner lowers the frame rate to this (frames per second) before it narrows the picture
const GIF_MIN_WIDTH = 160; // the narrowest GIF the planner writes
const GIF_AIM = 0.97; // the planner aims this far under the target, to allow for measurement error
const GIF_CLOSE = 0.9; // a GIF from GIF_CLOSE to 100% of the target is accepted without another pass
const GIF_MAX_PASSES = 3;
const GIF_OVERHEAD = 13 + 768 + 19 + 1; // header, global palette, loop extension and trailer, in bytes

// The frame count and width that fit the budget (bytes). probe.first is the whole first frame and probe.perFrame the
// average of the frames after it, both measured at width0 with the full frame count. Fewer frames are used first, down
// to frameMin. Then the width narrows: a picture's size scales with its area, so with the square root of the ratio.
function planGifFrames(probe, budget, frameMax, frameMin, width0) {
  const fixed = GIF_OVERHEAD + probe.first;
  let frames = frameMax;
  if (probe.perFrame > 0 && fixed + (frameMax - 1) * probe.perFrame > budget) {
    frames = Math.floor((budget - fixed) / probe.perFrame) + 1;
  }
  frames = Math.min(frameMax, Math.max(frameMin, frames));
  const predicted = fixed + (frames - 1) * probe.perFrame;
  const narrowed = predicted > budget ? Math.floor(width0 * Math.sqrt(budget / predicted)) : width0;
  return { frames: frames, width: Math.min(width0, Math.max(GIF_MIN_WIDTH, narrowed)) };
}

// The width for the next pass, from the size the last pass gave. The size scales with the area of the picture.
function correctedWidth(width, bytes, target, width0) {
  const next = Math.round(width * Math.sqrt((target * GIF_AIM) / bytes));
  return Math.min(width0, Math.max(Math.min(GIF_MIN_WIDTH, width0), next));
}

// Of two passes, the one to keep: the largest GIF within the target, or the smallest if none is within it.
function keepBetter(best, result, target) {
  if (!best || !target) return result;
  const fits = result.blob.size <= target;
  const bestFits = best.blob.size <= target;
  if (fits && (!bestFits || result.blob.size > best.blob.size)) return result;
  if (!fits && !bestFits && result.blob.size < best.blob.size) return result;
  return best;
}

// Renders the artwork into a GIF.
//   data, params    processed sequence and the parameters to export
//   width           output width (height keeps the aspect ratio)
//   fps             frames per second in the GIF
//   animated        false = one frame; true = render the sequence (video or an animation type)
//   loopSeconds     length of a still's loop, which follows Speed (video uses its clip length)
//   blur            optional blur radius in output pixels, applied to every frame
//   targetBytes     optional size limit in bytes: the frame count and width are planned to fit it (0 = no limit)
//   onProgress(i, n, stage) called after each frame; stage names the pass or the probe, and may be empty
// Resolves to { blob, frames, width, height, rate, reached }. reached says whether the GIF is within the limit.
export async function exportGif(opts) {
  const { data, params, fps, animated, onProgress } = opts;
  const blur = opts.blur || 0;
  const target = opts.targetBytes > 0 ? opts.targetBytes : 0;
  const makeCanvas = opts.makeCanvas || defaultCanvas;
  // The export colour space (sRGB unless chosen). A GIF has no colour profile, so its palette is converted with its pixels.
  const convert = opts.colour ? exportConverter(opts.colour) : null;
  const pal = colourPalette(resolvePalette(params), convert);
  // A dither palette keeps its own colours. Every other case is the paper-and-ink ramp.
  const set = colourSet(params.algorithm === 'dither' ? dtResolveColourSet(params.dtPalette, params.dtColours) : null, convert);
  const palette = set ? setGifPalette(set) : gifPalette(pal.bg, pal.stroke);

  const timing = gifTiming(data, fps, animated, opts.loopSeconds, outputSize(data, opts.width));
  // A still's GIF covers exactly its frames, so its loop is that long. Motion closes over this length, and the last
  // frame leads straight into the first. A video's motion accumulates over its frames, as it does live.
  const isVideoClip = data.duration > 0;
  const live = makeCanvas();
  const art = createArtwork(live, data);
  art.setParams(params);

  // The first `rendered` frames of a GIF of frameCount frames at this rate, at this width. frameCount sets the loop,
  // so a probe of the full plan sees the same frames as the export does. Each call starts the artwork at frame 0.
  async function renderFrames(width, frameCount, rate, rendered, stage) {
    const size = outputSize(data, width);
    const dt = 1 / rate;
    const loop = animated && !isVideoClip ? frameCount * dt : 0;
    const scaled = makeCanvas();
    scaled.width = size.w;
    scaled.height = size.h;
    const sctx = scaled.getContext('2d', { willReadFrequently: true });
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = 'high';
    const frames = [];
    for (let i = 0; i < rendered; i++) {
      // Video frames follow the source clock; animated stills step their clock by dt.
      const t = animated ? i * dt : 0;
      art.render(t, i === 0 ? 0 : (animated ? dt : 0), { reset: i === 0, loop: loop });
      sctx.clearRect(0, 0, size.w, size.h);
      sctx.drawImage(live, 0, 0, size.w, size.h);
      const img = sctx.getImageData(0, 0, size.w, size.h);
      if (blur > 0) blurRGBA(img.data, size.w, size.h, blur);
      if (convert) convert.rgbaInPlace(img.data);
      frames.push(set ? paletteSetIndices(img.data, set) : paletteIndices(img.data, pal.bg, pal.stroke));
      if (onProgress) onProgress(i + 1, rendered, stage);
      // Yield to the UI now and then, so the page stays responsive during long exports.
      if (i % 3 === 2) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return { size: size, frames: frames };
  }

  // Frame rate of a GIF of count frames: the chosen rate, or for a shorter plan the same loop at fewer frames.
  const rateFor = (count) => (count === timing.frameCount ? timing.rate : count / timing.duration);
  const fullWidth = outputSize(data, opts.width).w;
  let plan = { frames: timing.frameCount, width: fullWidth };

  if (target) {
    // Measure the first frames of the full plan, as they would be written. Those sizes solve for the plan.
    const probe = await renderFrames(fullWidth, timing.frameCount, timing.rate,
      Math.min(timing.frameCount, GIF_PROBE_FRAMES), 'Measuring the size');
    const regions = gifDeltaRegions(probe.frames, probe.size.w, probe.size.h);
    const bytes = regions.map(gifRegionBytes);
    const perFrame = bytes.length > 1 ? bytes.slice(1).reduce((a, b) => a + b, 0) / (bytes.length - 1) : 0;
    // An animation keeps GIF_MIN_RATE frames a second at least. A still or a short clip keeps all its frames.
    const frameMin = animated
      ? Math.min(timing.frameCount, Math.max(1, Math.ceil(GIF_MIN_RATE * timing.duration)))
      : timing.frameCount;
    plan = planGifFrames({ first: bytes[0], perFrame: perFrame }, target * GIF_AIM, timing.frameCount, frameMin, fullWidth);
  }

  let best = null;
  for (let pass = 1; ; pass++) {
    const rate = rateFor(plan.frames);
    const stage = target ? 'Pass ' + pass + ' of up to ' + GIF_MAX_PASSES : '';
    const drawn = await renderFrames(plan.width, plan.frames, rate, plan.frames, stage);
    const blob = encodeGif({
      width: drawn.size.w,
      height: drawn.size.h,
      palette: palette,
      frames: drawn.frames,
      delayCs: 100 / rate,
      loop: 0,
    });
    const result = {
      blob: blob,
      frames: plan.frames,
      width: drawn.size.w,
      height: drawn.size.h,
      rate: rate,
      reached: !target || blob.size <= target,
    };
    best = keepBetter(best, result, target);
    // Without a limit, or with a GIF that is within the limit and close to it, the pass is final.
    if (!target || (blob.size <= target && blob.size >= target * GIF_CLOSE) || pass >= GIF_MAX_PASSES) break;
    const width = correctedWidth(plan.width, blob.size, target, fullWidth);
    if (width === plan.width) break;
    plan = { frames: plan.frames, width: width };
  }
  return best;
}
