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

// Colour lookup. Measuring every cell against every palette colour in OKLab is the costliest step of colour dithering,
// and a frame repeats it for every cell. So without hysteresis the colour is looked up in a table, built once per
// palette: each 6-bit sRGB colour (64 steps a channel) maps to its nearest palette colour. Its error against the exact
// search is at most one step of the table, far below what the eye can see in a dither.
// With hysteresis, the previous colour has to be compared too, so the exact search is used.
const DT_LUT_STEPS = 63;

function dtBuildNearestLut(colours) {
  const lut = new Uint8Array(64 * 64 * 64);
  const lab = colours.oklab;
  const count = colours.count;
  const L = DT_NEAREST_LAB;
  for (let r = 0; r < 64; r++) {
    for (let g = 0; g < 64; g++) {
      for (let b = 0; b < 64; b++) {
        dtOklabFromSrgb(r / DT_LUT_STEPS, g / DT_LUT_STEPS, b / DT_LUT_STEPS, L);
        let best = 0;
        let bestD = Infinity;
        for (let j = 0; j < count; j++) {
          const dL = L[0] - lab[3 * j];
          const dA = L[1] - lab[3 * j + 1];
          const dB = L[2] - lab[3 * j + 2];
          const d = dL * dL + dA * dA + dB * dB;
          if (d < bestD) {
            bestD = d;
            best = j;
          }
        }
        lut[(r << 12) | (g << 6) | b] = best;
      }
    }
  }
  return lut;
}

// Nearest palette colour to the target. The target is the three accumulator channels at cell i (planar, stride n),
// in sRGB. Without hysteresis the answer comes from the palette's lookup table (built on first use and kept on the
// palette, which is the same object for every frame). With hysteresis it is the exact search.
export function dtNearestColour(acc, n, i, colours, prev, hyst) {
  if (!(hyst > 0)) {
    if (!colours.nearestLut) colours.nearestLut = dtBuildNearestLut(colours);
    const r = (dtClamp01(acc[i]) * DT_LUT_STEPS + 0.5) | 0;
    const g = (dtClamp01(acc[n + i]) * DT_LUT_STEPS + 0.5) | 0;
    const b = (dtClamp01(acc[2 * n + i]) * DT_LUT_STEPS + 0.5) | 0;
    return colours.nearestLut[(r << 12) | (g << 6) | b];
  }
  return dtNearestExact(acc, n, i, colours, prev, hyst);
}

// The exact search: nearest palette colour by OKLab distance. prev/hyst work as in dtChooseLevel: the previous colour
// is kept while its squared OKLab distance is within (1 + 2 hyst) of the best one.
function dtNearestExact(acc, n, i, colours, prev, hyst) {
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
// power-of-two side (size) and holds thresholds in (0, 1). Three things shape the threshold:
//  - Dither strength (env.strength) scales the pattern about one half: 0 is plain rounding, 1 the full matrix.
//  - The global Threshold, or the adaptive threshold, shifts the tone, as it does for every method.
//  - Colour mode (env.lr, env.lg, env.lb hold the photo's lightness per channel): the pattern is added to each
//    channel and the nearest palette colour in OKLab is chosen, so palette colours follow the photo's colour.
export function dtRunOrdered(env, matrix, size) {
  const gw = env.gw;
  const gh = env.gh;
  const n = env.n;
  const tone = env.tone;
  const thr = env.thr;
  const shift = env.shift;
  const out = env.out;
  const prev = env.prev;
  const colours = env.colours;
  const maxLevel = env.maxLevel;
  const hyst = env.hyst;
  const strength = env.strength;
  const lr = env.lr;
  const lg = env.lg;
  const lb = env.lb;
  const acc = env.acc;
  if (colours && !lr) dtEnsureMixTable(colours);
  const mask = size - 1;
  for (let y = 0; y < gh; y++) {
    const trow = (y & mask) * size;
    for (let x = 0; x < gw; x++) {
      const i = y * gw + x;
      const T = 0.5 + (matrix[trow + (x & mask)] - 0.5) * strength;
      const p = prev ? prev[i] : 255;
      if (lr) {
        const d = T - 0.5;
        acc[i] = lr[i] + d;
        acc[n + i] = lg[i] + d;
        acc[2 * n + i] = lb[i] + d;
        out[i] = dtNearestColour(acc, n, i, colours, p, hyst);
        continue;
      }
      const z = tone[i] + (thr ? 0.5 - thr[i] : shift);
      out[i] = colours
        ? dtMixColour(1 - z, T, colours, p, hyst)
        : dtChooseLevel(z * maxLevel + T - 0.5, maxLevel, p, hyst);
    }
  }
}
