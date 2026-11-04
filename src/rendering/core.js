import { dtResolveColourSet, dtPaletteInk } from './dither/palettes.js';
// Shared rendering primitives.
// This file is imported as an ES module by the app AND concatenated into the
// standalone JavaScript export. Keep import/export statements single-line or
// multi-line `import ... from` and top-level `export` so the exporter can strip them
// (see src/export/javascript-exporter.js).

export const DEFAULT_PARAMS = {
  algorithm: 'dither',
  animation: 'off',
  detail: 70,
  density: 75,
  contrast: 1,
  brightness: 0,
  edge: 0.5,
  pattern: 'horizontal',
  particles: 40000,
  animCount: 400,
  speed: 1,
  motion: 1,
  direction: 0,
  velocity: 1,
  thickness: 1,
  cdLevels: 12,
  cdSmooth: 40,
  cdTaper: 60,
  cdToneWeight: 50,
  cdShade: 30,
  cdJitter: 20,
  cdMinLen: 20,
  cdBreaks: 0,
  cdHatch: 0,
  cdHatchAngle: 45,
  cdHatchSpacing: 8,
  lpJitter: 35,
  lpShades: 10,
  lpBias: 60,
  lpGap: 10,
  lpOutline: 0,
  palette: 'sepia',
  background: 'paper',
  // Colour for the Dither engine (with a palette). Grayscale on keeps the original tone-mapped look.
  dtSeed: 1,                 // random threshold pattern, 1-99: the same seed always gives the same scatter
  saturation: 100,           // colour strength, 0-200 (100 = as photographed)
  grayscale: true,           // true: palettes follow tone. false: palette colours follow the photo's colour
  // Dither engine (src/rendering/dither). These defaults reproduce the original Atkinson, two-tone output.
  dtMethod: 'atkinson',      // atkinson | floyd-steinberg | jjn | bayer | bayer4 | random | blue-noise | none
  dtLevels: 2,               // tonal levels of the paper-and-ink ramp: 2, 3, 4, 8 or 16
  dtPalette: 'pico-8',    // paper-ink (uses palette and background), a named colour set, or custom (dtColours)
  dtColours: '',             // custom colour list: 2 to 16 hex colours
  dtSerpentine: false,       // alternate the scan direction on each row (error diffusion only)
  dtThreshold: 50,           // global threshold, 0-100 (50 = midpoint)
  dtAdaptive: 0,             // adaptive threshold strength, 0-100 (0 = global threshold only)
  dtEdge: 0,                 // edge preservation, 0-100: damps diffusion across strong edges (error diffusion only)
  dtGamma: 1,                // midtone gamma of the tone (1 = unchanged)
  dtNoise: 0,                // grain added to the tone, 0-100; re-rolled on every rendered frame
  dtInvert: false,           // swap light and dark before dithering
  dtGrid: 2,                 // dither cell size in canvas pixels, 1-16 (2 = one analysis cell)
  dtDiffusion: 100,          // diffusion strength, 0-100 (100 = full kernel; error diffusion only)
  dtTemporal: 0,             // temporal stability, 0-100 (0 = off)
};

const NUMERIC_KEYS = ['detail', 'density', 'contrast', 'brightness', 'edge', 'particles', 'animCount','speed', 'motion', 'direction', 'velocity', 'thickness', 'cdLevels', 'cdSmooth', 'cdTaper', 'cdToneWeight', 'cdShade', 'cdJitter', 'cdMinLen', 'cdBreaks', 'cdHatch', 'cdHatchAngle', 'cdHatchSpacing', 'lpJitter', 'lpShades', 'lpBias', 'lpGap', 'lpOutline', 'dtLevels', 'dtThreshold', 'dtAdaptive', 'dtEdge', 'dtGamma', 'dtNoise', 'dtGrid', 'dtDiffusion', 'dtTemporal', 'saturation', 'dtSeed'];

// Canvas pixels per source-frame pixel. 1 = the canvas matches the processing
// resolution exactly (1920x1080 at 1080p).
export const CANVAS_SCALE = 1;
// Source-frame pixels per analysis grid cell.
export const GRID_CELL = 2;
// Canvas pixels per analysis grid cell.
export const CELL_PX = GRID_CELL * CANVAS_SCALE;
// Upper bound for stipple dots / particles (per frame).
export const MAX_ELEMENTS = 80000;

const PALETTES = {
  monochrome: { paper: [244, 241, 234], ink: [22, 21, 19], light: [236, 233, 226] },
  sepia: { paper: [239, 231, 207], ink: [58, 53, 42], light: [240, 226, 196] },
};
const INK_BACKGROUND = [28, 27, 25];

export function normalizeParams(input) {
  const out = Object.assign({}, DEFAULT_PARAMS, input || {});
  for (let i = 0; i < NUMERIC_KEYS.length; i++) {
    const k = NUMERIC_KEYS[i];
    const v = Number(out[k]);
    out[k] = Number.isFinite(v) ? v : DEFAULT_PARAMS[k];
  }
  return out;
}

