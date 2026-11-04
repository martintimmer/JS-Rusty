// Samples a loaded video at a fixed rate by seeking. Frame k is taken at k / fps.
// Each sample is drawn twice: at the display size (full detail for rendering) and at
// half size (for motion estimation, which runs faster on less data).

import { rgbaToGray, rgbaToRgb } from './image-loader.js';
import { frameLimit } from '../device.js';


// Returns { frames, analysisFrames, count, fps, duration }. fps in the result is the rate actually used.
// A clip that would need more than frameLimit() frames at the chosen rate is sampled at a lower rate
// instead, so the whole clip is covered (it is not cut short).
export async function extractFrames(video, options) {
  const { fps, width, height, duration, onProgress } = options;
  const limit = frameLimit();
  const wanted = Math.floor(duration * fps + 1e-6);
  const count = Math.max(1, Math.min(wanted, limit));
  const rate = wanted > limit ? count / duration : fps;
  const aw = width / 2;
  const ah = height / 2;
  const full = makeContext(width, height);
  const small = makeContext(aw, ah);
  const frames = new Array(count);
  const analysisFrames = new Array(count);
  const analysisColour = new Array(count);

  for (let k = 0; k < count; k++) {
    const t = Math.min(k / rate, Math.max(0, duration - 0.02));
    await seekTo(video, t);
    full.ctx.drawImage(video, 0, 0, width, height);
    frames[k] = rgbaToGray(full.ctx.getImageData(0, 0, width, height).data, width * height);
    small.ctx.drawImage(video, 0, 0, aw, ah);
    const smallPx = small.ctx.getImageData(0, 0, aw, ah).data;
    analysisFrames[k] = rgbaToGray(smallPx, aw * ah);
    analysisColour[k] = rgbaToRgb(smallPx, aw * ah);
    if (onProgress) onProgress((k + 1) / count);
  }

  return {
    frames: frames,
    analysisFrames: analysisFrames,
    analysisColour: analysisColour,
    analysisWidth: aw,
    analysisHeight: ah,
    count: count,
    fps: rate,
    duration: count / rate,
  };
}

function makeContext(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return { canvas: canvas, ctx: ctx };
}

function seekTo(video, t) {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - t) < 0.0005 && video.readyState >= 2) {
      resolve();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeEventListener('seeked', finish);
      resolve();
    };
    // Fallback so a stalled seek cannot hang the whole pipeline.
    const timer = setTimeout(finish, 2000);
    video.addEventListener('seeked', finish);
    video.currentTime = t;
  });
}
