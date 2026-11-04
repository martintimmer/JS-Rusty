import { dtOklabFromSrgb } from './colour.js';
import { dtEnsureMixTable } from './palettes.js';

// Quantisers shared by the dither methods. Every output is a palette index q: for paper-and-ink it is
// the tonal level (0 = paper, maxLevel = ink), and for a palette it is the colour index. The engine turns
// indices into colours with one lookup table, so painting is the same for all methods, and the output
// always uses the exact palette colours.

// Monochrome level for value y, in level units (0 .. maxLevel). prev is the level this cell had in the
// previous frame (255 = none). With hyst > 0 the previous level is kept while y stays within
// 0.5 + hyst of it: a Schmitt-style band that stops flicker. With hyst = 0 this is plain rounding.
export function dtChooseLevel(y, maxLevel, prev, hyst) {
  let q;
  if (prev <= maxLevel && Math.abs(y - prev) < 0.5 + hyst) q = prev;
  else q = Math.floor(y + 0.5);
  return q < 0 ? 0 : (q > maxLevel ? maxLevel : q);
}

function dtClamp01(v) {
  return v < 0 ? 0 : (v > 1 ? 1 : v);
}

// Scratch for the OKLab conversion of one target. Module-level, so nothing is allocated per cell.
const DT_NEAREST_LAB = new Float32Array(3);

// Nearest palette colour to the target, by OKLab distance. The target is the three accumulator channels
// at cell i (planar, stride n), in sRGB. prev/hyst work as in dtChooseLevel: the previous colour is kept
// while its squared OKLab distance is within (1 + 2 hyst) of the best one.
export function dtNearestColour(acc, n, i, colours, prev, hyst) {
  const lab = colours.oklab;
  const count = colours.count;
  dtOklabFromSrgb(dtClamp01(acc[i]), dtClamp01(acc[n + i]), dtClamp01(acc[2 * n + i]), DT_NEAREST_LAB);
  const L = DT_NEAREST_LAB[0];
  const A = DT_NEAREST_LAB[1];
  const B = DT_NEAREST_LAB[2];
  let best = 0;
  let bestD = Infinity;
  for (let j = 0; j < count; j++) {
    const dL = L - lab[3 * j];
    const dA = A - lab[3 * j + 1];
    const dB = B - lab[3 * j + 2];
    const d = dL * dL + dA * dA + dB * dB;
    if (d < bestD) {
      bestD = d;
      best = j;
    }
  }
  if (prev < count && prev !== best) {
    const dL = L - lab[3 * prev];
    const dA = A - lab[3 * prev + 1];
    const dB = B - lab[3 * prev + 2];
    if (dL * dL + dA * dA + dB * dB <= bestD * (1 + 2 * hyst)) return prev;
  }
  return best;
}

// Ordered choice within a palette. grey is the target lightness (sRGB, 0 dark to 1 light). The palette
// pair that best mixes to this grey (colours.mixA / mixB, with the fraction mixF of the second colour)
// is looked up, and the second colour is chosen when the threshold T is below mixF. Over many cells the
// mixture averages to the grey, and the output stays on exact palette colours. prev/hyst bias T so the
// previous colour is kept more often.
export function dtMixColour(grey, T, colours, prev, hyst) {
  const g = dtClamp01(grey);
  const idx = (g * 255 + 0.5) | 0;
  const a = colours.mixA[idx];
  const b = colours.mixB[idx];
  if (a === b) return a;
  let t = T;
  if (prev === a) t += 0.5 * hyst;
  else if (prev === b) t -= 0.5 * hyst;
  return t < colours.mixF[idx] ? b : a;
}

// Ordered driver: each cell is quantised against its threshold from a tile. The matrix is square with a
// power-of-two side (size) and holds thresholds in (0, 1). The tone is shifted by the threshold (env.thr
// per cell, or env.shift globally), so the threshold control acts the same way for every method.
export function dtRunOrdered(env, matrix, size) {
  const gw = env.gw;
  const gh = env.gh;
  const tone = env.tone;
  const thr = env.thr;
  const shift = env.shift;
  const out = env.out;
  const prev = env.prev;
  const colours = env.colours;
  const maxLevel = env.maxLevel;
  const hyst = env.hyst;
  if (colours) dtEnsureMixTable(colours);
  const mask = size - 1;
  for (let y = 0; y < gh; y++) {
    const trow = (y & mask) * size;
    for (let x = 0; x < gw; x++) {
      const i = y * gw + x;
      const T = matrix[trow + (x & mask)];
      const z = tone[i] + (thr ? 0.5 - thr[i] : shift);
      const p = prev ? prev[i] : 255;
      out[i] = colours
        ? dtMixColour(1 - z, T, colours, p, hyst)
        : dtChooseLevel(z * maxLevel + T - 0.5, maxLevel, p, hyst);
    }
  }
}
