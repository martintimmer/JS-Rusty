import {
  clamp, lerp, sampleMotion, CANVAS_SCALE, CELL_PX,
} from '../rendering/core.js';

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
  };

  for (let li = 0; li < levelCount; li++) {
    const level = levelCount === 1 ? 0.5 : lerp(0.08, 0.92, li / (levelCount - 1));
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
    }
    for (let t = 0; t < nt; t++) {
      const id = touched[t];
      if (visited[id]) continue;
      chains += walkChain(id, linkA, linkB, visited, emitPoint);
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
  rc.elements = chains;
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
