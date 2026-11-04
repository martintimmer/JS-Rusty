// Web Worker: runs motion estimation and frame differencing off the main thread.
// Message in:  { type: 'analyse', frames: Uint8Array[], width, height }
// Messages out: { type: 'progress', progress } and { type: 'done', motion }

import { analyseMotion } from '../media/motion-analysis.js';

self.onmessage = (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'analyse') return;
  try {
    const motion = analyseMotion(msg.frames, msg.width, msg.height, {
      scale: msg.scale || 1,
      onProgress: (progress) => self.postMessage({ type: 'progress', progress: progress }),
    });
    self.postMessage({ type: 'done', motion: motion }, [
      motion.vx.buffer,
      motion.vy.buffer,
      motion.diff.buffer,
    ]);
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message ? err.message : err) });
  }
};
