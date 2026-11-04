import { smoothstep } from '../core.js';

// Temporal stabilisation for video and animated stills (off by default).
// Two parts work together:
//  1. The source darkness is blended with its previous value, but only where the change is small.
//     Sensor noise and compression shimmer are smoothed; a moving edge (large change) passes through
//     at once, so there is no ghosting.
//  2. Quantisation keeps each cell's previous level while the value stays inside a hysteresis band
//     (see quantize.js). That stops cells near a threshold from flipping back and forth.
// The history lives in reused buffers, and the caller swaps them rather than copying.

// Advances the smoothed source rawS toward the new source src. strength is 0-1.
export function dtTemporalAdvance(rawS, src, n, strength) {
  const k = 0.8 * strength;
  for (let i = 0; i < n; i++) {
    const v = src[i];
    const change = Math.abs(v - rawS[i]);
    // Full smoothing below a change of 0.05, none above 0.2.
    const a = k * (1 - smoothstep(0.05, 0.2, change));
    rawS[i] = v + (rawS[i] - v) * a;
  }
}
