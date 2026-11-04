import { clamp, lerp, smoothstep, sampleInk, CELL_PX } from '../rendering/core.js';

// Engraving, rasterised directly into pixels (no Path2D geometry).
//
// Horizontal (default): one pass per line. Each line has its own spacing jitter, a slow
// wobble along its length, a weight that varies along it, and a little ink-density
// variation, which gives the hand-drawn feel of pen work. Line weight follows the
// tone under the line centre, and thin ends taper into the paper. Edges are anti-aliased.
//
// Diagonal and crosshatched: a per-pixel pass with straight families at 45 and -45
// degrees (plus 0 for crosshatch). Each family takes over at a higher tone.
//
// Cost is proportional to the number of pixels rather than the number of strokes,
// so this stays fast at 1080p.

const ENG_GRAIN_SIZE = 512;
const ENG_GRAIN = new Float32Array(ENG_GRAIN_SIZE);
for (let i = 0; i < ENG_GRAIN_SIZE; i++) ENG_GRAIN[i] = engHash(i * 0.731) - 0.5;

function engHash(n) {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}

export function renderEngraving(rc) {
  const { ctx, W, H, grid, p, pal, state } = rc;
  if (!state.img || state.img.width !== W || state.img.height !== H) {
    state.img = ctx.createImageData(W, H);
  }
  const img = state.img;
  const out = img.data;
  const bg = pal.bg;
  const ink = pal.stroke;

  const scale = W / 1920;
  const density = clamp(p.density, 0, 100) / 100;
  const pitch = Math.max(1.5, lerp(16, 2.2, density) * scale);
  // Darkest lines fill ~72% of the pitch, leaving a clear paper gap between lines.
  const maxHalf = 0.5 * pitch * clamp(p.thickness, 0.2, 1.6) * 0.72;

  // Paper first, then the strokes.
  for (let o = 0; o < out.length; o += 4) {
    out[o] = bg[0];
    out[o + 1] = bg[1];
    out[o + 2] = bg[2];
    out[o + 3] = 255;
  }

  let elements;
  if (p.pattern === 'diagonal' || p.pattern === 'crosshatch') {
    elements = engAngled(p, grid, W, H, pitch, maxHalf, bg, ink, out);
  } else {
    // Detail sets the hand-drawn wobble of each line (0 = ruled, 100 = most wavy).
    const wobble = pitch * lerp(0, 0.28, clamp(p.detail, 0, 100) / 100);
    elements = engHorizontal(grid, W, H, pitch, maxHalf, wobble, bg, ink, out);
  }

  // Paper grain: a little deterministic noise over everything.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const g = ENG_GRAIN[(x * 7 + y * 131) & (ENG_GRAIN_SIZE - 1)] * 9;
      const o = (y * W + x) * 4;
      out[o] += g;
      out[o + 1] += g;
      out[o + 2] += g;
    }
  }
  ctx.putImageData(img, 0, 0);
  rc.elements = elements;
}

// Horizontal lines, one line at a time. Returns the number of lines drawn.
function engHorizontal(grid, W, H, pitch, maxHalf, wobble, bg, ink, out) {
  let lines = 0;
  const last = Math.ceil(H / pitch) + 1;
  for (let k = -1; k <= last; k++) {
    const r1 = engHash(k * 1.7 + 0.3);
    const r2 = engHash(k * 3.1 + 1.9);
    const r3 = engHash(k * 5.3 + 0.7);
    const r4 = engHash(k * 2.9 + 4.1);
    // Spacing jitter keeps the lines from looking machine-ruled.
    const yBase = (k + 0.5) * pitch + (r1 - 0.5) * pitch * 0.2;
    if (yBase < -pitch || yBase > H + pitch) continue;
    const ph1 = r2 * 6.2832;
    const ph2 = r3 * 6.2832;
    const ph3 = r4 * 6.2832;
    const f1 = 0.011 + 0.004 * r1;
    const f2 = 0.037 + 0.01 * r2;
    const inkDensity = 0.88 + 0.12 * r4;

    let drawn = false;
    for (let x = 0; x < W; x++) {
      const xf = x + 0.5;
      // Wobble along the line, then the tone under the line centre.
      const yc = yBase + wobble * (Math.sin(xf * f1 + ph1) * 0.7 + Math.sin(xf * f2 + ph2) * 0.3);
      const tone = sampleInk(grid, xf, clamp(yc, 0, H - 1));
      // Weight varies along the line, so ink pools and thins like a pen does.
      const weight = 0.85 + 0.3 * Math.sin(xf * 0.019 + ph3);
      const half = maxHalf * smoothstep(0, 1, tone) * weight;
      if (half < 0.1) continue;
      drawn = true;
      const y0 = Math.max(0, Math.floor(yc - half - 1));
      const y1 = Math.min(H - 1, Math.ceil(yc + half + 1));
      for (let y = y0; y <= y1; y++) {
        const d = Math.abs(y + 0.5 - yc);
        const c = clamp(half - d + 0.5, 0, 1) * inkDensity;
        if (c > 0) {
          const o = (y * W + x) * 4;
          out[o] = bg[0] + (ink[0] - bg[0]) * c;
          out[o + 1] = bg[1] + (ink[1] - bg[1]) * c;
          out[o + 2] = bg[2] + (ink[2] - bg[2]) * c;
        }
      }
    }
    if (drawn) lines++;
  }
  return lines;
}

// Straight families at 45 and -45 degrees (plus 0 for crosshatch). Per-pixel pass.
function engAngled(p, grid, W, H, pitch, maxHalf, bg, ink, out) {
  const families = p.pattern === 'diagonal'
    ? [{ angle: Math.PI / 4, lo: 0 }]
    : [{ angle: 0, lo: 0 }, { angle: Math.PI / 4, lo: 0.5 }, { angle: -Math.PI / 4, lo: 0.78 }];
  const nf = families.length;
  const nxs = new Float32Array(nf);
  const nys = new Float32Array(nf);
  for (let f = 0; f < nf; f++) {
    nxs[f] = -Math.sin(families[f].angle);
    nys[f] = Math.cos(families[f].angle);
  }
  const gw = grid.gw;
  const gh = grid.gh;
  for (let y = 0; y < H; y++) {
    const gy = Math.min(gh - 1, Math.floor(y / CELL_PX));
    for (let x = 0; x < W; x++) {
      const gx = Math.min(gw - 1, Math.floor(x / CELL_PX));
      const tone = grid.ink[gy * gw + gx];
      let cover = 0;
      for (let f = 0; f < nf; f++) {
        const u = (x + 0.5) * nxs[f] + (y + 0.5) * nys[f];
        const du = u - Math.round(u / pitch) * pitch;
        const half = maxHalf * smoothstep(families[f].lo, 1, tone);
        const c = clamp(half - Math.abs(du) + 0.5, 0, 1);
        if (c > cover) cover = c;
      }
      if (cover > 0) {
        const o = (y * W + x) * 4;
        out[o] = bg[0] + (ink[0] - bg[0]) * cover;
        out[o + 1] = bg[1] + (ink[1] - bg[1]) * cover;
        out[o + 2] = bg[2] + (ink[2] - bg[2]) * cover;
      }
    }
  }
  return nf;
}
