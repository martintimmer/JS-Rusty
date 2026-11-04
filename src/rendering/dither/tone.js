import { clamp, lerp, smoothstep, boxBlur, GRID_CELL } from '../core.js';

// Tone preparation for the dither engines. Every function writes into arrays the caller owns, so
// nothing is allocated per frame.

// Averages k x k blocks of the analysis grid. Used for even cell sizes (2k canvas pixels). Blocks at the
// right and bottom edge are clipped.
export function dtBlockAverage(src, gw, gh, k, out, ow, oh) {
  for (let by = 0; by < oh; by++) {
    const y0 = by * k;
    const y1 = Math.min(gh, y0 + k);
    for (let bx = 0; bx < ow; bx++) {
      const x0 = bx * k;
      const x1 = Math.min(gw, x0 + k);
      let sum = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * gw;
        for (let x = x0; x < x1; x++) sum += src[row + x];
      }
      out[by * ow + bx] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
}

// Bilinear sample of the analysis grid at the centre of each dither cell. Used for odd cell sizes (1 px,
// 3 px, ...), where the cells do not line up with the analysis grid. A cell centre at canvas position
// (c + 0.5) * cellPx lies at grid position (c + 0.5) * cellPx / GRID_CELL - 0.5.
export function dtSampleGrid(src, gw, gh, cellPx, out, ow, oh) {
  for (let oy = 0; oy < oh; oy++) {
    let fy = ((oy + 0.5) * cellPx) / GRID_CELL - 0.5;
    if (fy < 0) fy = 0; else if (fy > gh - 1) fy = gh - 1;
    const y0 = Math.floor(fy);
    const y1 = y0 < gh - 1 ? y0 + 1 : y0;
    const ty = fy - y0;
    for (let ox = 0; ox < ow; ox++) {
      let fx = ((ox + 0.5) * cellPx) / GRID_CELL - 0.5;
      if (fx < 0) fx = 0; else if (fx > gw - 1) fx = gw - 1;
      const x0 = Math.floor(fx);
      const x1 = x0 < gw - 1 ? x0 + 1 : x0;
      const tx = fx - x0;
      const top = src[y0 * gw + x0] * (1 - tx) + src[y0 * gw + x1] * tx;
      const bottom = src[y1 * gw + x0] * (1 - tx) + src[y1 * gw + x1] * tx;
      out[oy * ow + ox] = top * (1 - ty) + bottom * ty;
    }
  }
}

// Gamma table over darkness, 256 entries: d -> 1 - (1 - d)^(1 / gamma). This is image gamma applied
// to luminance, so gamma above 1 lightens the midtones and gamma below 1 darkens them.
export function dtGammaTable(gamma, table) {
  for (let v = 0; v < 256; v++) table[v] = 1 - Math.pow(1 - v / 255, 1 / gamma);
  return table;
}

// Grain noise in [0, 1) from the cell index and a seed (integer hash). The seed is advanced on every
// rendered frame, so the grain is re-rolled each frame and moves. For one seed the grain is always the
// same, so a frame can be reproduced.
export function dtCellNoise(i, seed) {
  let h = Math.imul(i ^ Math.imul(seed | 0, 0x27d4eb2d), 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Tone (darkness, 0-1) per cell: invert, gamma, grain, then gain around mid grey (the original
// dither contrast). With default options this is exactly the original gain expression.
export function dtToneFill(src, n, opt, gammaLut, tone, seed) {
  const invert = opt.invert;
  const noise = opt.noise * 0.5;
  const gain = opt.gain;
  for (let i = 0; i < n; i++) {
    let d = src[i];
    if (d < 0) d = 0; else if (d > 1) d = 1;
    if (invert) d = 1 - d;
    if (gammaLut) d = gammaLut[(d * 255 + 0.5) | 0];
    if (noise > 0) d += (dtCellNoise(i, seed) - 0.5) * noise;
    d = (d - 0.5) * gain + 0.5;
    tone[i] = d < 0 ? 0 : (d > 1 ? 1 : d);
  }
}

// Local adaptive threshold. Each cell's threshold moves from the global value theta toward the local
// mean tone, by `amount`. The move is gated by local contrast (standard deviation over the window):
// flat areas keep the global threshold, so noise in them is not amplified, while edges and detail
// get a threshold that splits them. Result per cell in thr (clamped to 0.02-0.98).
// tmp, sq and sqMean are scratch arrays of the same length.
export function dtAdaptiveThreshold(tone, gw, gh, radius, amount, theta, thr, tmp, sq, sqMean) {
  const n = gw * gh;
  boxBlur(tone, tmp, thr, gw, gh, radius);
  for (let i = 0; i < n; i++) sq[i] = tone[i] * tone[i];
  boxBlur(sq, tmp, sqMean, gw, gh, radius);
  for (let i = 0; i < n; i++) {
    const m = thr[i];
    const sd = Math.sqrt(Math.max(0, sqMean[i] - m * m));
    const gate = smoothstep(0.04, 0.16, sd);
    thr[i] = clamp(lerp(theta, m, amount * gate), 0.02, 0.98);
  }
}
