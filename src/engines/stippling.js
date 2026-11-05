import {
  PHI, PHI2, PHI3, frac,
  clamp, lerp, buildCdf, cdfLookup, sampleMotion,
  CANVAS_SCALE, CELL_PX, MAX_ELEMENTS,
} from '../rendering/core.js';
import { mfActive, mfHash, MOTION_BASE } from '../rendering/motion-field.js';

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

  // Hover (a still, or a video without motion vectors): every dot floats on a small circle about its place, on its own
  // phase, so the dot cloud drifts without any dot leaving its region.
  const hover = !useMotion && mfActive(rc, 'hover');
  const hoverPhase = hover ? rc.motion.freq(MOTION_BASE.hover) * rc.motion.time : 0;
  const hoverAmp = hover ? 2.5 * scale * rc.motion.amount : 0;
  // The push from motion vectors decays by time, not by frame, so the look does not depend on the frame rate. At 60
  // frames per second this is the old 0.9 decay and push.
  const keep = Math.pow(0.9, Math.max(0, rc.dt || 0) * 60);
  const gain = (1 - keep) / 0.1;

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
      off[oi] = off[oi] * keep + mv[0] * CANVAS_SCALE * p.motion * 0.6 * gain;
      off[oi + 1] = off[oi + 1] * keep + mv[1] * CANVAS_SCALE * p.motion * 0.6 * gain;
    } else {
      off[oi] *= keep;
      off[oi + 1] *= keep;
    }
    x += off[oi];
    y += off[oi + 1];
    if (hover) {
      const a = 2 * Math.PI * (hoverPhase + mfHash(i * 0.77 + 0.2));
      x += hoverAmp * Math.cos(a);
      y += hoverAmp * Math.sin(a);
    }

    path.moveTo(x + radius, y);
    path.arc(x, y, radius, 0, Math.PI * 2);
    drawn++;
  }

  ctx.fillStyle = pal.strokeCss;
  ctx.fill(path);
  rc.elements = drawn;
}
