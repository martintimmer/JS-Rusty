import { dtChooseLevel, dtNearestColour } from './quantize.js';

// Shared error-diffusion driver. Each method (atkinson.js, floyd-steinberg.js, jarvis-judice-ninke.js)
// supplies its kernel as taps [dx, dy, weight]. The driver handles everything the methods share:
//  - Serpentine scan. Odd rows are scanned right to left and every tap's dx is mirrored, so the
//    kernel stays centred on the direction of travel and the horizontal streaks of a one-way scan go.
//  - Diffusion strength. Every weight is multiplied by env.strength (1 = the kernel as published).
//  - Edge preservation. Where env.edge is set, the error leaving a cell is damped by
//    (1 - edgeAmount * edge[i]), so error does not carry across strong edges and outlines stay crisp.
//  - Monochrome error is a scalar on level units. A colour set uses three planar channels and an RGB
//    error, so the mixture of palette colours averages back to the target grey.
// The accumulator env.acc is seeded by dtSeedAccumulator before the scan.

// Seeds the accumulator from the tone and the threshold shift. Monochrome: the value is the darkness.
// Colour set: the value is lightness (1 - darkness), replicated across the three channels.
export function dtSeedAccumulator(env) {
  const n = env.n;
  const acc = env.acc;
  const tone = env.tone;
  const thr = env.thr;
  const shift = env.shift;
  const colours = env.colours;
  for (let i = 0; i < n; i++) {
    const z = tone[i] + (thr ? 0.5 - thr[i] : shift);
    if (colours) {
      const l = 1 - z;
      acc[i] = l;
      acc[n + i] = l;
      acc[2 * n + i] = l;
    } else {
      acc[i] = z;
    }
  }
}

// Bounds a colour-channel target before its error is measured. Diffused error can push a channel slightly
// outside 0-1. Keeping it within a small margin stops runaway drift without clipping ordinary tones.
function dtBoundTarget(v) {
  return v < -0.25 ? -0.25 : (v > 1.25 ? 1.25 : v);
}

// Runs one error-diffusion pass with the given kernel taps.
export function dtRunDiffusion(env, taps) {
  const gw = env.gw;
  const gh = env.gh;
  const n = env.n;
  const acc = env.acc;
  const out = env.out;
  const prev = env.prev;
  const edge = env.edge;
  const edgeAmount = env.edgeAmount;
  const strength = env.strength;
  const colours = env.colours;
  const maxLevel = env.maxLevel;
  const invMax = 1 / maxLevel;
  const hyst = env.hyst;
  const serpentine = env.serpentine;
  const tapCount = taps.length;

  for (let y = 0; y < gh; y++) {
    const reverse = serpentine && (y & 1) === 1;
    for (let s = 0; s < gw; s++) {
      const x = reverse ? gw - 1 - s : s;
      const i = y * gw + x;
      const p = prev ? prev[i] : 255;
      let q;
      let e0;
      let e1 = 0;
      let e2 = 0;
      if (colours) {
        q = dtNearestColour(acc, n, i, colours, p, hyst);
        const c = 3 * q;
        e0 = dtBoundTarget(acc[i]) - colours.rgb[c];
        e1 = dtBoundTarget(acc[n + i]) - colours.rgb[c + 1];
        e2 = dtBoundTarget(acc[2 * n + i]) - colours.rgb[c + 2];
      } else {
        const v = acc[i];
        q = dtChooseLevel(v * maxLevel, maxLevel, p, hyst);
        e0 = v - q * invMax;
      }
      out[i] = q;
      if (e0 === 0 && e1 === 0 && e2 === 0) continue;

      const scale = edge ? strength * (1 - edgeAmount * edge[i]) : strength;
      for (let t = 0; t < tapCount; t++) {
        const tap = taps[t];
        const nx = reverse ? x - tap[0] : x + tap[0];
        const ny = y + tap[1];
        if (nx < 0 || nx >= gw || ny >= gh) continue;
        const j = ny * gw + nx;
        const w = tap[2] * scale;
        acc[j] += e0 * w;
        if (colours) {
          acc[n + j] += e1 * w;
          acc[2 * n + j] += e2 * w;
        }
      }
    }
  }
}
