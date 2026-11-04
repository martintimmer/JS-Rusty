// Loads a video into the shared <video> element and validates it against MVP limits.

// The longest clip accepted when it loads. The frame limit (MAX_FRAMES in device.js) applies once the rate is known.
export const MAX_VIDEO_SECONDS = 200;

// Estimates the source frame rate. The clip is played muted for up to `seconds` of media time, and the
// media time of each presented frame is read with requestVideoFrameCallback. The rate is 1 / (median
// gap between presented frames), rounded to two decimals. Resolves to null when the browser cannot report
// frames or the clip is too short to measure. The caller decides the fallback.
export function estimateFrameRate(videoEl, seconds) {
  const span = seconds > 0 ? seconds : 1;
  return new Promise((resolve) => {
    if (typeof videoEl.requestVideoFrameCallback !== 'function') {
      resolve(null);
      return;
    }
    const times = [];
    let done = false;
    let timer = null;
    const finish = (rate) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      videoEl.pause();
      resolve(rate);
    };
    const onFrame = (now, meta) => {
      if (done) return;
      times.push(meta.mediaTime);
      if (meta.mediaTime < span && times.length < 40) {
        videoEl.requestVideoFrameCallback(onFrame);
        return;
      }
      const gaps = [];
      for (let i = 1; i < times.length; i++) {
        const gap = times[i] - times[i - 1];
        // Repeated frames (gap 0) and the wrap of a looping clip (negative gap) are ignored.
        if (gap > 1e-4) gaps.push(gap);
      }
      if (gaps.length < 3) {
        finish(null);
        return;
      }
      gaps.sort((a, b) => a - b);
      finish(Math.round(100 / gaps[gaps.length >> 1]) / 100);
    };
    timer = setTimeout(() => finish(null), 4000);
    videoEl.muted = true;
    videoEl.currentTime = 0;
    videoEl.play()
      .then(() => videoEl.requestVideoFrameCallback(onFrame))
      .catch(() => finish(null));
  });
}

export async function loadVideo(file, videoEl) {
  const url = URL.createObjectURL(file);
  videoEl.src = url;
  videoEl.load();

  await waitFor(videoEl, 'loadedmetadata', 15000);

  const duration = videoEl.duration;
  if (!Number.isFinite(duration) || duration <= 0 || !videoEl.videoWidth || !videoEl.videoHeight) {
    URL.revokeObjectURL(url);
    throw new Error('This browser could not decode the video. Try MP4 (H.264) or WebM.');
  }
  if (duration > MAX_VIDEO_SECONDS + 0.05) {
    URL.revokeObjectURL(url);
    throw new Error('Video is ' + duration.toFixed(1) + ' s long. The MVP limit is ' + MAX_VIDEO_SECONDS + ' s.');
  }

  // Make sure a frame is available for seeking and drawing.
  if (videoEl.readyState < 2) {
    await waitFor(videoEl, 'loadeddata', 15000).catch(() => {});
  }

  return {
    url: url,
    width: videoEl.videoWidth,
    height: videoEl.videoHeight,
    duration: duration,
  };
}

function waitFor(el, eventName, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      el.removeEventListener(eventName, onEvent);
      reject(new Error('Timed out waiting for ' + eventName + '.'));
    }, timeoutMs);
    function onEvent() {
      clearTimeout(timer);
      el.removeEventListener(eventName, onEvent);
      resolve();
    }
    el.addEventListener(eventName, onEvent);
  });
}
