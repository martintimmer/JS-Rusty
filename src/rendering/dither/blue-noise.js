import { dtRunOrdered } from './quantize.js';

// Blue-noise dithering. Thresholds come from a 64 x 64 void-and-cluster tile (Ulichney, 1993). In
// a blue-noise tile the energy is concentrated at high frequencies, so dots are spread evenly with no
// regular lattice and no directional pattern. Each entry is a unique rank, so at any density the set
// of cells that turn on is as evenly spread as possible.
//
// The tile is generated once, the first time it is needed, from a fixed seed. It is therefore
// identical in every session and every exported file, and the output is deterministic.
// Generation takes a fraction of a second, once.

const DT_BLUE_SIZE = 64;
const DT_BLUE_SIGMA = 1.5;
const DT_BLUE_SEED = 0x2f6e2b1;
let DT_BLUE_TILE = null;

// Builds the rank tile by void-and-cluster:
//  1. Scatter about 10% ones on the tile. Repeatedly move the one in the tightest cluster to the
//     largest void until the pattern is stable.
//  2. Remove ones one at a time from the tightest cluster; they receive the top ranks.
//  3. Restart from the stable pattern and fill the largest voids; they receive the remaining ranks.
// Energy is the toroidal Gaussian-filtered sum of the pattern, updated incrementally.
function dtVoidAndCluster(size, sigma, seed) {
  const N = size * size;
  const R = Math.ceil(sigma * 3);
  const K = 2 * R + 1;
  const kernel = new Float32Array(K * K);
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      kernel[(dy + R) * K + dx + R] = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
    }
  }
  const energy = new Float32Array(N);
  const bin = new Uint8Array(N);

  // Adds (sign = 1) or removes (sign = -1) the kernel around cell idx, wrapping at the tile edge.
  function touch(idx, sign) {
    const cy = Math.floor(idx / size);
    const cx = idx - cy * size;
    for (let dy = -R; dy <= R; dy++) {
      const yy = (cy + dy + size) % size;
      for (let dx = -R; dx <= R; dx++) {
        const xx = (cx + dx + size) % size;
        energy[yy * size + xx] += sign * kernel[(dy + R) * K + dx + R];
      }
    }
  }

  let state = seed >>> 0 || 1;
  function random() {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  }

  // 1. Initial random pattern with about 10% ones.
  const ones = Math.round(0.1 * N);
  for (let placed = 0; placed < ones;) {
    const i = Math.floor(random() * N);
    if (!bin[i]) {
      bin[i] = 1;
      touch(i, 1);
      placed++;
    }
  }
  // Move the tightest cluster to the largest void until the pattern stops changing.
  for (let it = 0; it < 2 * N; it++) {
    let c = -1;
    let cv = -Infinity;
    for (let i = 0; i < N; i++) {
      if (bin[i] && energy[i] > cv) {
        cv = energy[i];
        c = i;
      }
    }
    bin[c] = 0;
    touch(c, -1);
    let v = -1;
    let vv = Infinity;
    for (let i = 0; i < N; i++) {
      if (!bin[i] && energy[i] < vv) {
        vv = energy[i];
        v = i;
      }
    }
    bin[v] = 1;
    touch(v, 1);
    if (v === c) break;
  }

  // The pattern now has M ones; M is also the number of top-ranked cells.
  let M = 0;
  for (let i = 0; i < N; i++) M += bin[i];
  const rank = new Uint32Array(N);
  const energyP = energy.slice();
  const pattern = bin.slice();

  // 2. Remove the tightest cluster repeatedly; the ones removed first get the highest ranks.
  for (let k = M - 1; k >= 0; k--) {
    let c = -1;
    let cv = -Infinity;
    for (let i = 0; i < N; i++) {
      if (pattern[i] && energy[i] > cv) {
        cv = energy[i];
        c = i;
      }
    }
    pattern[c] = 0;
    touch(c, -1);
    rank[c] = k;
  }

  // 3. Restart from the stable pattern (still in bin) and fill the largest voids with the remaining ranks.
  energy.set(energyP);
  for (let k = M; k < N; k++) {
    let v = -1;
    let vv = Infinity;
    for (let i = 0; i < N; i++) {
      if (!bin[i] && energy[i] < vv) {
        vv = energy[i];
        v = i;
      }
    }
    bin[v] = 1;
    touch(v, 1);
    rank[v] = k;
  }

  const thresholds = new Float32Array(N);
  for (let i = 0; i < N; i++) thresholds[i] = (rank[i] + 0.5) / N;
  return thresholds;
}

// The blue-noise threshold tile (64 x 64, values in (0, 1)), built on first use.
export function dtBlueNoiseTile() {
  if (!DT_BLUE_TILE) DT_BLUE_TILE = dtVoidAndCluster(DT_BLUE_SIZE, DT_BLUE_SIGMA, DT_BLUE_SEED);
  return DT_BLUE_TILE;
}

export function ditherBlueNoise(env) {
  dtRunOrdered(env, dtBlueNoiseTile(), DT_BLUE_SIZE);
}
