import {
  CANVAS_SCALE, GRID_CELL, normalizeParams, buildLut, resolvePalette,
  frameAt, buildGrid, buildColourGrid,
} from './core.js';
import { renderEngraving } from '../engines/engraving.js';
import { renderStippling } from '../engines/stippling.js';
import { renderContour } from '../engines/contour.js';
import { renderHalftone } from '../engines/halftone.js';
import { renderPencil } from '../engines/pencil.js';
import { renderWaves } from '../engines/waves.js';
import { renderContourDrawing } from '../engines/contour-drawing.js';
import { renderLowPoly } from '../engines/lowpoly.js';
import { renderDither } from '../engines/dither.js';
import { renderOil } from '../engines/oil.js';
import { renderLinocut } from '../engines/linocut.js';
import { renderAscii } from '../engines/ascii.js';
import { renderSort } from '../engines/sort.js';
import { applyMotionLayer, MOTION_TYPES } from './animation-layer.js';

// Artwork renderer: owns the canvas, the analysis grid and per-engine state.
// data = {
//   width, height   source-frame size in px (canvas is CANVAS_SCALE x this)
//   fps, duration   sampling rate and length in seconds
//   count           number of frames
//   frames          Array<Uint8Array> grayscale frames (width*height)
//   motion          null | { bs, bw, bh, vx: Int8Array, vy: Int8Array, diff: Uint8Array }
// }
// Every frame is drawn by the selected algorithm. An animation type (see MOTION_TYPES) is then
// laid over that output by the motion layer, so the algorithm keeps its look while it moves.

const ENGINES = {
  engraving: renderEngraving,
  stippling: renderStippling,
  contour: renderContour,
  halftone: renderHalftone,
  pencil: renderPencil,
  waves: renderWaves,
  'contour-drawing': renderContourDrawing,
  lowpoly: renderLowPoly,
  dither: renderDither,
  oil: renderOil,
  linocut: renderLinocut,
  ascii: renderAscii,
  sort: renderSort,
};

function pickEngine(p) {
  return ENGINES[p.algorithm] ? p.algorithm : 'engraving';
}

function hasMotion(p) {
  return MOTION_TYPES.indexOf(p.animation) >= 0;
}

export function createArtwork(canvas, data) {
  const W = data.width * CANVAS_SCALE;
  const H = data.height * CANVAS_SCALE;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  const gw = Math.ceil(data.width / GRID_CELL);
  const gh = Math.ceil(data.height / GRID_CELL);
  const grid = {
    gw: gw,
    gh: gh,
    lum: new Float32Array(gw * gh),
    ink: new Float32Array(gw * gh),
    tmp: new Float32Array(gw * gh),
    blur: new Float32Array(gw * gh),
  };
  // Colour planes (0-1 per channel) exist only when the source has colour. The Dither engine reads them in colour mode.
  if (data.colour) {
    grid.cr = new Float32Array(gw * gh);
    grid.cg = new Float32Array(gw * gh);
    grid.cb = new Float32Array(gw * gh);
  }

  // Per-engine state (buffers and positions) is created on first use. The motion layer has its own.
  const engineState = {};

  let params = normalizeParams({});
  let lut = buildLut(params);
  let pal = resolvePalette(params);
  let lastAlgorithm = null;

  function setParams(next) {
    const prev = params;
    params = normalizeParams(Object.assign({}, params, next));
    if (params.contrast !== prev.contrast || params.brightness !== prev.brightness) {
      lut = buildLut(params);
    }
    pal = resolvePalette(params);
  }

  function render(t, dt, opts) {
    const options = opts || {};
    const started = performance.now();
    const algo = pickEngine(params);
    if (!engineState[algo]) engineState[algo] = {};
    const reset = !!options.reset || lastAlgorithm !== algo;
    lastAlgorithm = algo;

    const f = frameAt(data, t || 0);
    buildGrid(data, params, lut, f.i0, f.i1, f.a, grid);
    // Colour is built only for the Dither engine in colour mode, so the other algorithms pay nothing for it.
    if (algo === 'dither' && params.grayscale === false && grid.cr) {
      buildColourGrid(data, params, lut, f.i0, f.i1, f.a, grid);
    }

    const rc = {
      ctx: ctx,
      W: W,
      H: H,
      grid: grid,
      p: params,
      pal: pal,
      data: data,
      k: f.i0,
      t: t || 0,
      dt: dt || 0,
      reset: reset,
      state: engineState[algo],
      elements: 0,
    };

    ENGINES[algo](rc);

    if (hasMotion(params)) {
      if (!engineState.motion) engineState.motion = {};
      applyMotionLayer(rc, params.animation, engineState.motion);
    }

    return {
      ms: performance.now() - started,
      elements: rc.elements,
      lattice: rc.lattice || null,
    };
  }

  return {
    canvas: canvas,
    data: data,
    get params() { return params; },
    setParams: setParams,
    render: render,
  };
}
