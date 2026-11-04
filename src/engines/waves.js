import { clamp, lerp, sampleInk } from '../rendering/core.js';

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
      const lift = amplitude * sampleInk(grid, x, Math.min(H - 1, y0));
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
    rows++;
  }
  rc.elements = rows;
}
