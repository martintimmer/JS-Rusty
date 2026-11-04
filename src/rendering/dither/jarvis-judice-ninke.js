import { dtRunDiffusion } from './diffusion.js';

// Jarvis–Judice–Ninke error diffusion (1976). Twelve neighbours over three rows, weights out of 48.
// The wide kernel gives the smoothest tone of the diffusion methods and the least directional
// texture, at about twice the cost of Floyd–Steinberg.
const JJN_TAPS = [
  [1, 0, 7 / 48], [2, 0, 5 / 48],
  [-2, 1, 3 / 48], [-1, 1, 5 / 48], [0, 1, 7 / 48], [1, 1, 5 / 48], [2, 1, 3 / 48],
  [-2, 2, 1 / 48], [-1, 2, 3 / 48], [0, 2, 5 / 48], [1, 2, 3 / 48], [2, 2, 1 / 48],
];

export function ditherJarvisJudiceNinke(env) {
  dtRunDiffusion(env, JJN_TAPS);
}
