import { lerp } from '../rendering/core.js';
import { dtResolveSettings } from '../rendering/dither/settings.js';
import { dtBlockAverage, dtSampleGrid, dtGammaTable, dtToneFill, dtColourFill, dtAdaptiveThreshold } from '../rendering/dither/tone.js';
import { dtTemporalAdvance } from '../rendering/dither/temporal.js';
import { dtEdgeMap } from '../rendering/dither/edges.js';
import { dtSeedAccumulator } from '../rendering/dither/diffusion.js';
import { ditherAtkinson } from '../rendering/dither/atkinson.js';
import { ditherFloydSteinberg } from '../rendering/dither/floyd-steinberg.js';
import { ditherJarvisJudiceNinke } from '../rendering/dither/jarvis-judice-ninke.js';
import { ditherBayer, ditherBayer4 } from '../rendering/dither/bayer.js';
import { ditherRandom } from '../rendering/dither/random-threshold.js';
import { ditherBlueNoise } from '../rendering/dither/blue-noise.js';
import { ditherNone } from '../rendering/dither/direct.js';

// Dither engine. The method is chosen by p.dtMethod (Atkinson is the default and the original look).
// Pipeline, per frame:
//   1. Source on the dither lattice. Grid size (dtGrid) is the dither cell in canvas pixels: even sizes
//      average blocks of the analysis grid, and odd sizes (including 1 px) sample it. In colour mode the
//      three colour planes are sampled the same way.
//   2. Temporal stabilisation (optional, off by default): smooths small frame-to-frame changes, per plane.
//   3. Tone: invert, gamma, grain and gain (Density). The grain is re-rolled on every rendered frame. In colour
//      mode the same steps are applied to each channel, and the tone is the resulting luminance.
//   4. Threshold: global (Threshold), or per cell when Adaptive threshold is above zero. In colour mode the
//      threshold moves each channel's target by the same amount.
//   5. Edge map, for error diffusion with Edge preservation.
//   6. Quantise with the method: a tonal level, or a colour from the palette. The output is a palette
//      index per cell. Colour mode chooses the palette colour nearest to the photo.
//   7. Paint: a colour table maps indices to pixels. The cells are written to a canvas the size of the
//      lattice, which is then scaled up once by drawImage with smoothing off.
// Every buffer is reused between frames (see dtSlot). Nothing is allocated per frame except small objects.

