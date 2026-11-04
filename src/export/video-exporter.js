// WebM recording of the live canvas via MediaRecorder. The caller is responsible
// for keeping the animation running while recording. MP4 is intentionally not
// offered: browsers only expose H.264/AAC through MediaRecorder on some platforms,
// and there is no dependency-free, reliable in-browser encoder for it.

const CANDIDATE_TYPES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

export function pickWebmMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const type of CANDIDATE_TYPES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return null;
}

// Records `canvas` for `seconds` and resolves with a WebM Blob.
// `onProgress(fraction)` is called roughly every 100 ms.
export function recordCanvasWebm(canvas, seconds, onProgress) {
  return new Promise((resolve, reject) => {
    const mime = pickWebmMime();
    if (!mime) {
      reject(new Error('This browser cannot record WebM (MediaRecorder unsupported).'));
      return;
    }
    if (!canvas.captureStream) {
      reject(new Error('This browser cannot capture canvas streams.'));
      return;
    }
    const stream = canvas.captureStream(30);
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8000000 });
    const chunks = [];
    const started = performance.now();

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    recorder.onerror = (e) => reject(e.error || new Error('Recording failed.'));
    recorder.onstop = () => {
      clearInterval(ticker);
      stream.getTracks().forEach((track) => track.stop());
      resolve(new Blob(chunks, { type: 'video/webm' }));
    };

    const ticker = setInterval(() => {
      const elapsed = (performance.now() - started) / 1000;
      if (onProgress) onProgress(Math.min(1, elapsed / seconds));
      if (elapsed >= seconds && recorder.state !== 'inactive') recorder.stop();
    }, 100);

    recorder.start(250);
  });
}
