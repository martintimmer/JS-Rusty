import { clamp, frac, sampleMotion, CANVAS_SCALE, CELL_PX, STILL_LOOP_SECONDS } from './core.js';

// Motion for the four animation types. Each type changes the algorithm's inputs over time, and the algorithm draws
// the frame again. Nothing is laid over the finished picture.
//   L0  The analysis grid, which is the tone every engine reads, is moved before the engine runs. Pulse, Hover and
//       Ripple displace it smoothly, so the engine redraws its own marks from the moved tone: lines stay crisp and no
//       pixel is resampled. Snake, on an engine without strokes of its own, is a darkness bead that runs along each
//       row of the grid.
//   L1  An engine that draws its own strokes or points moves them itself (MF_NATIVE): engraving lines bob and carry
//       a snake bead, contours sweep their levels and carry a bead, ridges travel, dots float and rings swell.
//   L2  The still decides where and how strong. The outline of the darkest subject sets where the wave fronts start
//       (a distance field), and its ink centroid sets the centre of the rings.
// Time. Each term runs a whole number of cycles per loop (MOTION_BASE at the default speed). A still's loop is
// STILL_LOOP_SECONDS divided by the speed (see stillLoopSeconds), so an exported loop (GIF, recording) closes exactly.
// Video and live play run on accumulated time, so the speed can change at any moment without a jump.
// Names here are shared with the standalone export (see javascript-exporter.js), so they all start with mf or MOTION_.

export const MOTION_TYPES = ['snake', 'pulse', 'hover', 'ripple', 'mosaic'];

// Cycles per loop at Speed 1 for each term that moves something.
export const MOTION_BASE = { pulse: 2, hover: 2, ripple: 1, mosaic: 2 };

// Trail looks this far back (seconds of motion time) for the picture a moment ago.
export const MOTION_ECHO_LAG = 0.4;

// Engines that draw a type on their own strokes or points (L1). Any other engine takes the type through the grid (L0).
// Dither's Pulse is a threshold wave in the tone it reads, and Pencil's Snake is a bead of graphite along a streamline.
const MF_NATIVE = {
  engraving: ['hover', 'snake'],
  contour: ['pulse', 'snake'],
  stippling: ['hover'],
  halftone: ['pulse', 'hover'],
  waves: ['ripple', 'snake'],
  sort: ['pulse'],
  dither: ['pulse'],
  pencil: ['snake'],
  lowpoly: ['mosaic'],
};

const mfScratch = new Float32Array(3);

const MF_NODE = 8; // px between displacement nodes (at 1080p)
const MF_TAIL = 0.1; // grid snake tail, as a share of the grid width

// Hash in [0, 1) of any number.
export function mfHash(n) {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}

// Smooth value noise in [0, 1) with lattice spacing `cell` (px).
function mfNoise(x, y, cell) {
  const gx = x / cell;
  const gy = y / cell;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  const fx = gx - ix;
  const fy = gy - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const top = mfHash(ix * 57.31 + iy * 113.7) * (1 - sx) + mfHash((ix + 1) * 57.31 + iy * 113.7) * sx;
  const bottom = mfHash(ix * 57.31 + (iy + 1) * 113.7) * (1 - sx) + mfHash((ix + 1) * 57.31 + (iy + 1) * 113.7) * sx;
  return top * (1 - sy) + bottom * sy;
}

// Triangle wave in [0, 1]: 0 at x = 0, 1 at x = 0.5, 0 again at x = 1.
export function mfTriangle(x) {
  return 1 - Math.abs(2 * frac(x) - 1);
}

// Frequency in cycles per second of a term. `base` is its cycles per loop at the default speed (multiplier 1), and
// `speed` is the multiplier from animationSpeed. In a loop the cycles are whole numbers, so the term closes at the end
// of the loop. Live (loop = 0) the clock already carries the speed (see motionTime), so the rate is the base alone.
export function motionFrequency(base, speed, loop) {
  if (loop > 0) {
    if (!(speed > 0)) return 0;
    return Math.max(1, Math.round((speed * base * loop) / STILL_LOOP_SECONDS)) / loop;
  }
  return base / STILL_LOOP_SECONDS;
}

export function createMotionState() {
  return {
    clock: 0, // live motion time in seconds, at Speed 1 (it advances with Speed, so changing Speed does not jump)
    warped: null, // the moved grid, with the same planes as the base grid
    nodes: null, // displacement at the nodes of the L0 field
    centre: null, // darkest mass, cached per grid version
    outline: null, // distance to the outline, cached per grid version
    mv: null,
  };
}