// Golden-ratio low-discrepancy constants and fractional part (shared by the dot engines).
export const PHI = 0.6180339887498949;
export const PHI2 = 0.7548776662466927;
export const PHI3 = 0.5698402909980532;

export function frac(x) {
  return x - Math.floor(x);
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Smoothstep between edges a and b.
export function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

function rgbCss(c) {
  return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
}

// Paper and ink for the engines. A palette from the library supplies its lightest colour as paper and its
// darkest as ink, so every algorithm takes the palette. Without one, the Palette and Background settings apply.
export function resolvePalette(p) {
  const set = p.dtPalette && p.dtPalette !== 'paper-ink' ? dtResolveColourSet(p.dtPalette, p.dtColours) : null;
  if (set) {
    const ends = dtPaletteInk(set);
    return { bg: ends.paper, stroke: ends.ink, bgCss: rgbCss(ends.paper), strokeCss: rgbCss(ends.ink) };
  }
  const pal = PALETTES[p.palette] || PALETTES.monochrome;
  const inkBg = p.background === 'ink';
  const bg = inkBg ? INK_BACKGROUND : pal.paper;
  const stroke = inkBg ? pal.light : pal.ink;
  return { bg: bg, stroke: stroke, bgCss: rgbCss(bg), strokeCss: rgbCss(stroke) };
}

// Maps an 8-bit gray value through contrast and brightness (0..255 output).
export function buildLut(p) {
  const lut = new Float32Array(256);
  const c = p.contrast;
  const b = p.brightness * 2.55;
  for (let v = 0; v < 256; v++) {
    lut[v] = clamp((v - 128) * c + 128 + b, 0, 255);
  }
  return lut;
}

// Maps time (seconds) to a pair of source frames and a blend factor.
export function frameAt(data, t) {
  const n = data.count;
  if (n <= 1) return { i0: 0, i1: 0, a: 0 };
  let f = t * data.fps;
  if (f < 0) f = 0;
  if (f > n - 1) f = n - 1;
  const i0 = Math.min(n - 2, Math.floor(f));
  return { i0: i0, i1: i0 + 1, a: f - i0 };
}

// Separable Gaussian blur of a Float32Array grid, in place. tmp must be the same length.
export function blurGrid(buf, tmp, gw, gh, sigma) {
  if (sigma < 0.25) return;
  const r = Math.min(6, Math.ceil(sigma * 2.5));
  const kernel = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + r] = w;
    sum += w;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;

  // Horizontal pass: buf -> tmp
  for (let y = 0; y < gh; y++) {
    const row = y * gw;
    for (let x = 0; x < gw; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        let xx = x + i;
        if (xx < 0) xx = 0; else if (xx >= gw) xx = gw - 1;
        acc += buf[row + xx] * kernel[i + r];
      }
      tmp[row + x] = acc;
    }
  }
  // Vertical pass: tmp -> buf
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        let yy = y + i;
        if (yy < 0) yy = 0; else if (yy >= gh) yy = gh - 1;
        acc += tmp[yy * gw + x] * kernel[i + r];
      }
      buf[y * gw + x] = acc;
    }
  }
}

// Fills grid.lum (contrast-adjusted, denoised luminance 0..255) and grid.ink
// (darkness plus weighted edge strength, 0..1) for the current time.
// Higher detail means less smoothing, so fine structure survives.
export function buildGrid(data, p, lut, i0, i1, a, grid) {
  const W = data.width;
  const H = data.height;
  const gw = grid.gw;
  const gh = grid.gh;
  const g0 = data.frames[i0];
  const g1 = data.frames[i1];
  const lum = grid.lum;
  const ink = grid.ink;
  const blend = a > 0 && i1 !== i0;

  for (let gy = 0; gy < gh; gy++) {
    const sy = Math.min(H - 1, gy * GRID_CELL + 1);
    for (let gx = 0; gx < gw; gx++) {
      const sx = Math.min(W - 1, gx * GRID_CELL + 1);
      const idx = sy * W + sx;
      const l0 = lut[g0[idx]];
      lum[gy * gw + gx] = blend ? l0 + (lut[g1[idx]] - l0) * a : l0;
    }
  }

  // Denoise: sigma shrinks as detail rises (in grid cells; 1 cell = 2 source px).
  const sigma = lerp(2.2, 0.45, clamp(p.detail, 0, 100) / 100);
  blurGrid(lum, grid.tmp, gw, gh, sigma);

  // Darkness per cell, then a local-contrast halo: darkness minus a wide local average.
  // Dark subjects get a heavier outline and a lighter margin on the paper around them,
  // the white-outline look of classic engravings. Flat areas are unchanged.
  const n = gw * gh;
  for (let i = 0; i < n; i++) ink[i] = 1 - lum[i] / 255;
  const halo = clamp(p.edge, 0, 2);
  if (halo > 0) {
    boxBlur(ink, grid.tmp, grid.blur, gw, gh, 5);
    const avg = grid.blur;
    for (let i = 0; i < n; i++) {
      ink[i] = clamp(ink[i] + halo * (ink[i] - avg[i]), 0, 1);
    }
  }
}

