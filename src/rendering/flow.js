// Structure-tensor direction field shared by the flow-based engines.
// Lines run along the contour of the subject (perpendicular to the dominant gradient).
// Flat or noisy areas fall back to horizontal. Output: fx/fy per full grid cell, unit length.
import { smoothstep, blurGrid } from './core.js';

// Allocates every buffer buildFlow needs for a grid with `cells` cells.
export function createFlowBuffers(cells) {
  return {
    jxx: new Float32Array(cells),
    jyy: new Float32Array(cells),
    jxy: new Float32Array(cells),
    tmp: new Float32Array(cells),
    cfx: new Float32Array(cells),
    cfy: new Float32Array(cells),
    fx: new Float32Array(cells),
    fy: new Float32Array(cells),
  };
}

// The field is smooth by design, so it is computed on a half-resolution grid and
// expanded back to the full grid (about 4x less tensor work).
export function buildFlow(grid, S) {
  const gw = grid.gw;
  const gh = grid.gh;
  const lum = grid.lum;
  const cw = Math.ceil(gw / 2);
  const ch = Math.ceil(gh / 2);
  const { jxx, jyy, jxy, fx, fy, cfx, cfy } = S;

  for (let cy = 0; cy < ch; cy++) {
    const y = Math.min(gh - 1, cy * 2);
    const ym = y > 0 ? y - 1 : 0;
    const yp = y < gh - 1 ? y + 1 : y;
    for (let cx = 0; cx < cw; cx++) {
      const x = Math.min(gw - 1, cx * 2);
      const xm = x > 0 ? x - 1 : 0;
      const xp = x < gw - 1 ? x + 1 : x;
      const gx = lum[y * gw + xp] - lum[y * gw + xm];
      const gy = lum[yp * gw + x] - lum[ym * gw + x];
      const i = cy * cw + cx;
      jxx[i] = gx * gx;
      jyy[i] = gy * gy;
      jxy[i] = gx * gy;
    }
  }
  // Heavy smoothing keeps the field on true contours instead of texture noise.
  const cn = cw * ch;
  blurGrid(jxx, S.tmp, cw, ch, 1.75);
  blurGrid(jyy, S.tmp, cw, ch, 1.75);
  blurGrid(jxy, S.tmp, cw, ch, 1.75);

  for (let i = 0; i < cn; i++) {
    const a = jxx[i];
    const b = jyy[i];
    const c = jxy[i];
    const diff = a - b;
    const root = Math.sqrt(diff * diff + 4 * c * c);
    const tr = a + b;
    const coherence = tr > 1e-6 ? root / tr : 0;
    // Dominant gradient angle; the contour is perpendicular to it.
    const phi = 0.5 * Math.atan2(2 * c, diff);
    const vxc = -Math.sin(phi);
    const vyc = Math.cos(phi);
    const w = smoothstep(0.2, 0.7, coherence);
    const vx = w * vxc + (1 - w);
    const vy = w * vyc;
    const len = Math.hypot(vx, vy) || 1;
    cfx[i] = vx / len;
    cfy[i] = vy / len;
  }

  for (let y = 0; y < gh; y++) {
    const cy = y >> 1;
    for (let x = 0; x < gw; x++) {
      const src = cy * cw + (x >> 1);
      fx[y * gw + x] = cfx[src];
      fy[y * gw + x] = cfy[src];
    }
  }
}