// The motion time that every term reads. In a loop it is the loop time itself, so a frame depends only on t. Live it
// advances with dt at Speed, and starts again from 0 on reset.
export function motionTime(state, t, dt, speed, reset, loop) {
  if (loop > 0) return t || 0;
  if (reset) state.clock = 0;
  if (dt > 0 && speed > 0) state.clock += dt * speed;
  return state.clock;
}

// Whether an engine draws `type` itself. Engraving moves its lines only when they are horizontal; its diagonal and
// crosshatch patterns take the type through the grid.
export function mfIsNative(algorithm, type, pattern) {
  const list = MF_NATIVE[algorithm];
  if (!list || list.indexOf(type) < 0) return false;
  if (algorithm === 'engraving') return pattern === 'horizontal';
  return true;
}

// True when the engine should draw `type` itself this frame.
export function mfActive(rc, type) {
  const m = rc.motion;
  return !!m && m.native && m.type === type && m.amount > 0;
}

// Thickening of a snake's bead at canvas point (x, y): 1 on a still. On video, the bead swells where the picture
// moves, by Motion influence.
export function mfSwell(rc, x, y) {
  const m = rc.motion;
  if (!m || !(m.influence > 0) || !rc.data || !rc.data.motion) return 1;
  sampleMotion(rc.data, rc.k, x / CANVAS_SCALE, y / CANVAS_SCALE, mfScratch);
  return 1 + Math.min(1.5, mfScratch[2] * 8 * m.influence);
}

// Trail: the picture now and the picture a moment ago, darker wins. `trail` (0..1) fades the ghost. The ghost is the
// same algorithm's tone at an earlier motion time, so the marks it leaves are the engine's own.
export function mfEcho(main, ghost, trail) {
  const ink = main.ink;
  const lum = main.lum;
  const gInk = ghost.ink;
  const gLum = ghost.lum;
  for (let i = 0; i < ink.length; i++) {
    const g = trail * gInk[i];
    if (g > ink[i]) ink[i] = g;
    const l = 255 - trail * (255 - gLum[i]);
    if (l < lum[i]) lum[i] = l;
  }
}

// The snake of stroke `id`: -1 when the stroke carries none, otherwise the position of its head as a fraction of the
// stroke (0 at its start). A snake runs one or two laps per loop, so it closes with the loop.
export function mfSnake(motion, id) {
  if (mfHash(id * 2.9 + 0.5) >= motion.share) return -1;
  const laps = 1 + Math.floor(mfHash(id * 0.53 + 0.9) * 2);
  return frac(motion.freq(laps) * motion.time + mfHash(id * 1.37 + 0.11));
}

// The darkest mass: the ink-weighted centre of the picture, in canvas px. Cached per grid version.
export function mfCentre(state, base, W, H) {
  const c = state.centre;
  if (c && c.version === base.version) return c;
  const gw = base.gw;
  const gh = base.gh;
  const ink = base.ink;
  let sw = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const v = ink[y * gw + x];
      const w = v * v;
      sw += w;
      sx += w * x;
      sy += w * y;
    }
  }
  const out = sw > 1e-3
    ? { version: base.version, x: (sx / sw) * CELL_PX + 1, y: (sy / sw) * CELL_PX + 1 }
    : { version: base.version, x: W / 2, y: H / 2 };
  state.centre = out;
  return out;
}

// Grid cell that holds canvas point (x, y), clamped to the grid.
function mfNearest(base, x, y) {
  let cx = Math.floor(x / CELL_PX);
  let cy = Math.floor(y / CELL_PX);
  if (cx < 0) cx = 0; else if (cx > base.gw - 1) cx = base.gw - 1;
  if (cy < 0) cy = 0; else if (cy > base.gh - 1) cy = base.gh - 1;
  return cy * base.gw + cx;
}

