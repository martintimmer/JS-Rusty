import { clamp, lerp, clampIndex, CELL_PX } from '../rendering/core.js';

// Oil paint, using the Kuwahara filter (Kuwahara et al., 1976; Kyprianidis et al., 2009).
// For each pixel, a (2a+1)-square window is split into four overlapping quadrants, each
// (a+1)x(a+1) and containing the centre. The quadrant with the lowest standard deviation
// wins, and its mean is the output. Flat areas take on a blocky, brushed colour while edges
// stay sharp. Quadrant statistics come from summed-area tables, so each pixel costs a few
// lookups whatever the radius. Runs on the analysis grid; the radius follows Detail.

const OIL_GRAIN_SIZE = 256;
const OIL_GRAIN = new Float32Array(OIL_GRAIN_SIZE);
for (let i = 0; i < OIL_GRAIN_SIZE; i++) {
  const s = Math.sin(i * 7.31 + 0.9) * 9371.13;
  OIL_GRAIN[i] = (s - Math.floor(s)) - 0.5;
}

// Sum over the inclusive rectangle [x0..x1] x [y0..y1] from a summed-area table
// (table is (gw+1) x (gh+1), with a zero first row and column).
function oilRect(sat, stride, x0, x1, y0, y1) {
  return sat[(y1 + 1) * stride + (x1 + 1)] - sat[y0 * stride + (x1 + 1)] -
    sat[(y1 + 1) * stride + x0] + sat[y0 * stride + x0];
}

export function renderOil(rc) {
  const { ctx, W, H, grid, p, pal, state } = rc;
  const gw = grid.gw;
  const gh = grid.gh;
  const n = gw * gh;
  const stride = gw + 1;
  const tableSize = (gw + 1) * (gh + 1);
  if (!state.sat1 || state.sat1.length !== tableSize) {
    state.sat1 = new Float64Array(tableSize);
    state.sat2 = new Float64Array(tableSize);
    state.mean = new Float32Array(n);
  }
  if (!state.img || state.img.width !== W || state.img.height !== H) {
    state.img = ctx.createImageData(W, H);
  }
  const sat1 = state.sat1;
  const sat2 = state.sat2;
  const mean = state.mean;
  const lum = grid.lum;

  // Summed-area tables of luminance (0..1) and its square.
  for (let y = 0; y < gh; y++) {
    let r1 = 0;
    let r2 = 0;
    for (let x = 0; x < gw; x++) {
      const v = lum[y * gw + x] / 255;
      r1 += v;
      r2 += v * v;
      sat1[(y + 1) * stride + (x + 1)] = sat1[y * stride + (x + 1)] + r1;
      sat2[(y + 1) * stride + (x + 1)] = sat2[y * stride + (x + 1)] + r2;
    }
  }

  // Radius in grid cells (2 px each at 1080p): 2 at low detail, 6 at high detail.
  const a = Math.max(1, Math.round(lerp(2, 6, clamp(p.detail, 0, 100) / 100)));

  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      // The four quadrants, as in Kuwahara et al.: each contains the centre pixel.
      const qx0 = [x, x - a, x - a, x];
      const qx1 = [x + a, x, x, x + a];
      const qy0 = [y, y, y - a, y - a];
      const qy1 = [y + a, y + a, y, y];
      let bestVar = Infinity;
      let bestMean = 0;
      for (let q = 0; q < 4; q++) {
        const x0 = clampIndex(qx0[q], gw);
        const x1 = clampIndex(qx1[q], gw);
        const y0 = clampIndex(qy0[q], gh);
        const y1 = clampIndex(qy1[q], gh);
        const count = (x1 - x0 + 1) * (y1 - y0 + 1);
        const s1 = oilRect(sat1, stride, x0, x1, y0, y1);
        const s2 = oilRect(sat2, stride, x0, x1, y0, y1);
        const m = s1 / count;
        const variance = s2 / count - m * m;
        if (variance < bestVar) {
          bestVar = variance;
          bestMean = m;
        }
      }
      mean[y * gw + x] = bestMean;
    }
  }

  // Paint: darker mean gives more ink. Each texel is one grid cell, with a little paper grain.
  const out = state.img.data;
  const bg = pal.bg;
  const ink = pal.stroke;
  for (let y = 0; y < H; y++) {
    const gy = Math.min(gh - 1, Math.floor(y / CELL_PX));
    for (let x = 0; x < W; x++) {
      const gx = Math.min(gw - 1, Math.floor(x / CELL_PX));
      const darkness = 1 - mean[gy * gw + gx];
      const grain = OIL_GRAIN[(x * 5 + y * 17) & (OIL_GRAIN_SIZE - 1)] * 10;
      const o = (y * W + x) * 4;
      out[o] = bg[0] + (ink[0] - bg[0]) * darkness + grain;
      out[o + 1] = bg[1] + (ink[1] - bg[1]) * darkness + grain;
      out[o + 2] = bg[2] + (ink[2] - bg[2]) * darkness + grain;
      out[o + 3] = 255;
    }
  }
  ctx.putImageData(state.img, 0, 0);
  rc.elements = n;
}
