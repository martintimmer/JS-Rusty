import { dtRunOrdered } from './quantize.js';
import { dtCellNoise } from './tone.js';

// Random threshold dithering. Each cell is compared with a pseudo-random threshold, so the dots are scattered
// with no regular pattern. The thresholds come from a 128 x 128 tile of seeded noise, built on first use. The
// seed is fixed, so the pattern is the same in every frame (no flicker) and in every export.

const RANDOM_SIZE = 128;
const RANDOM_SEED = 0x2f6b9d1;
let RANDOM_TILE = null;

function dtRandomTile() {
  if (RANDOM_TILE) return RANDOM_TILE;
  const count = RANDOM_SIZE * RANDOM_SIZE;
  RANDOM_TILE = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    // Thresholds lie in (0, 1), as the ordered driver expects.
    RANDOM_TILE[i] = 0.002 + 0.996 * dtCellNoise(i, RANDOM_SEED);
  }
  return RANDOM_TILE;
}

export function ditherRandom(env) {
  dtRunOrdered(env, dtRandomTile(), RANDOM_SIZE);
}