// Distance, in grid cells, from every cell to the outline of the darkest subject (ink above one half), and the unit
// direction of increasing distance, which points away from the outline. Cached per grid version.
function mfOutline(state, base) {
  const gw = base.gw;
  const gh = base.gh;
  const n = gw * gh;
  let o = state.outline;
  if (o && o.version === base.version) return o;
  // Buffers are reused, because a video rebuilds the base grid, and so this field, on every frame.
  if (!o || o.dist.length !== n) {
    o = { version: -1, dist: new Float32Array(n), gx: new Float32Array(n), gy: new Float32Array(n), inside: new Uint8Array(n) };
    state.outline = o;
  }
  const ink = base.ink;
  const inside = o.inside;
  for (let i = 0; i < n; i++) inside[i] = ink[i] > 0.5 ? 1 : 0;

  const dist = o.dist;
  let seeds = 0;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const i = y * gw + x;
      const m = inside[i];
      const edge = (x > 0 && inside[i - 1] !== m) || (x < gw - 1 && inside[i + 1] !== m) ||
        (y > 0 && inside[i - gw] !== m) || (y < gh - 1 && inside[i + gw] !== m);
      if (edge) {
        dist[i] = 0;
        seeds++;
      } else {
        dist[i] = 1e9;
      }
    }
  }

  if (seeds === 0) {
    // No outline (a flat tone): measure from the centre instead, so the wave still travels.
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) dist[y * gw + x] = Math.hypot(x - gw / 2, y - gh / 2);
    }
  } else {
    // Two-pass chamfer distance (1 for straight steps, √2 for diagonal ones).
    const SQ2 = Math.SQRT2;
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const i = y * gw + x;
        let v = dist[i];
        if (x > 0) v = Math.min(v, dist[i - 1] + 1);
        if (y > 0) {
          v = Math.min(v, dist[i - gw] + 1);
          if (x > 0) v = Math.min(v, dist[i - gw - 1] + SQ2);
          if (x < gw - 1) v = Math.min(v, dist[i - gw + 1] + SQ2);
        }
        dist[i] = v;
      }
    }
    for (let y = gh - 1; y >= 0; y--) {
      for (let x = gw - 1; x >= 0; x--) {
        const i = y * gw + x;
        let v = dist[i];
        if (x < gw - 1) v = Math.min(v, dist[i + 1] + 1);
        if (y < gh - 1) {
          v = Math.min(v, dist[i + gw] + 1);
          if (x < gw - 1) v = Math.min(v, dist[i + gw + 1] + SQ2);
          if (x > 0) v = Math.min(v, dist[i + gw - 1] + SQ2);
        }
        dist[i] = v;
      }
    }
  }

  const gx = o.gx;
  const gy = o.gy;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const i = y * gw + x;
      const xl = x > 0 ? dist[i - 1] : dist[i];
      const xr = x < gw - 1 ? dist[i + 1] : dist[i];
      const yu = y > 0 ? dist[i - gw] : dist[i];
      const yd = y < gh - 1 ? dist[i + gw] : dist[i];
      const dx = xr - xl;
      const dy = yd - yu;
      const len = Math.hypot(dx, dy) || 1;
      gx[i] = dx / len;
      gy[i] = dy / len;
    }
  }
  o.version = base.version;
  return o;
}

// The moved grid's planes, reused between frames. Colour planes exist only when the base grid has them.
function mfPlanes(state, base) {
  const n = base.gw * base.gh;
  const colour = !!base.cr;
  let w = state.warped;
  if (!w || w.ink.length !== n || !!w.cr !== colour) {
    w = {
      gw: base.gw,
      gh: base.gh,
      tmp: base.tmp,
      blur: base.blur,
      lum: new Float32Array(n),
      ink: new Float32Array(n),
      cr: colour ? new Float32Array(n) : undefined,
      cg: colour ? new Float32Array(n) : undefined,
      cb: colour ? new Float32Array(n) : undefined,
    };
    state.warped = w;
  }
  return w;
}

