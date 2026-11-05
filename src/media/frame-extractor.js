// Samples a loaded video at a fixed rate by seeking. Frame k is taken at k / fps.
// Each sample is drawn twice: at the display size (full detail for rendering) and at
// half size (for motion estimation, which runs faster on less data).

import { rgbaToGray, rgbaToRgb } from './image-loader.js';


// Returns { frames, analysisFrames, analysisColour, count, fps, duration }. The rate is the one asked for: every
// frame at that rate is sampled, so the artwork plays at the clip's own speed. The caller limits the frame count.
export async function extractFrames(video, options) {
  const { fps, width, height, duration, onProgress, view } = options;
  const start = options.start || 0;
  const count = Math.max(1, Math.floor(duration * fps + 1e-6));
  const rate = fps;
  const aw = width / 2;
  const ah = height / 2;
  const full = makeContext(width, height);
  const small = makeContext(aw, ah);
  const frames = new Array(count);
  const analysisFrames = new Array(count);
  const analysisColour = new Array(count);

  for (let k = 0; k < count; k++) {
    const t = start + Math.min(k / rate, Math.max(0, duration - 0.02));
    await seekTo(video, t);
    drawView(full.ctx, video, view, width, height);
    frames[k] = rgbaToGray(full.ctx.getImageData(0, 0, width, height).data, width * height);
    drawView(small.ctx, video, view, aw, ah);
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

// Picks how the clip is read. A clip the browser can seek is sampled by seeking. A clip it cannot seek (a MediaRecorder
// recording has no index, and a seek may never land) is sampled by playing it once. The frames are the same either way.
import { drawView } from './view.js';

// options: fps, width, height (the output size), duration (the trimmed length), start (the trim's first frame, in
// seconds of the clip), view (the crop and turn, see view.js), onProgress.
export async function extractVideoFrames(video, options) {
  const start = options.start || 0;
  const seekable = await canSeek(video, start + options.duration / 2);
  if (seekable) return extractFrames(video, options);
  return extractFramesByPlayback(video, options);
}

// True when a seek to the middle of the clip lands within 0.1 s, within half a second.
function canSeek(video, targetTime) {
  if (!video.seekable || video.seekable.length === 0) return Promise.resolve(false);
  const target = Math.max(0, targetTime);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      resolve(ok);
    };
    const onSeeked = () => finish(Math.abs(video.currentTime - target) < 0.1);
    const timer = setTimeout(() => finish(false), 500);
    video.addEventListener('seeked', onSeeked);
    video.currentTime = target;
  });
}

// Samples a clip by playing it once, muted, at its own speed. Sample k takes the frame nearest to k / fps, as the
// browser presents it. A clip that ends before the last sample repeats its last frame.
function extractFramesByPlayback(video, options) {
  const { fps, width, height, duration, onProgress, view } = options;
  const start = options.start || 0;
  const count = Math.max(1, Math.floor(duration * fps + 1e-6));
  const rate = fps;
  const aw = width / 2;
  const ah = height / 2;
  const full = makeContext(width, height);
  const small = makeContext(aw, ah);
  const frames = new Array(count);
  const analysisFrames = new Array(count);
  const analysisColour = new Array(count);
  let k = 0;

  const take = () => {
    drawView(full.ctx, video, view, width, height);
    frames[k] = rgbaToGray(full.ctx.getImageData(0, 0, width, height).data, width * height);
    drawView(small.ctx, video, view, aw, ah);
    const smallPx = small.ctx.getImageData(0, 0, aw, ah).data;
    analysisFrames[k] = rgbaToGray(smallPx, aw * ah);
    analysisColour[k] = rgbaToRgb(smallPx, aw * ah);
    k++;
    if (onProgress) onProgress(k / count);
  };

  return new Promise((resolve, reject) => {
    if (typeof video.requestVideoFrameCallback !== 'function') {
      reject(new Error('This browser cannot read this clip frame by frame.'));
      return;
    }
    let finished = false;
    const onFrame = (now, meta) => {
      if (finished) return;
      const t = meta.mediaTime;
      // Sample k is the frame nearest to k / fps: this frame is that one when it is within half a frame of the time.
      while (k < count && t >= start + (k - 0.5) / rate) take();
      if (k >= count || video.ended) {
        finish();
        return;
      }
      video.requestVideoFrameCallback(onFrame);
    };
    // Safety: the playback cannot take longer than the clip, plus a margin.
    const limit = setTimeout(finish, (duration + 5) * 1000);

    function finish() {
      if (finished) return;
      finished = true;
      clearTimeout(limit);
      video.pause();
      if (k === 0) {
        reject(new Error('The clip could not be played to read its frames.'));
        return;
      }
      for (let i = k; i < count; i++) {
        frames[i] = frames[k - 1];
        analysisFrames[i] = analysisFrames[k - 1];
        analysisColour[i] = analysisColour[k - 1];
      }
      if (onProgress) onProgress(1);
      resolve({
        frames: frames,
        analysisFrames: analysisFrames,
        analysisColour: analysisColour,
        analysisWidth: aw,
        analysisHeight: ah,
        count: count,
        fps: rate,
        duration: count / rate,
      });
    }

    video.muted = true;
    video.playbackRate = 1;
    video.currentTime = 0;
    video.requestVideoFrameCallback(onFrame);
    video.play().catch(() => finish());
  });
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
