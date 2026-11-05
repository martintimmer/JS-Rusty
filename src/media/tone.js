// Auto-levels: the tones of a picture are stretched so that its 0.5th percentile maps to 0 and its 99.5th to SDR_TOP
// (235). Brighter values roll off smoothly toward 255 instead of clipping, so highlights keep their detail.
// Two uses:
//  - A clip: one mapping, measured over the whole sequence (autoLevels). Every frame gets the same tones.
//  - A live camera: the mapping follows the picture slowly (LevelsTracker), and resets at a scene cut, so the tones do
//    not pump with each frame.
// Grey frames are mapped value by value. Colour frames (RGB, three bytes a pixel) are scaled by the mapping of their
// Rec. 709 luminance instead: brightness changes, the hue does not. Mapping each channel on its own would pin a strong
// blue at 255 while red and green are still rising, so the blue would turn white.

// Rec. 709 luma weights (0.2126, 0.7152, 0.0722) in 1/256 units. The three sum to 256.
const LUMA_R = 54;
const LUMA_G = 183;
const LUMA_B = 19;

// The 99.5th percentile maps here. Values above it roll off toward 255.
export const SDR_TOP = 235;
// A picture whose 0.5 to 99.5 percentile spread is narrower than this is too flat to stretch.
const FLAT_SPREAD = 24;
// How steeply the roll-off above the top approaches 255 (larger is a sharper knee).
const SHOULDER_K = 3;
// Largest number of grey values measured for a histogram. A long clip is sampled, so the analysis stays quick.
const MAX_SAMPLES = 1000000;

// The histogram of the grey values of a set of frames: { hist: Float64Array(256), total }.
export function histogramOf(greySets) {
  const hist = new Float64Array(256);
  let total = 0;
  const sample = greySets[0];
  if (!sample || sample.length === 0) return { hist: hist, total: total };
  let pixels = 0;
  for (const fr of sample) pixels += fr.length;
  const step = Math.max(1, Math.floor(pixels / MAX_SAMPLES));
  for (const fr of sample) {
    for (let i = 0; i < fr.length; i += step) {
      hist[fr[i]]++;
      total++;
    }
  }
  return { hist: hist, total: total };
}

// The levels of a histogram: the values at its 0.5th and 99.5th percentiles, or null when the picture is too flat.
export function levelsFromHistogram(hist, total) {
  if (!total) return null;
  const lowTarget = total * 0.005;
  const highTarget = total * 0.995;
  let acc = 0;
  let lo = 0;
  let hi = 255;
  let foundLo = false;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (!foundLo && acc >= lowTarget) { lo = v; foundLo = true; }
    if (acc >= highTarget) { hi = v; break; }
  }
  if (hi - lo < FLAT_SPREAD) return null;
  return { lo: lo, hi: hi };
}

// The mapping for levels: a function from a grey value (0 to 255) to a mapped value. lo maps to 0, hi to SDR_TOP, and
// values above hi roll off smoothly to 255.
export function levelMap(levels) {
  const lo = levels.lo;
  const hi = levels.hi;
  const span = hi - lo;
  const top = 255 - hi;
  const norm = 1 - Math.exp(-SHOULDER_K);
  return (v) => {
    if (v <= lo) return 0;
    if (v <= hi) return ((v - lo) / span) * SDR_TOP;
    const t = Math.min(1, (v - hi) / Math.max(1e-9, top));
    return SDR_TOP + ((255 - SDR_TOP) * (1 - Math.exp(-SHOULDER_K * t))) / norm;
  };
}

// Applies levels to grey frames (in place) and to colour frames (in place). levels may be null, which changes nothing.
// greySets: arrays of grey frames. colourSets: arrays of colour frames (three bytes a pixel), or none.
export function applyLevels(greySets, colourSets, levels) {
  if (!levels) return;
  const map = levelMap(levels);
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    const m = Math.round(map(v));
    lut[v] = m < 0 ? 0 : (m > 255 ? 255 : m);
  }
  for (const set of greySets) {
    for (const fr of set) {
      for (let i = 0; i < fr.length; i++) fr[i] = lut[fr[i]];
    }
  }
  for (const set of colourSets || []) {
    for (const fr of set) {
      for (let j = 0; j + 2 < fr.length; j += 3) {
        const r = fr[j];
        const g = fr[j + 1];
        const b = fr[j + 2];
        const y = (LUMA_R * r + LUMA_G * g + LUMA_B * b) / 256;
        if (y <= 0) continue; // black stays black
        const k = map(y) / y;
        fr[j] = Math.min(255, Math.round(r * k));
        fr[j + 1] = Math.min(255, Math.round(g * k));
        fr[j + 2] = Math.min(255, Math.round(b * k));
      }
    }
  }
}

// One mapping for a whole sequence: the clip's levels are measured over all of its grey frames, then applied.
export function autoLevels(greySets, colourSets) {
  const { hist, total } = histogramOf(greySets);
  applyLevels(greySets, colourSets, levelsFromHistogram(hist, total));
}

// The running levels of a live camera. Each frame's levels are blended in with weight alpha, so the tones follow the
// picture slowly. A scene cut resets the running levels to the new frame at once: a cut is a frame whose histogram
// differs from the one before by more than `cut` (0 to 1, the share of values that moved). A flat frame keeps the
// running levels.
export class LevelsTracker {
  constructor(options) {
    const o = options || {};
    this.alpha = o.alpha !== undefined ? o.alpha : 0.08;
    this.cut = o.cut !== undefined ? o.cut : 0.35;
    this.levels = null;
    this.prev = null;
  }

  // hist, total: the histogram of the frame. Returns the running levels, or null before the first usable frame.
  update(hist, total) {
    if (!total) return this.levels;
    const dist = new Float64Array(256);
    for (let v = 0; v < 256; v++) dist[v] = hist[v] / total;
    let change = 1;
    if (this.prev) {
      let d = 0;
      for (let v = 0; v < 256; v++) d += Math.abs(dist[v] - this.prev[v]);
      change = d / 2;
    }
    this.prev = dist;
    const fresh = levelsFromHistogram(hist, total);
    if (!fresh) return this.levels;
    if (!this.levels || change > this.cut) {
      this.levels = { lo: fresh.lo, hi: fresh.hi };
    } else {
      this.levels = {
        lo: this.levels.lo + this.alpha * (fresh.lo - this.levels.lo),
        hi: this.levels.hi + this.alpha * (fresh.hi - this.levels.hi),
      };
    }
    return this.levels;
  }
}
