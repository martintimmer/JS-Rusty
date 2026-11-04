import { lerp } from '../rendering/core.js';
import { dtResolveSettings } from '../rendering/dither/settings.js';
import { dtBlockAverage, dtSampleGrid, dtGammaTable, dtToneFill, dtAdaptiveThreshold } from '../rendering/dither/tone.js';
import { dtTemporalAdvance } from '../rendering/dither/temporal.js';
import { dtEdgeMap } from '../rendering/dither/edges.js';
import { dtSeedAccumulator } from '../rendering/dither/diffusion.js';
import { ditherAtkinson } from '../rendering/dither/atkinson.js';
import { ditherFloydSteinberg } from '../rendering/dither/floyd-steinberg.js';
import { ditherJarvisJudiceNinke } from '../rendering/dither/jarvis-judice-ninke.js';
import { ditherBayer } from '../rendering/dither/bayer.js';
import { ditherBlueNoise } from '../rendering/dither/blue-noise.js';

// Dither engine. The method is chosen by p.dtMethod (Atkinson is the default and the original look).
// Pipeline, per frame:
//   1. Source darkness on the dither lattice. Grid size (dtGrid) is the dither cell in canvas pixels:
//      even sizes average blocks of the analysis grid, and odd sizes (including 1 px) sample it.
//   2. Temporal stabilisation (optional, off by default): smooths small frame-to-frame changes.
//   3. Tone: invert, gamma, grain and gain (Density). The grain is re-rolled on every rendered frame.
//   4. Threshold: global (Threshold), or per cell when Adaptive threshold is above zero.
//   5. Edge map, for error diffusion with Edge preservation.
//   6. Quantise with the method: a tonal level, or a colour from the palette. The output is a palette
//      index per cell.
//   7. Paint: a colour table maps indices to pixels. The cells are written to a canvas the size of the
//      lattice, which is then scaled up once by drawImage with smoothing off. That is a nearest-neighbour
//      scale, so no per-pixel mapping runs in JavaScript.
// Every buffer is reused between frames (see dtSlot). Nothing is allocated per frame except a small
// settings object.

const DT_METHOD_FNS = {
  atkinson: ditherAtkinson,
  'floyd-steinberg': ditherFloydSteinberg,
  jjn: ditherJarvisJudiceNinke,
  bayer: ditherBayer,
  'blue-noise': ditherBlueNoise,
};

// True on little-endian hosts (virtually all), so a pixel can be written as one 32-bit value.
const DT_LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

// Returns state[key] as a typed array of the given length, reallocating only when the length changes.
function dtSlot(state, key, Type, len) {
  let a = state[key];
  if (!a || a.length !== len) {
    a = new Type(len);
    state[key] = a;
  }
  return a;
}

function dtDocumentCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function renderDither(rc) {
  const { grid, p, state } = rc;
  const opt = dtResolveSettings(p);
  const cellPx = opt.cellPx;
  // The dither lattice: one value per dither cell. It covers the whole canvas, so a 1 px cell is one
  // canvas pixel. For even sizes this equals the analysis grid divided by the block size.
  const gw = Math.ceil(rc.W / cellPx);
  const gh = Math.ceil(rc.H / cellPx);
  const n = gw * gh;

  // 1. Source darkness on the lattice. At 2 px the analysis grid is used as it is.
  let src = grid.ink;
  if (cellPx !== 2) {
    const dst = dtSlot(state, 'block', Float32Array, n);
    if (cellPx % 2 === 0) dtBlockAverage(grid.ink, grid.gw, grid.gh, cellPx / 2, dst, gw, gh);
    else dtSampleGrid(grid.ink, grid.gw, grid.gh, cellPx, dst, gw, gh);
    src = dst;
  }

  // 2. Output indices, and the temporal history when stabilisation is on.
  // Two index buffers are swapped each time the time advances, so the previous frame's levels are
  // available for hysteresis. Rendering the same time again (a parameter change while paused) keeps
  // the history as it was, so the result is the same as the first render.
  const temporal = opt.temporal > 0;
  let prev = null;
  let out;
  if (temporal) {
    const rawS = dtSlot(state, 'rawS', Float32Array, n);
    const idxA = dtSlot(state, 'idxA', Uint8Array, n);
    const idxB = dtSlot(state, 'idxB', Uint8Array, n);
    const fresh = !!rc.reset || !state.tOn || state.tN !== n;
    const same = !fresh && state.lastT === rc.t && state.lastK === rc.k;
    if (fresh) {
      rawS.set(src);
      idxB.fill(255);
      state.cur = idxA;
      state.prevIdx = idxB;
    } else if (!same) {
      dtTemporalAdvance(rawS, src, n, opt.temporal);
      const swap = state.prevIdx;
      state.prevIdx = state.cur;
      state.cur = swap;
    }
    state.tOn = true;
    state.tN = n;
    state.lastT = rc.t;
    state.lastK = rc.k;
    src = rawS;
    prev = state.prevIdx;
    out = state.cur;
  } else {
    state.tOn = false;
    out = dtSlot(state, 'out', Uint8Array, n);
  }

  // 3. Tone. The grain seed advances on every rendered frame, so the grain changes from frame to frame.
  let gammaLut = null;
  if (opt.gamma !== 1) {
    gammaLut = dtSlot(state, 'gammaLut', Float32Array, 256);
    if (state.gammaKey !== opt.gamma) {
      dtGammaTable(opt.gamma, gammaLut);
      state.gammaKey = opt.gamma;
    }
  }
  state.grainSeed = ((state.grainSeed || 0) + 1) | 0;
  const tone = dtSlot(state, 'tone', Float32Array, n);
  dtToneFill(src, n, opt, gammaLut, tone, state.grainSeed);

  // 4. Threshold. The radius is about 20 canvas pixels, so it scales with the cell size.
  let thr = null;
  if (opt.adaptive > 0) {
    thr = dtSlot(state, 'thr', Float32Array, n);
    dtAdaptiveThreshold(tone, gw, gh, Math.max(2, Math.round(20 / cellPx)), opt.adaptive, opt.threshold, thr,
      dtSlot(state, 'tmp', Float32Array, n),
      dtSlot(state, 'sq', Float32Array, n),
      dtSlot(state, 'sqMean', Float32Array, n));
  }

  // 5. Edges, for error diffusion only.
  let edge = null;
  if (opt.diffusion && opt.edge > 0) {
    edge = dtSlot(state, 'edge', Float32Array, n);
    dtEdgeMap(tone, gw, gh, edge);
  }

  // 6. Quantise.
  const env = state.env || (state.env = {});
  env.gw = gw;
  env.gh = gh;
  env.n = n;
  env.tone = tone;
  env.thr = thr;
  env.shift = 0.5 - opt.threshold;
  env.colours = opt.colours;
  env.maxLevel = opt.levels - 1;
  env.out = out;
  env.prev = prev;
  env.hyst = temporal ? 0.25 * opt.temporal : 0;
  env.serpentine = opt.serpentine;
  env.strength = opt.strength;
  env.edge = edge;
  env.edgeAmount = opt.edge;
  if (opt.diffusion) {
    env.acc = dtSlot(state, 'acc', Float32Array, opt.colours ? 3 * n : n);
    dtSeedAccumulator(env);
  }
  DT_METHOD_FNS[opt.method](env);

  // 7. Paint.
  dtPaintCells(rc, state, gw, gh, out, opt);
  rc.elements = n;
}

// Paints palette indices. The colour table has one entry per level (paper-and-ink ramp from paper to
// ink, or the palette). Pixels are packed as 32-bit values on the lattice canvas, which is then scaled
// up by drawImage with smoothing off.
function dtPaintCells(rc, state, cw, ch, idx, opt) {
  const ctx = rc.ctx;
  const levels = opt.levels;
  const colours = opt.colours;
  const packed = dtSlot(state, 'packed', Uint32Array, levels);
  for (let q = 0; q < levels; q++) {
    let r;
    let g;
    let b;
    if (colours) {
      r = Math.round(colours.rgb[3 * q] * 255);
      g = Math.round(colours.rgb[3 * q + 1] * 255);
      b = Math.round(colours.rgb[3 * q + 2] * 255);
    } else {
      const t = q / (levels - 1);
      r = Math.round(lerp(rc.pal.bg[0], rc.pal.stroke[0], t));
      g = Math.round(lerp(rc.pal.bg[1], rc.pal.stroke[1], t));
      b = Math.round(lerp(rc.pal.bg[2], rc.pal.stroke[2], t));
    }
    packed[q] = DT_LITTLE_ENDIAN
      ? (0xff000000 | (b << 16) | (g << 8) | r)
      : ((r << 24) | (g << 16) | (b << 8) | 0xff);
  }

  let cell = state.cell;
  if (!cell || cell.w !== cw || cell.h !== ch) {
    const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(cw, ch) : dtDocumentCanvas(cw, ch);
    const cellCtx = canvas.getContext('2d');
    const img = cellCtx.createImageData(cw, ch);
    cell = { w: cw, h: ch, canvas: canvas, ctx2d: cellCtx, img: img, px: new Uint32Array(img.data.buffer) };
    state.cell = cell;
  }
  const px = cell.px;
  const count = cw * ch;
  for (let i = 0; i < count; i++) px[i] = packed[idx[i]];
  cell.ctx2d.putImageData(cell.img, 0, 0);

  const smoothing = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(cell.canvas, 0, 0, cw, ch, 0, 0, rc.W, rc.H);
  ctx.imageSmoothingEnabled = smoothing;
}
