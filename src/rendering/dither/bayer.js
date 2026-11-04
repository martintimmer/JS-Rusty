import { dtRunOrdered } from './quantize.js';

// Bayer ordered dithering. The threshold matrix comes from the recursive construction
// M(2n) = [[4M, 4M+2], [4M+3, 4M+1]], so every entry is a distinct rank of 0 .. size*size-1. Thresholds are
// (rank + 0.5) / (size*size), spread evenly over (0, 1). The pattern is regular, which gives the familiar
// crosshatch texture. Two sizes are offered: 8 x 8 (finer tones) and 4 x 4 (a coarser, more visible pattern).

function dtBayerMatrix(size) {
  let m = [[0]];
  let s = 1;
  while (s < size) {
    const next = [];
    for (let y = 0; y < 2 * s; y++) next.push(new Array(2 * s).fill(0));
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const v = 4 * m[y][x];
        next[y][x] = v;
        next[y][x + s] = v + 2;
        next[y + s][x] = v + 3;
        next[y + s][x + s] = v + 1;
      }
    }
    m = next;
    s *= 2;
  }
  const area = size * size;
  const out = new Float32Array(area);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) out[y * size + x] = (m[y][x] + 0.5) / area;
  }
  return out;
}

const BAYER8_MATRIX = dtBayerMatrix(8);
const BAYER4_MATRIX = dtBayerMatrix(4);

export function ditherBayer(env) {
  dtRunOrdered(env, BAYER8_MATRIX, 8);
}

export function ditherBayer4(env) {
  dtRunOrdered(env, BAYER4_MATRIX, 4);
}