// Displacement (canvas px) at every node for Pulse, Hover and Ripple, including video motion vectors when Motion
// influence is on. Writes state.nodes.
function mfNodeField(state, motion, W, H, base, data, k) {
  const nx = Math.ceil(W / MF_NODE) + 1;
  const ny = Math.ceil(H / MF_NODE) + 1;
  if (!state.nodes || state.nodes.nx !== nx || state.nodes.ny !== ny) {
    state.nodes = {
      nx: nx, ny: ny, toneOn: false,
      dx: new Float32Array(nx * ny), dy: new Float32Array(nx * ny), tone: new Float32Array(nx * ny),
    };
  }
  const nodes = state.nodes;
  // A tone wave (Dither's threshold wave) is written only with Pulse, so it is set on every node that it reads.
  nodes.toneOn = !!motion.toneWave;
  const type = motion.type;
  const amount = motion.amount;
  const scale = motion.scale;
  const time = motion.time;
  const diag = Math.hypot(W, H);
  const fH = motion.freq(MOTION_BASE.hover);
  const fP = motion.freq(MOTION_BASE.pulse);
  const fR = motion.freq(MOTION_BASE.ripple);
  const dir = (motion.direction * Math.PI) / 180;
  const ux = Math.cos(dir);
  const uy = Math.sin(dir);
  const outline = type === 'ripple' ? mfOutline(state, base) : null;
  const centre = type === 'pulse' ? mfCentre(state, base, W, H) : null;
  const useVideo = motion.influence > 0 && !!data && !!data.motion;
  const mv = state.mv || (state.mv = new Float32Array(3));

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = i * MF_NODE;
      const y = j * MF_NODE;
      let ex = 0;
      let ey = 0;
      if (type === 'hover') {
        // Each region has its own phase (value noise), so neighbours bob out of step.
        const a = 2 * Math.PI * (fH * time + mfNoise(x, y, 96));
        // Floor of 1.2 px so the float stays visible at small export sizes.
        const amp = Math.max(1.2, 1.6 * scale) * amount;
        ey = amp * Math.sin(a);
        ex = amp * 0.6 * Math.sin(a * 0.83 + 1.9);
      } else if (type === 'ripple') {
        const along = ux * x + uy * y;
        if (outline) {
          // Wave fronts leave the subject's outline, and drift in the Wave direction. Pixels move across the front.
          const c = mfNearest(base, x, y);
          const phase = (outline.dist[c] * CELL_PX) / (240 * scale) - (0.25 * along) / (240 * scale) - fR * time;
          const d = 5 * scale * amount * Math.sin(2 * Math.PI * phase);
          ex = outline.gx[c] * d;
          ey = outline.gy[c] * d;
        } else {
          const d = 5 * scale * amount * Math.sin(2 * Math.PI * (along / (240 * scale) - fR * time));
          ex = ux * d;
          ey = uy * d;
        }
      } else if (type === 'pulse') {
        // Rings travel out from the darkest mass, and the picture breathes about it. Dark areas move more.
        const rx = x - centre.x;
        const ry = y - centre.y;
        const r = Math.sqrt(rx * rx + ry * ry) || 1;
        const env = 1 / (1 + r / (0.6 * diag));
        const weight = 0.4 + 0.6 * base.ink[mfNearest(base, x, y)];
        const ring = 5 * scale * amount * Math.sin(2 * Math.PI * (r / (170 * scale) - fP * time)) * env * weight;
        const breath = 0.012 * amount * Math.sin(2 * Math.PI * fP * time);
        ex = (rx / r) * ring + rx * breath;
        ey = (ry / r) * ring + ry * breath;
        // Dither's threshold wave: the same rings, as an offset in tone (darker where the wave is positive).
        if (motion.toneWave) nodes.tone[j * nx + i] = 0.16 * amount * Math.sin(2 * Math.PI * (fP * time - r / (170 * scale)));
      }
      if (useVideo) {
        // Video motion adds to the displacement by Motion influence, and Depth scales it too, so Depth 0 is still.
        sampleMotion(data, k, x / CANVAS_SCALE, y / CANVAS_SCALE, mv);
        const lim = 16 * scale;
        ex += clamp(mv[0] * 4 * motion.influence * amount, -lim, lim);
        ey += clamp(mv[1] * 4 * motion.influence * amount, -lim, lim);
      }
      nodes.dx[j * nx + i] = ex;
      nodes.dy[j * nx + i] = ey;
    }
  }
}

