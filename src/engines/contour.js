import {
  clamp, lerp, sampleMotion, CANVAS_SCALE, CELL_PX,
} from '../rendering/core.js';
import { mfActive, mfSnake, mfSwell, mfTriangle, MOTION_BASE } from '../rendering/motion-field.js';

// Contour / line-art engine.
// Marching squares extracts iso-lines of the (denoised) ink field. Crossings on shared
// cell edges are stitched into continuous polylines, so each contour is one stroke
// rather than a pile of short segments. Closed loops are closed explicitly.
// Density sets the number of levels, detail sets the cell stride, and motion
// vectors displace the vertices so the linework flows with the source.

// Segments per marching-squares case. Corners: 0 = tl, 1 = tr, 2 = br, 3 = bl.
// Edges: 0 = top, 1 = right, 2 = bottom, 3 = left.
const SEGMENTS = [
  [], [[3, 2]], [[2, 1]], [[3, 1]],
  [[0, 1]], [[0, 1], [2, 3]], [[0, 2]], [[0, 3]],
  [[0, 3]], [[0, 2]], [[0, 3], [1, 2]], [[0, 1]],
  [[3, 1]], [[1, 2]], [[3, 2]], [],
];

export function renderContour(rc) {
  const { ctx, W, H, grid, p, pal, data, k, state } = rc;
  const gw = grid.gw;
  const gh = grid.gh;
  const ink = grid.ink;
  const cells = gw * gh;
  const edgeCount = cells * 2;
  if (!state.linkA || state.linkA.length !== edgeCount) {
    state.linkA = new Int32Array(edgeCount).fill(-1);
    state.linkB = new Int32Array(edgeCount).fill(-1);
    state.visited = new Uint8Array(edgeCount);
    state.touched = new Int32Array(edgeCount);
    state.px = new Float32Array(edgeCount);
    state.py = new Float32Array(edgeCount);
  }
  const linkA = state.linkA;
  const linkB = state.linkB;
  const visited = state.visited;
  const touched = state.touched;
  const px = state.px;
  const py = state.py;

  const scale = W / 1920;
  const levelCount = Math.round(lerp(4, 14, clamp(p.density, 0, 100) / 100));
  const stride = p.detail < 50 ? 3 : (p.detail < 85 ? 2 : 1);
  const useMotion = p.motion > 0 && data.motion && data.count > 1;
  const lineWidth = Math.max(0.6, 1.1 * p.thickness * scale);
  const path = new Path2D();
  const mv = state.mv || (state.mv = new Float32Array(3));
  const ids = new Int32Array(4);
  let chains = 0;

  // Motion, when on. Pulse sweeps the levels up and down the tone range, staggered across the levels, so the contours
  // breathe. Snake puts a bead on a share of the chains: a thicker run of the same line that travels along it.
  const sweep = mfActive(rc, 'pulse');
  const sweepBlend = sweep ? clamp(rc.motion.amount, 0, 1) : 0;
  const sweepPhase = sweep ? rc.motion.freq(MOTION_BASE.pulse) * rc.motion.time : 0;
  const beads = mfActive(rc, 'snake');
  // Beads are drawn in three widths, by how far the picture moves at each bead's head (see contourBead).
  const beadPaths = beads ? [new Path2D(), new Path2D(), new Path2D()] : null;
  const chainBuf = [];

  ctx.fillStyle = pal.bgCss;
  ctx.fillRect(0, 0, W, H);

  // Canvas point for a stored edge position (grid units), with optional motion.
  const emitPoint = (method, id) => {
    let x = px[id] * CELL_PX;
    let y = py[id] * CELL_PX;
    if (useMotion) {
      sampleMotion(data, k, x / CANVAS_SCALE, y / CANVAS_SCALE, mv);
      x += mv[0] * CANVAS_SCALE * p.motion;
      y += mv[1] * CANVAS_SCALE * p.motion;
    }
    if (method === 0) path.moveTo(x, y);
    else path.lineTo(x, y);
    if (beads) {
      if (method === 0) chainBuf.length = 0;
      chainBuf.push(x, y);
    }
  };

  for (let li = 0; li < levelCount; li++) {
    const standard = levelCount === 1 ? 0.5 : lerp(0.08, 0.92, li / (levelCount - 1));
    const level = sweepBlend > 0
      ? lerp(standard, lerp(0.08, 0.92, mfTriangle(sweepPhase + li / levelCount)), sweepBlend)
      : standard;
    // Only the edges touched on this level are cleared and walked (cheap at coarse stride).
    let nt = 0;

    // 1) Marching squares: link the crossing points that share each edge.
    for (let gy = 0; gy + stride < gh; gy += stride) {
      for (let gx = 0; gx + stride < gw; gx += stride) {
        const tl = gy * gw + gx;
        const tr = gy * gw + gx + stride;
        const br = (gy + stride) * gw + gx + stride;
        const bl = (gy + stride) * gw + gx;
        const v0 = ink[tl];
        const v1 = ink[tr];
        const v2 = ink[br];
        const v3 = ink[bl];
        const code = (v0 > level ? 8 : 0) | (v1 > level ? 4 : 0) |
                     (v2 > level ? 2 : 0) | (v3 > level ? 1 : 0);
        const segs = SEGMENTS[code];
        if (segs.length === 0) continue;

        // Edge ids: horizontal edges are even, vertical edges odd, keyed by their start cell.
        ids[0] = tl * 2;
        ids[1] = (gy * gw + gx + stride) * 2 + 1;
        ids[2] = bl * 2;
        ids[3] = tl * 2 + 1;
        placeEdge(px, py, ids[0], gx, gy, stride, 0, v0, v1, level);
        placeEdge(px, py, ids[1], gx, gy, stride, 1, v1, v2, level);
        placeEdge(px, py, ids[2], gx, gy, stride, 2, v3, v2, level);
        placeEdge(px, py, ids[3], gx, gy, stride, 3, v0, v3, level);
        for (let s = 0; s < segs.length; s++) {
          const a = ids[segs[s][0]];
          const b = ids[segs[s][1]];
          nt = link(linkA, linkB, a, b, touched, nt);
          nt = link(linkA, linkB, b, a, touched, nt);
        }
      }
    }

    // 2) Walk open chains first (their ends have a single link), then closed loops.
    for (let t = 0; t < nt; t++) {
      const id = touched[t];
      if (visited[id] || linkB[id] !== -1) continue;
      chains += walkChain(id, linkA, linkB, visited, emitPoint);
      if (beads) contourBead(chainBuf, beadPaths, rc, chains);
    }
    for (let t = 0; t < nt; t++) {
      const id = touched[t];
      if (visited[id]) continue;
      chains += walkChain(id, linkA, linkB, visited, emitPoint);
      if (beads) contourBead(chainBuf, beadPaths, rc, chains);
    }

    // Reset only what this level touched.
    for (let t = 0; t < nt; t++) {
      const id = touched[t];
      linkA[id] = -1;
      linkB[id] = -1;
      visited[id] = 0;
    }
  }

  ctx.strokeStyle = pal.strokeCss;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = lineWidth;
  ctx.stroke(path);
  if (beads) {
    const width = lineWidth * (1 + 1.2 * clamp(p.thickness, 0.2, 2));
    const scales = [1, 1.35, 1.7];
    for (let s = 0; s < beadPaths.length; s++) {
      ctx.lineWidth = width * scales[s];
      ctx.stroke(beadPaths[s]);
    }
  }
  rc.elements = chains;
}

