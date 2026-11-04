import { dtRunDiffusion } from './diffusion.js';

// Atkinson dithering (Bill Atkinson, Apple Macintosh; the original Dither engine, and the default).
// Six neighbours each receive 1/8 of the error: (+1,0) (+2,0) (-1,+1) (0,+1) (+1,+1) (0,+2).
// Only 6/8 of the error is passed on; the rest is discarded, which keeps highlights clean.
const ATKINSON_TAPS = [
  [1, 0, 1 / 8], [2, 0, 1 / 8],
  [-1, 1, 1 / 8], [0, 1, 1 / 8], [1, 1, 1 / 8],
  [0, 2, 1 / 8],
];

export function ditherAtkinson(env) {
  dtRunDiffusion(env, ATKINSON_TAPS);
}