// Samples every plane of the base grid at the displaced position of each cell. Displacement is bilinear on the nodes
// and the sample is bilinear on the grid, so a moved mark is smooth, not stepped.
function mfGather(state, base, out) {
  const gw = base.gw;
  const gh = base.gh;
  const nodes = state.nodes;
  const nx = nodes.nx;
  const ny = nodes.ny;
  const dxs = nodes.dx;
  const dys = nodes.dy;
  const tone = nodes.tone;
  const toneOn = nodes.toneOn;
  const srcs = [base.ink, base.lum];
  const dsts = [out.ink, out.lum];
  if (base.cr) {
    srcs.push(base.cr, base.cg, base.cb);
    dsts.push(out.cr, out.cg, out.cb);
  }
  const planes = srcs.length;
  for (let gy = 0; gy < gh; gy++) {
    const ty0 = (gy * CELL_PX + 1) / MF_NODE;
    const j0 = Math.floor(ty0);
    const ty = ty0 - j0;
    const j1 = j0 + 1 < ny ? j0 + 1 : j0;
    for (let gx = 0; gx < gw; gx++) {
      const tx0 = (gx * CELL_PX + 1) / MF_NODE;
      const i0 = Math.floor(tx0);
      const tx = tx0 - i0;
      const i1 = i0 + 1 < nx ? i0 + 1 : i0;
      const a = j0 * nx + i0;
      const b = j0 * nx + i1;
      const c = j1 * nx + i0;
      const d = j1 * nx + i1;
      const ddx = (dxs[a] * (1 - tx) + dxs[b] * tx) * (1 - ty) + (dxs[c] * (1 - tx) + dxs[d] * tx) * ty;
      const ddy = (dys[a] * (1 - tx) + dys[b] * tx) * (1 - ty) + (dys[c] * (1 - tx) + dys[d] * tx) * ty;
      let u = gx + ddx / CELL_PX;
      let v = gy + ddy / CELL_PX;
      if (u < 0) u = 0; else if (u > gw - 1) u = gw - 1;
      if (v < 0) v = 0; else if (v > gh - 1) v = gh - 1;
      const u0 = Math.floor(u);
      const v0 = Math.floor(v);
      const fu = u - u0;
      const fv = v - v0;
      const u1 = u0 < gw - 1 ? u0 + 1 : u0;
      const v1 = v0 < gh - 1 ? v0 + 1 : v0;
      const s00 = v0 * gw + u0;
      const s01 = v0 * gw + u1;
      const s10 = v1 * gw + u0;
      const s11 = v1 * gw + u1;
      const o = gy * gw + gx;
      for (let p = 0; p < planes; p++) {
        const s = srcs[p];
        dsts[p][o] = (s[s00] * (1 - fu) + s[s01] * fu) * (1 - fv) + (s[s10] * (1 - fu) + s[s11] * fu) * fv;
      }
      if (toneOn) {
        // The tone wave is added where the cell is, and is darker for a positive offset.
        const tv = (tone[a] * (1 - tx) + tone[b] * tx) * (1 - ty) + (tone[c] * (1 - tx) + tone[d] * tx) * ty;
        const iv = out.ink[o] + tv;
        out.ink[o] = iv < 0 ? 0 : (iv > 1 ? 1 : iv);
        const lv = out.lum[o] - 255 * tv;
        out.lum[o] = lv < 0 ? 0 : (lv > 255 ? 255 : lv);
      }
    }
  }
}

// Grid snake: on each row, a bead of darkness runs from left to right and trails behind its head.
function mfSnakeRows(base, out, motion) {
  const gw = base.gw;
  const gh = base.gh;
  const tail = Math.max(3, MF_TAIL * gw);
  const period = gw + tail;
  const amount = Math.min(motion.amount, 1.5);
  const ink = out.ink;
  const lum = out.lum;
  for (let gy = 0; gy < gh; gy++) {
    const f = mfSnake(motion, gy);
    if (f < 0) continue;
    const head = f * period;
    for (let gx = 0; gx < gw; gx++) {
      let dd = head - gx;
      if (dd < 0) dd += period;
      if (dd >= tail) continue;
      const b = 1 - dd / tail;
      const delta = 0.55 * amount * b * b;
      const o = gy * gw + gx;
      ink[o] = Math.min(1, ink[o] + delta);
      lum[o] = Math.max(0, lum[o] - 255 * delta);
    }
  }
}

// L0. Returns the grid the engine reads this frame: the base grid when nothing moves, otherwise a moved copy of it.
export function mfWarpGrid(state, base, motion, W, H, data, k) {
  const type = motion.type;
  const nodeType = type === 'pulse' || type === 'hover' || type === 'ripple';
  const rows = type === 'snake' && !motion.native;
  if (!nodeType && !rows) return base;
  const out = mfPlanes(state, base);
  if (nodeType) {
    mfNodeField(state, motion, W, H, base, data, k);
    mfGather(state, base, out);
  } else {
    out.ink.set(base.ink);
    out.lum.set(base.lum);
    if (base.cr) {
      out.cr.set(base.cr);
      out.cg.set(base.cg);
      out.cb.set(base.cb);
    }
  }
  if (rows) mfSnakeRows(base, out, motion);
  return out;
}