// A snake on one chain: a run of the chain, from a tail behind its head up to the head, which moves along the chain
// and leaves at its end. The chain's points are in buf (x, y pairs). id is stable for the chain, so the snake is too.
// The bead goes into the path of its width: thicker where the picture moves at its head (video only).
function contourBead(buf, paths, rc, id) {
  const n = buf.length >> 1;
  if (n < 6) return;
  const f = mfSnake(rc.motion, id);
  if (f < 0) return;
  const tail = Math.max(3, Math.min(24, Math.round(n * 0.4)));
  const hi = Math.floor(f * (n + tail));
  const a = Math.max(0, hi - tail);
  const b = Math.min(n - 1, hi);
  if (b <= a) return;
  const sw = mfSwell(rc, buf[2 * b], buf[2 * b + 1]);
  const path = paths[sw < 1.3 ? 0 : (sw < 1.9 ? 1 : 2)];
  path.moveTo(buf[2 * a], buf[2 * a + 1]);
  for (let i = a + 1; i <= b; i++) path.lineTo(buf[2 * i], buf[2 * i + 1]);
}

// Records one link from edge `from` to edge `to`. Returns the updated touched count.
function link(linkA, linkB, from, to, touched, nt) {
  if (linkA[from] === -1) {
    linkA[from] = to;
    touched[nt] = from;
    return nt + 1;
  }
  linkB[from] = to;
  return nt;
}

// Follows links from a start edge, emitting one polyline (or a closed loop).
// Returns 1 when a chain was emitted.
function walkChain(start, linkA, linkB, visited, emitPoint) {
  let cur = start;
  let prev = -1;
  emitPoint(0, cur);
  visited[cur] = 1;
  for (;;) {
    const next = linkA[cur] !== prev ? linkA[cur] : linkB[cur];
    if (next === -1) break;
    if (next === start) {
      // Closed loop: the chain returns to its start point.
      emitPoint(1, next);
      break;
    }
    if (visited[next]) break;
    emitPoint(1, next);
    visited[next] = 1;
    prev = cur;
    cur = next;
  }
  return 1;
}

// Writes the crossing point for an edge into px/py (grid units) by linear interpolation.
// Edges are always ordered left-to-right or top-to-bottom, so both cells that share an
// edge compute the same point.
function placeEdge(px, py, id, gx, gy, s, edge, va, vb, level) {
  let ax;
  let ay;
  let bx;
  let by;
  if (edge === 0) {
    ax = gx; ay = gy; bx = gx + s; by = gy;
  } else if (edge === 1) {
    ax = gx + s; ay = gy; bx = gx + s; by = gy + s;
  } else if (edge === 2) {
    ax = gx; ay = gy + s; bx = gx + s; by = gy + s;
  } else {
    ax = gx; ay = gy; bx = gx; by = gy + s;
  }
  const d = vb - va;
  const t = Math.abs(d) < 1e-6 ? 0.5 : clamp((level - va) / d, 0, 1);
  px[id] = lerp(ax, bx, t);
  py[id] = lerp(ay, by, t);
}
