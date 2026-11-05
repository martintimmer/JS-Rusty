// The edit of a photo or video: crop, quarter turns and trim. No DOM, so the rules can be read in one place.
//   edit = { crop, rotation, start, end }
//     crop      null (the whole picture) or { x, y, w, h }, normalized 0..1 of the SOURCE picture
//     rotation  0, 90, 180 or 270: quarter turns clockwise, applied after the crop
//     start     first frame, in seconds of the source clip
//     end       last frame, in seconds of the source clip; null means the clip's own end
// The edit is kept apart from the media, so the original file is never changed (as in the Photos editor, Revert
// returns to the original).

export const MIN_TRIM_SECONDS = 0.5;
export const MIN_CROP = 0.08;

// Aspect presets, as width : height of the picture as shown (portrait pictures take the inverse).
export const ASPECTS = [
  { id: 'free', label: 'Freeform', ratio: null },
  { id: 'original', label: 'Original', ratio: 'original' },
  { id: 'square', label: 'Square', ratio: 1 },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
  { id: '5:7', label: '5:7', ratio: 5 / 7 },
  { id: '4:3', label: '4:3', ratio: 4 / 3 },
  { id: '3:2', label: '3:2', ratio: 3 / 2 },
  { id: '3:4', label: '3:4', ratio: 3 / 4 },
  { id: '2:3', label: '2:3', ratio: 2 / 3 },
];

const FULL = { x: 0, y: 0, w: 1, h: 1 };

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

export function defaultEdit() {
  return { crop: null, rotation: 0, start: 0, end: null };
}

// True when the edit changes nothing.
export function isDefaultEdit(edit) {
  return !edit.crop && edit.rotation === 0 && edit.start === 0 && edit.end === null;
}

// The picture's size as it is shown after the turn (the source size before the crop).
export function displaySize(media, rotation) {
  const turned = rotation % 180 !== 0;
  return turned ? { w: media.height, h: media.width } : { w: media.width, h: media.height };
}

// Turns a normalized rect a quarter turn clockwise: the top-left corner moves to the top-right.
export function rotateRectCW(r) {
  return { x: 1 - (r.y + r.h), y: r.x, w: r.h, h: r.w };
}

// The inverse: a quarter turn anticlockwise.
export function rotateRectCCW(r) {
  return { x: r.y, y: 1 - (r.x + r.w), w: r.h, h: r.w };
}

function turns(rotation) {
  return (((rotation / 90) % 4) + 4) % 4;
}

// The crop (on the source) as the turned picture shows it.
export function cropForRotation(crop, rotation) {
  let r = crop || FULL;
  for (let i = turns(rotation); i > 0; i--) r = rotateRectCW(r);
  return r;
}

// A crop shown on the turned picture, put back on the source.
export function cropFromRotation(crop, rotation) {
  let r = crop || FULL;
  for (let i = turns(rotation); i > 0; i--) r = rotateRectCCW(r);
  return r;
}

// The normalized rect, tidied: whole-picture crops become null, and values are rounded.
export function tidyCrop(r) {
  if (!r) return null;
  const x = clamp(r.x, 0, 1);
  const y = clamp(r.y, 0, 1);
  const w = clamp(r.w, MIN_CROP, 1 - x);
  const h = clamp(r.h, MIN_CROP, 1 - y);
  const whole = Math.abs(x) < 1e-3 && Math.abs(y) < 1e-3 && Math.abs(w - 1) < 1e-3 && Math.abs(h - 1) < 1e-3;
  if (whole) return null;
  const round = (v) => Math.round(v * 10000) / 10000;
  return { x: round(x), y: round(y), w: round(w), h: round(h) };
}

// The trim of a clip, in seconds. Photos have no trim.
export function trimRange(media, edit) {
  const dur = media.kind === 'video' ? media.duration : 0;
  const start = clamp(edit.start || 0, 0, Math.max(0, dur - MIN_TRIM_SECONDS));
  const wanted = edit.end == null ? dur : edit.end;
  const end = Math.min(dur, clamp(wanted, start + MIN_TRIM_SECONDS, Math.max(dur, start + MIN_TRIM_SECONDS)));
  return { start: start, end: end };
}

// The length of the trimmed clip (0 for a photo).
export function trimmedDuration(media, edit) {
  if (media.kind !== 'video') return 0;
  const r = trimRange(media, edit);
  return Math.max(0, r.end - r.start);
}

// The edit as it is stored: the crop tidied, the turn in quarter turns, and the trim reset to the clip's ends when it
// covers the whole clip.
export function normalizeEdit(edit, media) {
  const rotation = turns(edit.rotation) * 90;
  const crop = tidyCrop(edit.crop);
  if (media.kind !== 'video') return { crop: crop, rotation: rotation, start: 0, end: null };
  const r = trimRange(media, edit);
  const whole = r.start <= 1e-3 && r.end >= media.duration - 1e-3;
  return { crop: crop, rotation: rotation, start: whole ? 0 : r.start, end: whole ? null : r.end };
}

// The source rectangle (in pixels) that a crop covers, and the turn: the view the samplers draw.
export function viewFor(media, edit) {
  const W = media.width;
  const H = media.height;
  const c = edit.crop || FULL;
  let sx = Math.round(c.x * W);
  let sy = Math.round(c.y * H);
  sx = clamp(sx, 0, Math.max(0, W - 2));
  sy = clamp(sy, 0, Math.max(0, H - 2));
  const sw = clamp(Math.round(c.w * W), 2, W - sx);
  const sh = clamp(Math.round(c.h * H), 2, H - sy);
  return { sx: sx, sy: sy, sw: sw, sh: sh, rotation: turns(edit.rotation) * 90 };
}

// The normalized width / height ratio a preset asks for, on the turned picture (in normalized units, so that a
// ratio of 1 means the same number of pixels across and down).
export function normalizedRatio(aspect, media, rotation) {
  if (aspect.ratio === null) return null;
  const shown = displaySize(media, rotation);
  const pixel = aspect.ratio === 'original' ? shown.w / shown.h : aspect.ratio;
  // A portrait picture takes the portrait form of the preset.
  const wantPixel = shown.h > shown.w && pixel > 1 && aspect.ratio !== 'original' ? 1 / pixel : pixel;
  // pixel width / pixel height = (w * shown.w) / (h * shown.h), so w / h = ratio * shown.h / shown.w.
  return wantPixel * (shown.h / shown.w);
}

// The largest rect of the given normalized ratio that fits inside r, centred on it.
export function fitToRatio(r, ratio) {
  if (!ratio) return r;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  let w = r.w;
  let h = r.h;
  if (w / h > ratio) w = h * ratio;
  else h = w / ratio;
  return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w: w, h: h };
}

// Snaps a time to the frame grid of the clip's rate, so the trim lands on a frame the sampler reads.
export function snapToFrame(t, fps) {
  const rate = fps > 0 ? fps : 30;
  return Math.round(t * rate) / rate;
}

// Formats seconds as m:ss.t for the trim labels.
export function formatSeconds(t) {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return m + ':' + (rest < 10 ? '0' : '') + rest.toFixed(1);
}
