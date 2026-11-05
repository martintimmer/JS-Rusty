// Global auto-levels for a frame sequence.
// The 0.5th and 99.5th percentiles of the grey frames are mapped to 0 and 255. One mapping is shared by every frame, so
// tones do not flicker between frames, and the grey frames and the colour frames of a sequence get the same mapping.
// Grey frames are mapped value by value. Colour frames (RGB, three bytes a pixel) are scaled by the mapping of their
// Rec. 709 luminance instead: brightness changes, the hue does not. Mapping each channel on its own would pin a strong
// blue at 255 while red and green are still rising, so the blue would turn white.

// Rec. 709 luma weights (0.2126, 0.7152, 0.0722) in 1/256 units. The three sum to 256.
const LUMA_R = 54;
const LUMA_G = 183;
const LUMA_B = 19;

// greySets: arrays of grey frames (one byte a pixel). colourSets: arrays of colour frames (three bytes a pixel), or none.
export function autoLevels(greySets, colourSets) {
  const sample = greySets[0];
  if (!sample || sample.length === 0) return;

  // Histogram of the grey values. A long clip is sampled, so the analysis stays quick.
  let pixels = 0;
  for (const fr of sample) pixels += fr.length;
  const step = Math.max(1, Math.floor(pixels / 1000000));
  const hist = new Float64Array(256);
  let total = 0;
  for (const fr of sample) {
    for (let i = 0; i < fr.length; i += step) {
      hist[fr[i]]++;
      total++;
    }
  }
  if (total === 0) return;

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
  if (hi - lo < 24) return; // nearly flat: leave the tones alone

  const scale = 255 / (hi - lo);
  const map = (v) => {
    const m = (v - lo) * scale;
    return m < 0 ? 0 : (m > 255 ? 255 : m);
  };
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.round(map(v));

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
