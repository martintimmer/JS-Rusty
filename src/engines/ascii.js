import { clamp, lerp, sampleInk } from '../rendering/core.js';

// ASCII glyphs.
// The canvas is divided into a grid of character cells. Each cell's darkness (sampled at its
// centre from the analysis grid) picks a glyph from a ramp ordered from light to dark, and the
// glyph is drawn in the ink colour on the paper. Density sets the cell size; Detail chooses a
// short ramp (fewer, bolder glyphs) or a long one (smoother tones).

const ASCII_LONG_RAMP = " .'`^\",:;Il!i><~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$";
const ASCII_FONT = 'ui-monospace, Menlo, Consolas, "Courier New", monospace';

export function renderAscii(rc) {
  const { ctx, W, H, grid, p, pal } = rc;
  const scale = W / 1920;
  const density = clamp(p.density, 0, 100) / 100;
  const cellH = Math.max(5, lerp(26, 12, density) * scale);
  const cellW = cellH * 0.6;
  // Detail sets the number of tone levels: glyphs are sampled evenly from the long ramp,
  // from the lightest glyph to the darkest, so every level stays in order.
  const levels = Math.round(lerp(6, 40, clamp(p.detail, 0, 100) / 100));
  const ramp = [];
  for (let k = 0; k < levels; k++) {
    const at = levels > 1 ? Math.round((k * (ASCII_LONG_RAMP.length - 1)) / (levels - 1)) : 0;
    ramp.push(ASCII_LONG_RAMP[at]);
  }
  const top = levels - 1;
  const cols = Math.ceil(W / cellW);
  const rows = Math.ceil(H / cellH);

  ctx.fillStyle = pal.bgCss;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = pal.strokeCss;
  ctx.font = cellH.toFixed(2) + 'px ' + ASCII_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  let glyphs = 0;
  for (let r = 0; r < rows; r++) {
    const y = (r + 0.5) * cellH;
    for (let c = 0; c < cols; c++) {
      const x = (c + 0.5) * cellW;
      const d = clamp(sampleInk(grid, x, y), 0, 1);
      const idx = Math.round(d * top);
      if (idx === 0) continue;
      ctx.fillText(ramp[idx], x, y);
      glyphs++;
    }
  }
  rc.elements = glyphs;
}
