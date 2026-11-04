import { dtRunDiffusion } from './diffusion.js';

// Floyd–Steinberg error diffusion (1976). The full error goes to four neighbours, in sixteenths:
// (+1,0) 7/16, (-1,+1) 3/16, (0,+1) 5/16, (+1,+1) 1/16. Nothing is discarded, so midtones are smooth
// and accurate. Combine with Serpentine scan to remove the diagonal streaks of a one-way scan.
const FLOYD_STEINBERG_TAPS = [
  [1, 0, 7 / 16],
  [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16],
];

export function ditherFloydSteinberg(env) {
  dtRunDiffusion(env, FLOYD_STEINBERG_TAPS);
}
