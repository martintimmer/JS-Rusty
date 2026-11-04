// Video recording of the live canvas via MediaRecorder: WebM, and MP4 (H.264 or HEVC) where the browser can record
// it. The caller keeps the animation running while recording. A format is offered only when MediaRecorder reports
// that it can record it, so the choices depend on the browser and the platform.
//
// "MPEG-4" here means MPEG-4 AVC (H.264), the codec inside MP4 files. The older MPEG-4 Part 2 codec cannot be
// recorded by any browser, so it is not offered.

const RECORD_FPS = 30;

const WEBM_TYPES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

// MP4 codec strings to try, most specific first. The bare 'video/mp4' type is tried for H.264 only: it is the
// H.264 default where MP4 recording exists, and it must not stand in for HEVC.
export const MP4_CODECS = {
  h264: [
    'video/mp4;codecs=avc1.640028',
    'video/mp4;codecs=avc1.4D401E',
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4',
  ],
  hevc: [
    'video/mp4;codecs=hvc1.1.6.L93.B0',
    'video/mp4;codecs=hev1.1.6.L93.B0',
    'video/mp4;codecs=hvc1',
    'video/mp4;codecs=hev1',
  ],
};

// Compression levels as bits per pixel per frame. The bit rate scales with the frame size.
export const MP4_LEVELS = {
  high: 0.2,
  medium: 0.1,
  small: 0.05,
};

export function pickWebmMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const type of WEBM_TYPES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return null;
}

// The MIME type to record a codec ('h264' or 'hevc') with, or null when this browser cannot record it.
export function pickMp4Mime(codec) {
  if (typeof MediaRecorder === 'undefined' || !MP4_CODECS[codec]) return null;
  for (const type of MP4_CODECS[codec]) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return null;
}

// The MP4 codecs this browser can record, as keys of MP4_CODECS.
export function supportedMp4Codecs() {
  return Object.keys(MP4_CODECS).filter((codec) => !!pickMp4Mime(codec));
}

// Bit rate for an MP4 of the given frame size and compression level, in bits per second (1 to 40 Mbit/s).
export function mp4BitsPerSecond(width, height, level) {
  const bitsPerPixel = MP4_LEVELS[level] || MP4_LEVELS.medium;
  const rate = width * height * RECORD_FPS * bitsPerPixel;
  return Math.round(Math.min(40000000, Math.max(1000000, rate)));
}

// Records `canvas` for `seconds` into a file of the MIME type `mime` at `bitsPerSecond`, and resolves with the
// Blob. `onProgress(fraction)` is called roughly every 100 ms.
export function recordCanvasVideo(canvas, seconds, mime, bitsPerSecond, onProgress) {
  return new Promise((resolve, reject) => {
    if (!mime) {
      reject(new Error('This browser cannot record this format (MediaRecorder unsupported).'));
      return;
    }
    if (!canvas.captureStream) {
      reject(new Error('This browser cannot capture canvas streams.'));
      return;
    }
    const stream = canvas.captureStream(RECORD_FPS);
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitsPerSecond });
    const chunks = [];
    const started = performance.now();

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    recorder.onerror = (e) => reject(e.error || new Error('Recording failed.'));
    recorder.onstop = () => {
      clearInterval(ticker);
      stream.getTracks().forEach((track) => track.stop());
      resolve(new Blob(chunks, { type: mime.split(';')[0] }));
    };

    const ticker = setInterval(() => {
      const elapsed = (performance.now() - started) / 1000;
      if (onProgress) onProgress(Math.min(1, elapsed / seconds));
      if (elapsed >= seconds && recorder.state !== 'inactive') recorder.stop();
    }, 100);

    recorder.start(250);
  });
}

// WebM at the bit rate used before (8 Mbit/s).
export function recordCanvasWebm(canvas, seconds, onProgress) {
  const mime = pickWebmMime();
  if (!mime) return Promise.reject(new Error('This browser cannot record WebM (MediaRecorder unsupported).'));
  return recordCanvasVideo(canvas, seconds, mime, 8000000, onProgress);
}
