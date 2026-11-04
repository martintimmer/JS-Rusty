// Raster exports: PNG and JPG of the current frame, and GIF (single frame or animation).
// The GIF is rendered on its own offscreen canvas, so the live preview is not disturbed.
// Output sizes keep the aspect ratio of the processed frames. The optional blur (Output blur in the
// export window) is applied to the exported pixels, so the saved file matches the preview.

import { createArtwork } from '../rendering/artwork.js';
import { resolvePalette, clamp, CANVAS_SCALE } from '../rendering/core.js';
import { dtResolveColourSet } from '../rendering/dither/palettes.js';
import { encodeGif } from './gif-encoder.js';
import { blurRGBA } from './blur.js';

export const GIF_MAX_FRAMES = 150;
export const STILL_STATIC_SECONDS = 6; // animation length for an animated still image

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
  const w = Math.max(16, Math.min(data.width, Math.round(maxWidth || data.width)));
  const h = Math.max(16, Math.round((data.height * (w / data.width)) / 2) * 2);
  return { w: w, h: h };
}

// Frame count, frame rate and length of a GIF of the sequence. exportGif and the export window both use it,
// so the window reports exactly what will be written.
export function gifTiming(data, fps, animated) {
  const duration = data.duration > 0 ? data.duration : (animated ? STILL_STATIC_SECONDS : 0);
  const wanted = animated ? Math.round(duration * fps) : 1;
  const frameCount = animated ? Math.max(1, Math.min(GIF_MAX_FRAMES, wanted)) : 1;
  // A clip longer than GIF_MAX_FRAMES at the chosen rate is sampled at a lower rate, so the GIF covers all of it.
  const rate = animated && wanted > GIF_MAX_FRAMES ? frameCount / duration : fps;
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

// PNG or JPG of a canvas at the given size, with an optional blur radius in output pixels.
// Resolves to a Blob.
export function exportStill(source, format, w, h, quality, makeCanvas, blur) {
  const canvas = scaledCopy(source, w, h, makeCanvas || defaultCanvas);
  if (blur > 0) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, w, h);
    blurRGBA(img.data, w, h, blur);
    ctx.putImageData(img, 0, 0);
  }
  const mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
  const q = format === 'jpg' ? clamp(quality, 0.5, 1) : undefined;
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob !== 'function') {
      reject(new Error('This browser cannot encode ' + format.toUpperCase() + ' images.'));
      return;
    }
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('The browser returned an empty image.'));
    }, mime, q);
  });
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

// Renders the artwork into a GIF.
//   data, params    processed sequence and the parameters to export
//   width           output width (height keeps the aspect ratio)
//   fps             frames per second in the GIF
//   animated        false = one frame; true = render the sequence (video or an animation type)
//   blur            optional blur radius in output pixels, applied to every frame
//   onProgress(i, n) called after each frame
// Resolves to { blob, frames, width, height }.
export async function exportGif(opts) {
  const { data, params, fps, animated, onProgress } = opts;
  const blur = opts.blur || 0;
  const makeCanvas = opts.makeCanvas || defaultCanvas;
  const size = outputSize(data, opts.width);
  const pal = resolvePalette(params);
  // A dither palette keeps its own colours. Every other case is the paper-and-ink ramp.
  const set = params.algorithm === 'dither' ? dtResolveColourSet(params.dtPalette, params.dtColours) : null;
  const palette = set ? setGifPalette(set) : gifPalette(pal.bg, pal.stroke);

  const timing = gifTiming(data, fps, animated);
  const frameCount = timing.frameCount;
  const dt = 1 / timing.rate;

  const live = makeCanvas();
  const art = createArtwork(live, data);
  art.setParams(params);
  const scaled = makeCanvas();
  scaled.width = size.w;
  scaled.height = size.h;
  const sctx = scaled.getContext('2d', { willReadFrequently: true });
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';

  const frames = [];
  for (let i = 0; i < frameCount; i++) {
    // Video frames follow the source clock; animated stills step their clock by dt.
    const t = animated ? i * dt : 0;
    art.render(t, i === 0 ? 0 : (animated ? dt : 0), { reset: i === 0 });
    sctx.clearRect(0, 0, size.w, size.h);
    sctx.drawImage(live, 0, 0, size.w, size.h);
    const img = sctx.getImageData(0, 0, size.w, size.h);
    if (blur > 0) blurRGBA(img.data, size.w, size.h, blur);
    frames.push(set ? paletteSetIndices(img.data, set) : paletteIndices(img.data, pal.bg, pal.stroke));
    if (onProgress) onProgress(i + 1, frameCount);
    // Yield to the UI now and then, so the page stays responsive during long exports.
    if (i % 3 === 2) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const blob = encodeGif({
    width: size.w,
    height: size.h,
    palette: palette,
    frames: frames,
    delayCs: 100 / timing.rate,
    loop: 0,
  });
  return { blob: blob, frames: frameCount, width: size.w, height: size.h };
}
