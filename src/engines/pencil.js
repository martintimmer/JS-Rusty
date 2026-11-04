import { clamp, smoothstep, lerp, clampIndex, CELL_PX } from '../rendering/core.js';
import { buildFlow, createFlowBuffers } from '../rendering/flow.js';

// Pencil sketch.
// 1) A fixed white-noise texture is smeared along the contour direction (line integral
//    convolution over the shared flow field). Strokes therefore follow the subject.
// 2) The smeared texture is rank-normalised per frame and compared with the darkness, so
//    darker areas get more strokes. Strokes are graphite grey, deeper where it is darker.
// 3) Contours that separate light from dark get a darker outline, as a drawn edge would.
// 4) Paper grain is added per pixel. Texels are one grid cell (2 px at 1080p), which keeps
//    the strokes fine. Painting is one pass over the pixels.

const PENCIL_GRAIN_SIZE = 512;
const PENCIL_GRAIN = new Float32Array(PENCIL_GRAIN_SIZE);
for (let i = 0; i < PENCIL_GRAIN_SIZE; i++) {
  const s = Math.sin(i * 12.9898 + 4.1) * 43758.5453;
  PENCIL_GRAIN[i] = (s - Math.floor(s)) - 0.5;
}

export function renderPencil(rc) {
  const { ctx, W, H, grid, p, pal, state } = rc;
  const gw = grid.gw;
  const gh = grid.gh;
  const cn = gw * gh;

  if (state.cn !== cn) {
    state.cn = cn;
    state.flow = createFlowBuffers(cn);
    state.noise = new Float32Array(cn);
    state.tex = new Float32Array(cn);
    state.alpha = new Float32Array(cn);
    state.hist = new Uint32Array(256);
    state.cdf = new Float32Array(256);
    // Deterministic xorshift noise, so strokes are stable from frame to frame.
    let seed = 2463534242;
    for (let i = 0; i < cn; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      state.noise[i] = (seed >>> 0) / 4294967296;
    }
  }
  if (!state.img || state.img.width !== W || state.img.height !== H) {
    state.img = ctx.createImageData(W, H);
  }

  // 1) Contour-aligned flow field from the structure tensor.
  buildFlow(grid, state.flow);
  const F = state.flow;

  // 2) Line integral convolution: average the noise along the flow, both ways.
  const L = Math.round(lerp(2, 5, clamp(p.detail, 0, 100) / 100));
  const noise = state.noise;
  const tex = state.tex;
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let sum = 0;
      for (let dir = -1; dir <= 1; dir += 2) {
        let x = gx + 0.5;
        let y = gy + 0.5;
        let px = 0;
        let py = 0;
        for (let s = 0; s < L; s++) {
          const fi = clampIndex(Math.floor(y), gh) * gw + clampIndex(Math.floor(x), gw);
          let vx = F.fx[fi] * dir;
          let vy = F.fy[fi] * dir;
          if (s > 0 && vx * px + vy * py < 0) {
            vx = -vx;
            vy = -vy;
          }
          sum += noise[clampIndex(Math.floor(y), gh) * gw + clampIndex(Math.floor(x), gw)];
          x += vx;
          y += vy;
          px = vx;
          py = vy;
        }
      }
      tex[gy * gw + gx] = sum / (2 * L);
    }
  }

  // 3) Rank-normalise the texture so it is uniform in [0, 1] over this frame.
  const hist = state.hist;
  const cdf = state.cdf;
  hist.fill(0);
  for (let i = 0; i < cn; i++) hist[Math.min(255, (tex[i] * 256) | 0)]++;
  let acc = 0;
  for (let b = 0; b < 256; b++) {
    acc += hist[b];
    cdf[b] = acc / cn;
  }

  // 4) Stroke coverage. A texel is inked where its rank exceeds 1 - coverage.
  // Density sets the pressure (coverage multiplier).
  const pressure = 0.55 + 0.9 * clamp(p.density, 0, 100) / 100;
  const alpha = state.alpha;
  const ink = grid.ink;
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const i = gy * gw + gx;
      const darkness = clamp(ink[i], 0, 1);
      const rank = cdf[Math.min(255, (tex[i] * 256) | 0)];
      const threshold = 1 - clamp(Math.pow(darkness, 1.25) * pressure, 0, 1);
      // Graphite is grey in light areas and deeper where it is dark.
      const strength = 0.45 + 0.4 * darkness;
      let a = smoothstep(threshold - 0.04, threshold + 0.04, rank) * strength;

      // 5) Outline: strong tone changes get a darker edge.
      const xm = gx > 0 ? gx - 1 : 0;
      const xp = gx < gw - 1 ? gx + 1 : gx;
      const ym = gy > 0 ? gy - 1 : 0;
      const yp = gy < gh - 1 ? gy + 1 : gy;
      const edge = clamp((Math.abs(ink[gy * gw + xp] - ink[gy * gw + xm]) +
        Math.abs(ink[yp * gw + gx] - ink[ym * gw + gx])) * 2.5, 0, 1);
      a = Math.max(a, edge * 0.55);
      alpha[i] = a;
    }
  }

  // 6) Paint each pixel from its texel, with paper grain.
  const out = state.img.data;
  const paper = pal.bg;
  const inkRgb = pal.stroke;
  for (let y = 0; y < H; y++) {
    const gy = Math.min(gh - 1, Math.floor(y / CELL_PX));
    for (let x = 0; x < W; x++) {
      const gx = Math.min(gw - 1, Math.floor(x / CELL_PX));
      const a = alpha[gy * gw + gx];
      const grain = PENCIL_GRAIN[(x * 13 + y * 57) & (PENCIL_GRAIN_SIZE - 1)] * 14;
      const o = (y * W + x) * 4;
      out[o] = paper[0] + (inkRgb[0] - paper[0]) * a + grain;
      out[o + 1] = paper[1] + (inkRgb[1] - paper[1]) * a + grain;
      out[o + 2] = paper[2] + (inkRgb[2] - paper[2]) * a + grain;
      out[o + 3] = 255;
    }
  }
  ctx.putImageData(state.img, 0, 0);
  rc.elements = cn;
}
