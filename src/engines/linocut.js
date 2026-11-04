import { clamp, lerp, clampIndex, CELL_PX } from '../rendering/core.js';
import { buildFlow, createFlowBuffers } from '../rendering/flow.js';

// Linocut / woodcut, two-tone.
// Where the picture is dark, the block is left solid black. In the middle tones, black
// gouge-free streaks run along the contours: a noise texture is smeared along the flow field
// (line integral convolution, the same field pencil uses) and thresholded against the
// darkness, so the paper shows through as carved lines. Strong tone edges are cut as outlines.
// Output is binary, on a texel grid two cells (4 px at 1080p) wide, which gives chunky cuts.

const LIN_NOISE_SEED = 987654321;

export function renderLinocut(rc) {
  const { ctx, W, H, grid, p, pal, state } = rc;
  const gw = grid.gw;
  const gh = grid.gh;
  const tw = Math.ceil(gw / 2);
  const th = Math.ceil(gh / 2);
  const tn = tw * th;

  if (state.tn !== tn) {
    state.tn = tn;
    state.flow = createFlowBuffers(gw * gh);
    state.noise = new Float32Array(tn);
    state.tex = new Float32Array(tn);
    state.hist = new Uint32Array(256);
    state.cdf = new Float32Array(256);
    state.bits = new Uint8Array(tn);
    let seed = LIN_NOISE_SEED;
    for (let i = 0; i < tn; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      state.noise[i] = (seed >>> 0) / 4294967296;
    }
  }
  if (!state.img || state.img.width !== W || state.img.height !== H) {
    state.img = ctx.createImageData(W, H);
  }

  buildFlow(grid, state.flow);
  const F = state.flow;
  const L = Math.round(lerp(2, 5, clamp(p.detail, 0, 100) / 100));
  const noise = state.noise;
  const tex = state.tex;

  // Line integral convolution on the texel grid, following the contour direction.
  for (let ty = 0; ty < th; ty++) {
    for (let tx = 0; tx < tw; tx++) {
      let sum = 0;
      for (let dir = -1; dir <= 1; dir += 2) {
        let x = tx + 0.5;
        let y = ty + 0.5;
        let px = 0;
        let py = 0;
        for (let s = 0; s < L; s++) {
          const fi = clampIndex(Math.floor(y * 2), gh) * gw + clampIndex(Math.floor(x * 2), gw);
          let vx = F.fx[fi] * dir;
          let vy = F.fy[fi] * dir;
          if (s > 0 && vx * px + vy * py < 0) {
            vx = -vx;
            vy = -vy;
          }
          sum += noise[clampIndex(Math.floor(y), th) * tw + clampIndex(Math.floor(x), tw)];
          x += vx;
          y += vy;
          px = vx;
          py = vy;
        }
      }
      tex[ty * tw + tx] = sum / (2 * L);
    }
  }

  // Rank-normalise the texture over this frame so thresholds are uniform.
  const hist = state.hist;
  const cdf = state.cdf;
  hist.fill(0);
  for (let i = 0; i < tn; i++) hist[Math.min(255, (tex[i] * 256) | 0)]++;
  let acc = 0;
  for (let b = 0; b < 256; b++) {
    acc += hist[b];
    cdf[b] = acc / tn;
  }

  // Bits: solid where very dark; streaks where the rank falls under the darkness; outlines on
  // strong tone edges. Density scales how much of the middle tone is cut as streaks.
  const scale = clamp(p.density, 0, 100) / 100;
  const ink = grid.ink;
  const bits = state.bits;
  for (let ty = 0; ty < th; ty++) {
    for (let tx = 0; tx < tw; tx++) {
      const i = ty * tw + tx;
      const fx = clampIndex(tx * 2, gw);
      const fy = clampIndex(ty * 2, gh);
      const d = clamp(ink[fy * gw + fx], 0, 1);
      const rank = cdf[Math.min(255, (tex[i] * 256) | 0)];
      const dxs = ink[fy * gw + clampIndex(fx + 1, gw)] - ink[fy * gw + clampIndex(fx - 1, gw)];
      const dys = ink[clampIndex(fy + 1, gh) * gw + fx] - ink[clampIndex(fy - 1, gh) * gw + fx];
      const edge = clamp((Math.abs(dxs) + Math.abs(dys)) * 2.5, 0, 1);
      // Light areas stay clean paper: streaks only start once the tone is past ~0.22.
      const streak = rank < clamp((d - 0.22) * (1.2 + 0.6 * scale), 0, 1);
      const solid = d > 0.8;
      bits[i] = solid || streak || edge > 0.55 ? 1 : 0;
    }
  }

  // Paint the two tones with hard edges, one texel = 2 grid cells = 4 px at 1080p.
  const out = state.img.data;
  const bg = pal.bg;
  const inkRgb = pal.stroke;
  const texelPx = CELL_PX * 2;
  for (let y = 0; y < H; y++) {
    const ty = Math.min(th - 1, Math.floor(y / texelPx));
    for (let x = 0; x < W; x++) {
      const tx = Math.min(tw - 1, Math.floor(x / texelPx));
      const on = bits[ty * tw + tx];
      const o = (y * W + x) * 4;
      out[o] = on ? inkRgb[0] : bg[0];
      out[o + 1] = on ? inkRgb[1] : bg[1];
      out[o + 2] = on ? inkRgb[2] : bg[2];
      out[o + 3] = 255;
    }
  }
  ctx.putImageData(state.img, 0, 0);
  rc.elements = tn;
}