export function clampIndex(i, n) {
  return i < 0 ? 0 : (i >= n ? n - 1 : i);
}

// Separable box blur with running sums (two passes, cost independent of radius).
// Reads src, uses tmp as scratch, writes out. Edges are clamped.
export function boxBlur(src, tmp, out, gw, gh, r) {
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < gh; y++) {
    const row = y * gw;
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += src[row + clampIndex(i, gw)];
    for (let x = 0; x < gw; x++) {
      tmp[row + x] = sum * inv;
      sum += src[row + clampIndex(x + r + 1, gw)] - src[row + clampIndex(x - r, gw)];
    }
  }
  for (let x = 0; x < gw; x++) {
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += tmp[clampIndex(i, gh) * gw + x];
    for (let y = 0; y < gh; y++) {
      out[y * gw + x] = sum * inv;
      sum += tmp[clampIndex(y + r + 1, gh) * gw + x] - tmp[clampIndex(y - r, gh) * gw + x];
    }
  }
}

// Fills grid.cr, grid.cg and grid.cb (0-1 per channel) with the photo's colour on the analysis grid, after
// contrast and brightness (the same lookup table as the tone) and saturation. Used by the Dither engine's colour
// mode only. Saturation 0 is grey, 100 is the photograph as it is, and 200 doubles the colour.
export function buildColourGrid(data, p, lut, i0, i1, a, grid) {
  const c0 = data.colour[i0];
  const c1 = data.colour[i1];
  const n = grid.gw * grid.gh;
  const blend = a > 0 && i1 !== i0;
  const s = clamp(p.saturation, 0, 200) / 100;
  for (let i = 0; i < n; i++) {
    const j = 3 * i;
    let r = lut[c0[j]];
    let g = lut[c0[j + 1]];
    let b = lut[c0[j + 2]];
    if (blend) {
      r += (lut[c1[j]] - r) * a;
      g += (lut[c1[j + 1]] - g) * a;
      b += (lut[c1[j + 2]] - b) * a;
    }
    const L = (77 * r + 150 * g + 29 * b) / 256;
    grid.cr[i] = clamp(L + s * (r - L), 0, 255) / 255;
    grid.cg[i] = clamp(L + s * (g - L), 0, 255) / 255;
    grid.cb[i] = clamp(L + s * (b - L), 0, 255) / 255;
  }
}

// Bilinear sample of grid.ink at canvas point (cx, cy).
export function sampleInk(grid, cx, cy) {
  const gw = grid.gw;
  const gh = grid.gh;
  let fx = cx / CELL_PX - 0.5;
  let fy = cy / CELL_PX - 0.5;
  if (fx < 0) fx = 0; else if (fx > gw - 1) fx = gw - 1;
  if (fy < 0) fy = 0; else if (fy > gh - 1) fy = gh - 1;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = x0 < gw - 1 ? x0 + 1 : x0;
  const y1 = y0 < gh - 1 ? y0 + 1 : y0;
  const tx = fx - x0;
  const ty = fy - y0;
  const ink = grid.ink;
  const top = ink[y0 * gw + x0] * (1 - tx) + ink[y0 * gw + x1] * tx;
  const bottom = ink[y1 * gw + x0] * (1 - tx) + ink[y1 * gw + x1] * tx;
  return top * (1 - ty) + bottom * ty;
}

// Reads the motion block that covers source-frame point (fx, fy) for transition k
// (frame k -> k + 1). Writes [vx, vy, diff] into out. vx/vy in source px per frame,
// diff in 0..1 (mean absolute frame difference of the block).
export function sampleMotion(data, k, fx, fy, out) {
  const m = data.motion;
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  if (!m || k < 0 || k >= data.count - 1) return out;
  let bx = Math.floor(fx / m.bs);
  let by = Math.floor(fy / m.bs);
  if (bx < 0) bx = 0; else if (bx >= m.bw) bx = m.bw - 1;
  if (by < 0) by = 0; else if (by >= m.bh) by = m.bh - 1;
  const idx = (k * m.bh + by) * m.bw + bx;
  out[0] = m.vx[idx] / 4;
  out[1] = m.vy[idx] / 4;
  out[2] = m.diff[idx] / 255;
  return out;
}

// Deterministic xorshift PRNG stored in a state object.
export function nextRandom(state) {
  let s = state.seed;
  s ^= s << 13;
  s ^= s >>> 17;
  s ^= s << 5;
  state.seed = s;
  return (s >>> 0) / 4294967296;
}

// Builds a cumulative distribution over grid cells (weights = ink^gamma).
// Returns total weight. cdf must be a Float64Array of length gw*gh.
export function buildCdf(grid, gamma, cdf) {
  const ink = grid.ink;
  const n = ink.length;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const v = ink[i];
    const w = gamma === 1 ? v : Math.pow(v, gamma);
    total += w + 0.0005;
    cdf[i] = total;
  }
  return total;
}

// Returns the cell index whose cumulative weight covers target (0..total).
export function cdfLookup(cdf, n, target) {
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] < target) lo = mid + 1; else hi = mid;
  }
  return lo;
}
