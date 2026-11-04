import { dtRunOrdered } from './quantize.js';
import { dtCellNoise } from './tone.js';

// Random threshold dithering. Each cell is compared with a pseudo-random threshold, so the dots are scattered
// with no regular pattern. The thresholds come from a 128 x 128 tile of noise. The Seed setting chooses the tile:
// the same seed always gives the same scatter (so there is no flicker between frames, and an export matches the
// canvas), and a different seed gives a different scatter. The tile is rebuilt only when the seed changes.

const RANDOM_SIZE = 128;
let RANDOM_TILE = null;
let RANDOM_TILE_SEED = null;

function dtRandomTile(seed) {
  if (RANDOM_TILE && RANDOM_TILE_SEED === seed) return RANDOM_TILE;
  const count = RANDOM_SIZE * RANDOM_SIZE;
  RANDOM_TILE = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    // Thresholds lie in (0, 1), as the ordered driver expects.
    RANDOM_TILE[i] = 0.002 + 0.996 * dtCellNoise(i, seed);
  }
  RANDOM_TILE_SEED = seed;
  return RANDOM_TILE;
}

export function ditherRandom(env) {
  dtRunOrdered(env, dtRandomTile(env.seed), RANDOM_SIZE);
}