const DT_METHOD_FNS = {
  atkinson: ditherAtkinson,
  'floyd-steinberg': ditherFloydSteinberg,
  jjn: ditherJarvisJudiceNinke,
  bayer: ditherBayer,
  bayer4: ditherBayer4,
  random: ditherRandom,
  'blue-noise': ditherBlueNoise,
  none: ditherNone,
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

// The colour of each level (or palette index) as bytes r, g, b: levels * 3 values. Shared by the painter and the
// standalone export, so an exported dither looks the same as the canvas.
export function dtPaletteTable(opt, pal) {
  const levels = opt.levels;
  const colours = opt.colours;
  const table = new Uint8Array(levels * 3);
  for (let q = 0; q < levels; q++) {
    for (let c = 0; c < 3; c++) {
      const v = colours
        ? colours.rgb[3 * q + c] * 255
        : lerp(pal.bg[c], pal.stroke[c], q / (levels - 1));
      table[3 * q + c] = Math.round(v);
    }
  }
  return table;
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
  // Colour mode: palette colours follow the photo's colour. It needs a palette and Grayscale turned off.
  const colour = opt.colourMode && !!grid.cr;

  // 1. Source on the lattice. At 2 px the analysis grid is used as it is.
  const onLattice = (src, key) => {
    if (cellPx === 2) return src;
    const dst = dtSlot(state, key, Float32Array, n);
    if (cellPx % 2 === 0) dtBlockAverage(src, grid.gw, grid.gh, cellPx / 2, dst, gw, gh);
    else dtSampleGrid(src, grid.gw, grid.gh, cellPx, dst, gw, gh);
    return dst;
  };
  let planes = colour
    ? [onLattice(grid.cr, 'colR'), onLattice(grid.cg, 'colG'), onLattice(grid.cb, 'colB')]
    : [onLattice(grid.ink, 'block')];

  // 2. Output indices, and the temporal history when stabilisation is on. Two index buffers are swapped each
  // time the time advances, so the previous frame's levels are available for hysteresis. Rendering the same
  // time again (a parameter change while paused) keeps the history as it was.
  const temporal = opt.temporal > 0;
  let prev = null;
  let out;
  if (temporal) {
    const idxA = dtSlot(state, 'idxA', Uint8Array, n);
    const idxB = dtSlot(state, 'idxB', Uint8Array, n);
    const fresh = !!rc.reset || !state.tOn || state.tN !== n || state.tColour !== colour;
    const same = !fresh && state.lastT === rc.t && state.lastK === rc.k;
    if (fresh) {
      idxB.fill(255);
      state.cur = idxA;
      state.prevIdx = idxB;
    } else if (!same) {
      const swap = state.prevIdx;
      state.prevIdx = state.cur;
      state.cur = swap;
    }
    planes = planes.map((plane, c) => {
      const raw = dtSlot(state, 'raw' + c, Float32Array, n);
      if (fresh) raw.set(plane);
      else if (!same) dtTemporalAdvance(raw, plane, n, opt.temporal);
      return raw;
    });
    state.tOn = true;
    state.tN = n;
    state.tColour = colour;
    state.lastT = rc.t;
    state.lastK = rc.k;
    prev = state.prevIdx;
    out = state.cur;
  } else {
    state.tOn = false;
    out = dtSlot(state, 'out', Uint8Array, n);
  }

  // 3. Tone. Gamma is a table over darkness. The grain seed advances on every rendered frame, so the grain moves.
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
  let light = null;
  if (colour) {
    light = [
      dtSlot(state, 'lightR', Float32Array, n),
      dtSlot(state, 'lightG', Float32Array, n),
      dtSlot(state, 'lightB', Float32Array, n),
    ];
    dtColourFill(planes[0], planes[1], planes[2], n, opt, gammaLut, state.grainSeed, light[0], light[1], light[2]);
    // The tone of a colour is its luminance, so the threshold and edge steps work as they do in tone mode.
    for (let i = 0; i < n; i++) {
      tone[i] = 1 - (54 * light[0][i] + 183 * light[1][i] + 19 * light[2][i]) / 256;
    }
  } else {
    dtToneFill(planes[0], n, opt, gammaLut, tone, state.grainSeed);
  }

  // 4. Threshold. The radius is about 20 canvas pixels, so it scales with the cell size.
  let thr = null;
  if (opt.adaptive > 0) {
    thr = dtSlot(state, 'thr', Float32Array, n);
    dtAdaptiveThreshold(tone, gw, gh, Math.max(2, Math.round(20 / cellPx)), opt.adaptive, opt.threshold, thr,
      dtSlot(state, 'tmp', Float32Array, n),
      dtSlot(state, 'sq', Float32Array, n),
      dtSlot(state, 'sqMean', Float32Array, n));
  }
  // Colour mode: the threshold moves each channel's target by the amount it moves the tone.
  if (colour) {
    for (let i = 0; i < n; i++) {
      const off = thr ? thr[i] - 0.5 : opt.threshold - 0.5;
      light[0][i] += off;
      light[1][i] += off;
      light[2][i] += off;
    }
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
  env.seed = opt.seed;
  env.edge = edge;
  env.edgeAmount = opt.edge;
  env.lr = light ? light[0] : null;
  env.lg = light ? light[1] : null;
  env.lb = light ? light[2] : null;
  if (opt.diffusion || colour) env.acc = dtSlot(state, 'acc', Float32Array, opt.colours ? 3 * n : n);
  if (opt.diffusion) dtSeedAccumulator(env);
  DT_METHOD_FNS[opt.method](env);
  // The index buffer is reused, so a caller that keeps it (the standalone export) copies it straight after the call.
  rc.lattice = { gw: gw, gh: gh, levels: opt.levels, index: out };

  // 7. Paint.
  dtPaintCells(rc, state, gw, gh, out, opt);
  rc.elements = n;
}

// Paints palette indices. Pixels are packed as 32-bit values on the lattice canvas, which is then scaled up by
// drawImage with smoothing off.
function dtPaintCells(rc, state, cw, ch, idx, opt) {
  const ctx = rc.ctx;
  const levels = opt.levels;
  const table = dtPaletteTable(opt, rc.pal);
  const packed = dtSlot(state, 'packed', Uint32Array, levels);
  for (let q = 0; q < levels; q++) {
    const r = table[3 * q];
    const g = table[3 * q + 1];
    const b = table[3 * q + 2];
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
