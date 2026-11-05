// Loads still images and converts them into a grayscale analysis frame, plus a colour copy at the analysis size
// (the Dither engine's colour mode reads it).
import { drawView } from './view.js';

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export async function loadImage(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch (err) {
    URL.revokeObjectURL(url);
    throw new Error('The image could not be decoded by this browser.');
  }
  return {
    element: img,
    url: url,
    width: img.naturalWidth,
    height: img.naturalHeight,
  };
}

// Draws the view of the image (its crop, turned) at the display size, and at half size for analysis. Returns it as a
// one-frame sequence, in the same shape as extractFrames().
export function imageToFrames(img, width, height, view) {
  const aw = width / 2;
  const ah = height / 2;
  const full = rgbaToGray(drawPixels(img, width, height, view), width * height);
  const smallPx = drawPixels(img, aw, ah, view);
  return {
    frames: [full],
    analysisFrames: [rgbaToGray(smallPx, aw * ah)],
    analysisColour: [rgbaToRgb(smallPx, aw * ah)],
    analysisWidth: aw,
    analysisHeight: ah,
    count: 1,
    fps: 1,
    duration: 0,
  };
}

// The RGBA pixels of the view of the source, drawn at w x h.
function drawPixels(source, w, h, view) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  drawView(ctx, source, view, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

// Rec. 601 luma using integer arithmetic.
export function rgbaToGray(rgba, pixels) {
  const out = new Uint8Array(pixels);
  for (let i = 0, j = 0; i < pixels; i++, j += 4) {
    out[i] = (77 * rgba[j] + 150 * rgba[j + 1] + 29 * rgba[j + 2]) >> 8;
  }
  return out;
}

// The colour of each pixel as r, g, b bytes (alpha is dropped).
export function rgbaToRgb(rgba, pixels) {
  const out = new Uint8Array(pixels * 3);
  for (let i = 0, j = 0, k = 0; i < pixels; i++, j += 4, k += 3) {
    out[k] = rgba[j];
    out[k + 1] = rgba[j + 1];
    out[k + 2] = rgba[j + 2];
  }
  return out;
}
