import {
  PHI, PHI2, PHI3, frac,
  clamp, lerp, buildCdf, cdfLookup, sampleMotion,
  CANVAS_SCALE, CELL_PX, MAX_ELEMENTS,
} from '../rendering/core.js';

// Stippling engine with tone-sized dots.
// Each dot has a fixed low-discrepancy rank u. Its position is the grid cell where the
// cumulative darkness distribution of the current frame reaches u, so dot density
// follows darkness. Each dot's radius also follows the darkness under it, so dark
// regions read as merged, solid shapes and light regions stay clear. Motion vectors
// push dots with a decaying offset.


export function renderStippling(rc) {
  const { ctx, W, H, grid, p, pal, data, k, state } = rc;
  const mv = state.mv || (state.mv = new Float32Array(3));
  const cells = grid.gw * grid.gh;
  if (!state.cdf || state.cdf.length !== cells) {
    state.cdf = new Float64Array(cells);
  }
  if (!state.off) {
    state.off = new Float32Array(MAX_ELEMENTS * 2);
  }

  const N = Math.min(MAX_ELEMENTS, Math.max(1, Math.round(p.particles)));
  // Detail sharpens the density curve: higher detail concentrates dots in the darkest areas.
  const gamma = lerp(1, 2.5, clamp(p.detail, 0, 100) / 100);
  const total = buildCdf(grid, gamma, state.cdf);
  const scale = W / 1920;
  const maxRadius = Math.max(0.6, 3.0 * p.thickness * scale);
  const useMotion = p.motion > 0 && data.motion && data.count > 1;
  const off = state.off;

  ctx.fillStyle = pal.bgCss;
  ctx.fillRect(0, 0, W, H);

  const path = new Path2D();
  let drawn = 0;
  for (let i = 0; i < N; i++) {
    const u = frac((i + 0.5) * PHI);
    const cell = cdfLookup(state.cdf, cells, u * total);
    const darkness = grid.ink[cell];
    const radius = maxRadius * Math.sqrt(darkness);
    if (radius < 0.3) continue;

    const gx = cell % grid.gw;
    const gy = (cell / grid.gw) | 0;
    const jx = frac((i + 1) * PHI2) - 0.5;
    const jy = frac((i + 1) * PHI3) - 0.5;
    let x = (gx + 0.5 + jx) * CELL_PX;
    let y = (gy + 0.5 + jy) * CELL_PX;

    const oi = i * 2;
    if (useMotion) {
      sampleMotion(data, k, x / CANVAS_SCALE, y / CANVAS_SCALE, mv);
      // Decay the previous displacement and add the current motion push.
      off[oi] = off[oi] * 0.9 + mv[0] * CANVAS_SCALE * p.motion * 0.6;
      off[oi + 1] = off[oi + 1] * 0.9 + mv[1] * CANVAS_SCALE * p.motion * 0.6;
    } else {
      off[oi] *= 0.9;
      off[oi + 1] *= 0.9;
    }
    x += off[oi];
    y += off[oi + 1];

    path.moveTo(x + radius, y);
    path.arc(x, y, radius, 0, Math.PI * 2);
    drawn++;
  }

  ctx.fillStyle = pal.strokeCss;
  ctx.fill(path);
  rc.elements = drawn;
}
