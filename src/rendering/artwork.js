import {
  CANVAS_SCALE, GRID_CELL, normalizeParams, buildLut, resolvePalette,
  frameAt, buildGrid, buildColourGrid, clamp, animationSpeed,
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
import { applyHalation, applyAberration, createOpticsState } from './optics.js';
import {
  MOTION_TYPES, MOTION_ECHO_LAG, createMotionState, motionTime, motionFrequency, mfIsNative, mfWarpGrid, mfCentre,
  mfEcho,
} from './motion-field.js';

// Artwork renderer: owns the canvas, the analysis grids and per-engine state.
// data = {
//   width, height   source-frame size in px (canvas is CANVAS_SCALE x this)
//   fps, duration   sampling rate and length in seconds
//   count           number of frames
//   frames          Array<Uint8Array> grayscale frames (width*height)
//   colour          optional colour frames (for the Dither engine's colour mode)
//   motion          null | { bs, bw, bh, vx: Int8Array, vy: Int8Array, diff: Uint8Array }
// }
// Two grids. The base grid is the picture's tone as the engines read it. A still has one frame, so its base grid
// is built once for each setting that changes it. An animation type never writes into the base grid: it moves a copy
// (see motion-field.js), and the engine reads that copy. The engine then draws the frame again, so its own marks move.

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

function pickMotion(p) {
  return MOTION_TYPES.indexOf(p.animation) >= 0 ? p.animation : null;
}

export function createArtwork(canvas, data) {
  const W = data.width * CANVAS_SCALE;
  const H = data.height * CANVAS_SCALE;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  const gw = Math.ceil(data.width / GRID_CELL);
  const gh = Math.ceil(data.height / GRID_CELL);
  const base = {
    gw: gw,
    gh: gh,
    lum: new Float32Array(gw * gh),
    ink: new Float32Array(gw * gh),
    tmp: new Float32Array(gw * gh),
    blur: new Float32Array(gw * gh),
    version: 0, // counts the builds, so cached fields know when they are stale
  };
  // Colour planes (0-1 per channel) exist only when the source has colour. The Dither engine reads them in colour mode.
  if (data.colour) {
    base.cr = new Float32Array(gw * gh);
    base.cg = new Float32Array(gw * gh);
    base.cb = new Float32Array(gw * gh);
  }
  let baseKey = null;
  // Optics (halation and chromatic aberration) keep their buffers here.
  const opticsState = createOpticsState();

  // Per-engine state (buffers and positions) is created on first use. The motion state has its own.
  const engineState = {};
  const motionState = createMotionState();
  // The Trail's ghost is warped separately, so the main warp and the ghost do not share buffers.
  const echoState = createMotionState();

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

  // t: time in seconds (video clock, or the still's clock). dt: time since the last frame, 0 when nothing moves.
  // opts.reset: start the motion again. opts.loop: loop length in seconds (0 = none); when set, every motion term
  // depends only on t, so an exported loop closes.
  function render(t, dt, opts) {
    const options = opts || {};
    const started = performance.now();
    const algo = pickEngine(params);
    if (!engineState[algo]) engineState[algo] = {};
    const reset = !!options.reset || lastAlgorithm !== algo;
    lastAlgorithm = algo;
    const loop = options.loop > 0 ? options.loop : 0;

    const f = frameAt(data, t || 0);
    const type = pickMotion(params);
    // Colour is built only for the Dither engine in colour mode and for the Low poly Mosaic, so the other algorithms
    // pay nothing for it.
    const colour = (algo === 'dither' || (algo === 'lowpoly' && type === 'mosaic')) &&
      params.grayscale === false && !!base.cr;
    const key = [params.detail, params.edge, params.contrast, params.brightness, params.saturation, colour].join('|');
    if (data.count > 1 || key !== baseKey) {
      buildGrid(data, params, lut, f.i0, f.i1, f.a, base);
      if (colour) buildColourGrid(data, params, lut, f.i0, f.i1, f.a, base);
      base.version++;
      baseKey = key;
    }

    let grid = base;
    let motion = null;
    if (type) {
      const speed = animationSpeed(params.speed);
      const time = motionTime(motionState, t, dt, speed, reset, loop);
      motion = {
        type: type,
        native: mfIsNative(algo, type, params.pattern),
        // Depth (Velocity) scales Pulse, Hover and Ripple. Snake has no depth control, so it always runs at full depth.
        amount: type === 'snake' ? 1 : clamp(params.velocity, 0, 3),
        influence: clamp(params.motion, 0, 3),
        share: clamp(params.animCount, 0, 100) / 100,
        direction: params.direction || 0,
        scale: W / 1920,
        time: time,
        freq: (cycles) => motionFrequency(cycles, speed, loop),
        centre: type === 'pulse' ? mfCentre(motionState, base, W, H) : null,
        // Dither's Pulse is a threshold wave in the tone the dither reads (see motion-field.js).
        toneWave: algo === 'dither' && type === 'pulse',
      };
      grid = mfWarpGrid(motionState, base, motion, W, H, data, f.i0);
      // Trail (stills only): the tone of a moment ago, darker wins, so the picture leaves its own marks behind.
      const trail = clamp(params.trail, 0, 100) / 100;
      if (trail > 0 && speed > 0 && data.count === 1 && grid !== base) {
        const lagged = Object.assign({}, motion, { time: motion.time - MOTION_ECHO_LAG });
        mfEcho(grid, mfWarpGrid(echoState, base, lagged, W, H, data, f.i0), trail);
      }
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
      motion: motion,
    };

    ENGINES[algo](rc);

    // Optics, after the engine: the preview, the exports and the recordings all carry them. A strength of 0 is off.
    if (params.halation > 0) applyHalation(ctx, W, H, opticsState, params.halation, params.halationSize, W / 1920);
    if (params.aberration > 0) applyAberration(ctx, W, H, opticsState, params.aberration);

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
