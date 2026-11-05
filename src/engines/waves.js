import { clamp, lerp, sampleInk } from '../rendering/core.js';
import { mfActive, mfSnake, mfSwell, MOTION_BASE } from '../rendering/motion-field.js';

// Wave lines (occluded ridge lines).
// Horizontal rows are lifted by the darkness under them, so the picture appears as a
// landscape of ridges. Rows are drawn top to bottom and each one first fills the paper
// below its own line, so lower ridges hide the ridges above them, giving depth.

export function renderWaves(rc) {
  const { ctx, W, H, grid, p, pal } = rc;
  const scale = W / 1920;
  const density = clamp(p.density, 0, 100) / 100;
  const detail = clamp(p.detail, 0, 100) / 100;
  const pitch = Math.max(3, lerp(26, 6, density) * scale);
  const amplitude = pitch * lerp(1.2, 3.6, detail);
  const stepX = Math.max(2, 3 * scale);
  const lineWidth = Math.max(0.6, 1.3 * clamp(p.thickness, 0.2, 2) * scale);
  const columns = Math.ceil(W / stepX) + 1;
  const lineY = new Float32Array(columns);

  // Motion, when on. Ripple travels a wave along the ridges. Snake runs a bead of thicker ink along a share of them.
  const ripple = mfActive(rc, 'ripple');
  const beads = mfActive(rc, 'snake');
  const motion = rc.motion;
  const rippleFreq = ripple ? motion.freq(MOTION_BASE.ripple) : 0;
  const ripLength = 240 * scale;
  const beadLength = Math.max(4, Math.round(0.12 * columns));
  const beadWidth = lineWidth * (1 + 1.2 * clamp(p.thickness, 0.2, 2));

  ctx.fillStyle = pal.bgCss;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = pal.strokeCss;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = 'round';

  let rows = 0;
  for (let y0 = pitch * 0.5; y0 < H + pitch; y0 += pitch) {
    const line = new Path2D();
    for (let c = 0; c < columns; c++) {
      const x = Math.min(W, c * stepX);
      // Ridge height from darkness; the row's own baseline is y0.
      let lift = amplitude * sampleInk(grid, x, Math.min(H - 1, y0));
      if (ripple) lift += 0.5 * pitch * motion.amount * Math.sin(2 * Math.PI * (rippleFreq * motion.time - x / ripLength));
      lineY[c] = y0 - lift;
      if (c === 0) line.moveTo(x, lineY[c]);
      else line.lineTo(x, lineY[c]);
    }

    // Occlude: paper below this row's line, down to the next row's baseline.
    const bottom = y0 + pitch;
    const mask = new Path2D();
    mask.moveTo(0, lineY[0]);
    for (let c = 1; c < columns; c++) mask.lineTo(Math.min(W, c * stepX), lineY[c]);
    mask.lineTo(W, bottom);
    mask.lineTo(0, bottom);
    mask.closePath();
    ctx.fillStyle = pal.bgCss;
    ctx.fill(mask);

    ctx.stroke(line);
    if (beads) {
      // The bead follows this ridge from behind its head, and is drawn before the ridges below hide it.
      const f = mfSnake(motion, rows);
      if (f >= 0) {
        const hi = Math.floor(f * (columns + beadLength));
        const a = Math.max(0, hi - beadLength);
        const b = Math.min(columns - 1, hi);
        if (b > a) {
          const bead = new Path2D();
          bead.moveTo(Math.min(W, a * stepX), lineY[a]);
          for (let c = a + 1; c <= b; c++) bead.lineTo(Math.min(W, c * stepX), lineY[c]);
          // On video the bead swells where the picture moves at its head.
          ctx.lineWidth = beadWidth * mfSwell(rc, Math.min(W, b * stepX), lineY[b]);
          ctx.stroke(bead);
          ctx.lineWidth = lineWidth;
        }
      }
    }
    rows++;
  }
  rc.elements = rows;
}
