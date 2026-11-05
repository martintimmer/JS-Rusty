import { clamp, lerp, sampleInk } from '../rendering/core.js';
import { mfActive, mfHash, MOTION_BASE } from '../rendering/motion-field.js';

// Halftone screen on a hexagonal lattice.
// A square lattice of dots reads as a mesh of squares. A hexagonal lattice (rows offset by
// half a cell), rotated by 15 degrees and jittered slightly per dot, has no square cells.
// Each dot's area follows the darkness under its centre, so dark areas become near-solid
// and light areas stay paper.

const ROTATION = Math.PI / 12;
const SQRT3_2 = 0.8660254037844576;

function htHash(n) {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}

export function renderHalftone(rc) {
  const { ctx, W, H, grid, p, pal } = rc;
  const scale = W / 1920;
  const density = clamp(p.density, 0, 100) / 100;
  const cell = Math.max(3, lerp(18, 5, density) * scale);
  const rowH = cell * SQRT3_2;
  const cos = Math.cos(ROTATION);
  const sin = Math.sin(ROTATION);
  const ox = W / 2;
  const oy = H / 2;
  const maxRadius = cell * 0.6 * clamp(p.thickness, 0.2, 1.6);
  const reach = Math.ceil(Math.hypot(W, H) / Math.min(cell, rowH)) + 2;
  const path = new Path2D();
  let dots = 0;
  // Motion, when on. Pulse swells the dots in rings that leave the darkest mass; Hover floats each dot on its own phase.
  const pulse = mfActive(rc, 'pulse');
  const hover = mfActive(rc, 'hover');
  const amount = rc.motion ? rc.motion.amount : 0;
  const time = rc.motion ? rc.motion.time : 0;
  const pulseFreq = pulse ? rc.motion.freq(MOTION_BASE.pulse) : 0;
  const hoverFreq = hover ? rc.motion.freq(MOTION_BASE.hover) : 0;
  const centre = pulse ? rc.motion.centre : null;
  const ringLength = 170 * scale;

  ctx.fillStyle = pal.bgCss;
  ctx.fillRect(0, 0, W, H);

  for (let j = -reach; j <= reach; j++) {
    const offset = (((j % 2) + 2) % 2) * 0.5 * cell;
    for (let i = -reach; i <= reach; i++) {
      const id = i * 131 + j * 977;
      // Per-dot jitter breaks the lattice without moving dots far from their cell.
      const jx = (htHash(id) - 0.5) * cell * 0.14;
      const jy = (htHash(id + 0.5) - 0.5) * rowH * 0.14;
      const lx = i * cell + offset + jx;
      const ly = j * rowH + jy;
      const x = ox + lx * cos - ly * sin;
      const y = oy + lx * sin + ly * cos;
      if (x < -cell || y < -cell || x > W + cell || y > H + cell) continue;

      const darkness = sampleInk(grid, x, y);
      // Area tracks tone: radius grows with the square root of darkness.
      let radius = maxRadius * Math.sqrt(darkness) * (0.94 + 0.12 * htHash(id + 7.3));
      if (pulse) {
        const d = Math.hypot(x - centre.x, y - centre.y);
        radius *= 1 + 0.35 * amount * Math.sin(2 * Math.PI * (pulseFreq * time - d / ringLength));
      }
      if (radius < 0.35) continue;
      let dx = x;
      let dy = y;
      if (hover) {
        const a = 2 * Math.PI * (hoverFreq * time + mfHash(id + 3.1));
        const amp = 0.14 * cell * amount;
        dx += amp * Math.cos(a);
        dy += amp * Math.sin(a);
      }
      path.moveTo(dx + radius, dy);
      path.arc(dx, dy, radius, 0, Math.PI * 2);
      dots++;
    }
  }

  ctx.fillStyle = pal.strokeCss;
  ctx.fill(path);
  rc.elements = dots;
}
