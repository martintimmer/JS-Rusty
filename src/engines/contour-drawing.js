import { clamp, lerp, boxBlur, CELL_PX } from '../rendering/core.js';

// Contour drawing: hand-drawn contour lines with extensive settings.
//   1. Smoothing     the ink field is blurred before the contours are found.
//   2. Levels        marching squares at evenly spaced levels; crossings are stitched into chains.
//   3. Hand drawing  each chain gets a smooth, irregular jitter; lines can be broken into pieces,
//                    short fragments are dropped, and each line is drawn as a tapered ribbon whose
//                    width depends on its tone (darker levels get heavier lines).
//   4. Shading       lighter levels are drawn in lighter ink, so the drawing has depth.
//   5. Hatching      the darkest areas can be filled with hatching at a chosen angle and spacing.
// Ribbons are filled as polygons in a few shades, so the cost stays low.

const CDR_BINS = 6;
const CDR_SEGMENTS = [
  [], [[3, 2]], [[2, 1]], [[3, 1]],
  [[0, 1]], [[0, 1], [2, 3]], [[0, 2]], [[0, 3]],
  [[0, 3]], [[0, 2]], [[0, 3], [1, 2]], [[0, 1]],
  [[3, 1]], [[1, 2]], [[3, 2]], [],
];

function cdrHash(n) {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}

function cdrState(state, gw, gh) {
  const n = gw * gh;
  if (!state.cdr || state.cdr.n !== n) {
    state.cdr = {
      n: n,
      field: new Float32Array(n),
      tmp: new Float32Array(n),
      linkA: new Int32Array(2 * n).fill(-1),
      linkB: new Int32Array(2 * n).fill(-1),
      visited: new Uint8Array(2 * n),
      touched: new Int32Array(2 * n),
      ex: new Float32Array(2 * n),
      ey: new Float32Array(2 * n),
      ids: new Int32Array(4),
    };
  }
  return state.cdr;
}

export function renderContourDrawing(rc) {
  const { ctx, W, H, grid, p, pal, state } = rc;
  const gw = grid.gw;
  const gh = grid.gh;
  const st = cdrState(state, gw, gh);
  if (!state.img || state.img.width !== W || state.img.height !== H) {
    state.img = ctx.createImageData(W, H);
  }
  const scale = W / 1920;
  const bg = pal.bg;
  const ink = pal.stroke;

  // 1) Smoothing of the ink field.
  const radius = Math.round(lerp(0, 6, clamp(p.cdSmooth, 0, 100) / 100));
  if (radius > 0) boxBlur(grid.ink, st.tmp, st.field, gw, gh, radius);
  else st.field.set(grid.ink);
  const field = st.field;

  // 2) Paper and hatching, written first so the lines sit on top.
  const img = state.img.data;
  const hatchAmount = clamp(p.cdHatch, 0, 100) / 100;
  const hatchThreshold = lerp(0.95, 0.4, hatchAmount);
  const angle = (p.cdHatchAngle * Math.PI) / 180;
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  const spacing = Math.max(2, p.cdHatchSpacing * scale);
  for (let y = 0; y < H; y++) {
    const gy = Math.min(gh - 1, Math.floor(y / CELL_PX));
    for (let x = 0; x < W; x++) {
      const gx = Math.min(gw - 1, Math.floor(x / CELL_PX));
      const d = clamp(field[gy * gw + gx], 0, 1);
      let on = false;
      if (hatchAmount > 0 && d > hatchThreshold) {
        const phase = (x * cosA + y * sinA) / spacing;
        on = phase - Math.floor(phase) < 0.3 + 0.35 * d;
      }
      const o = (y * W + x) * 4;
      const src = on ? ink : bg;
      img[o] = src[0];
      img[o + 1] = src[1];
      img[o + 2] = src[2];
      img[o + 3] = 255;
    }
  }
  ctx.putImageData(state.img, 0, 0);

  // 3) Contour chains at each level.
  const levels = clamp(Math.round(p.cdLevels), 2, 40);
  const stride = p.detail < 35 ? 3 : (p.detail < 70 ? 2 : 1);
  const chains = [];
  for (let li = 0; li < levels; li++) {
    const lv = levels === 1 ? 0.5 : lerp(0.06, 0.94, li / (levels - 1));
    cdrLevel(field, gw, gh, stride, lv, st, chains);
  }

  // 4) Hand drawing: jitter, breaks, length filter, tapered tone-weighted ribbons.
  const jitter = (clamp(p.cdJitter, 0, 100) / 100) * 2.5 * scale;
  const breakChance = (clamp(p.cdBreaks, 0, 100) / 100) * 0.25;
  const minLength = Math.max(0, p.cdMinLen) * scale;
  const baseWidth = Math.max(0.5, p.thickness * 1.6 * scale);
  const taperAmount = clamp(p.cdTaper, 0, 100) / 100;
  const toneAmount = clamp(p.cdToneWeight, 0, 100) / 100;
  const shadeAmount = clamp(p.cdShade, 0, 100) / 100;
  const taperLength = 14 * scale;
  const bins = [];
  for (let b = 0; b < CDR_BINS; b++) bins.push(new Path2D());
  let ribbons = 0;

  for (let c = 0; c < chains.length; c++) {
    const chain = chains[c];
    const n = chain.pts.length / 2;
    if (n < 2) continue;
    const seed = c * 0.731 + 1.3;
    const X = new Float32Array(n);
    const Y = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let x = chain.pts[2 * i] * CELL_PX;
      let y = chain.pts[2 * i + 1] * CELL_PX;
      x += jitter * Math.sin(0.9 * x + 1.7 * y + seed);
      y += jitter * Math.cos(1.3 * x - 0.8 * y + seed * 0.7);
      X[i] = x;
      Y[i] = y;
    }

    // Split into pieces at random breaks.
    let start = 0;
    for (let i = 1; i <= n; i++) {
      const cut = i === n || (breakChance > 0 && cdrHash(c * 131 + i * 17) < breakChance);
      if (!cut) continue;
      const end = i;
      if (end - start >= 2) {
        ribbons += cdrRibbon(bins, X, Y, start, end, chain.lv, {
          minLength, baseWidth, taperAmount, toneAmount, shadeAmount, taperLength,
        });
      }
      start = i;
    }
  }

  // 5) Fill each shade of ink.
  for (let b = 0; b < CDR_BINS; b++) {
    const t = b / (CDR_BINS - 1);
    ctx.fillStyle = 'rgb(' + Math.round(lerp(bg[0], ink[0], t)) + ',' +
      Math.round(lerp(bg[1], ink[1], t)) + ',' + Math.round(lerp(bg[2], ink[2], t)) + ')';
    ctx.fill(bins[b]);
  }
  rc.elements = ribbons;
}

// Builds one ribbon per piece of a line. Returns 1 when a ribbon was added.
function cdrRibbon(bins, X, Y, from, to, lv, o) {
  const m = to - from;
  // Arc length along the piece.
  const s = new Float32Array(m);
  let total = 0;
  for (let i = 1; i < m; i++) {
    total += Math.hypot(X[from + i] - X[from + i - 1], Y[from + i] - Y[from + i - 1]);
    s[i] = total;
  }
  if (total < o.minLength) return 0;

  const toneW = lerp(1, 0.25 + lv, o.toneAmount);
  // Shade: lighter levels get lighter ink, mapped to one of the bins.
  const colour = lerp(1, lv, o.shadeAmount);
  const bin = Math.max(0, Math.min(CDR_BINS - 1, Math.round(colour * (CDR_BINS - 1))));
  const path = bins[bin];

  const L = new Float32Array(m * 2);
  const R = new Float32Array(m * 2);
  for (let i = 0; i < m; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(m - 1, i + 1);
    let tx = X[from + b] - X[from + a];
    let ty = Y[from + b] - Y[from + a];
    const len = Math.hypot(tx, ty) || 1;
    tx /= len;
    ty /= len;
    const nx = -ty;
    const ny = tx;
    const endDist = Math.min(s[i], total - s[i]);
    const taper = lerp(1, Math.pow(clamp(endDist / o.taperLength, 0, 1), 0.8), o.taperAmount);
    const half = (o.baseWidth * toneW * taper) / 2;
    L[2 * i] = X[from + i] + nx * half;
    L[2 * i + 1] = Y[from + i] + ny * half;
    R[2 * i] = X[from + i] - nx * half;
    R[2 * i + 1] = Y[from + i] - ny * half;
  }
  path.moveTo(L[0], L[1]);
  for (let i = 1; i < m; i++) path.lineTo(L[2 * i], L[2 * i + 1]);
  for (let i = m - 1; i >= 0; i--) path.lineTo(R[2 * i], R[2 * i + 1]);
  path.closePath();
  return 1;
}

// Marching squares at one level. Adds every chain (grid units) to out.
function cdrLevel(field, gw, gh, stride, level, st, out) {
  const { linkA, linkB, visited, touched, ex, ey, ids } = st;
  let nt = 0;
  for (let gy = 0; gy + stride < gh; gy += stride) {
    for (let gx = 0; gx + stride < gw; gx += stride) {
      const tl = gy * gw + gx;
      const tr = gy * gw + gx + stride;
      const br = (gy + stride) * gw + gx + stride;
      const bl = (gy + stride) * gw + gx;
      const v0 = field[tl];
      const v1 = field[tr];
      const v2 = field[br];
      const v3 = field[bl];
      const code = (v0 > level ? 8 : 0) | (v1 > level ? 4 : 0) | (v2 > level ? 2 : 0) | (v3 > level ? 1 : 0);
      const segs = CDR_SEGMENTS[code];
      if (segs.length === 0) continue;
      ids[0] = tl * 2;
      ids[1] = (gy * gw + gx + stride) * 2 + 1;
      ids[2] = bl * 2;
      ids[3] = tl * 2 + 1;
      cdrPlace(ex, ey, ids[0], gx, gy, stride, 0, v0, v1, level);
      cdrPlace(ex, ey, ids[1], gx, gy, stride, 1, v1, v2, level);
      cdrPlace(ex, ey, ids[2], gx, gy, stride, 2, v3, v2, level);
      cdrPlace(ex, ey, ids[3], gx, gy, stride, 3, v0, v3, level);
      for (let s = 0; s < segs.length; s++) {
        const a = ids[segs[s][0]];
        const b = ids[segs[s][1]];
        nt = cdrLink(linkA, linkB, a, b, touched, nt);
        nt = cdrLink(linkA, linkB, b, a, touched, nt);
      }
    }
  }
  for (let t = 0; t < nt; t++) {
    const id = touched[t];
    if (visited[id] || linkB[id] !== -1) continue;
    cdrWalk(id, linkA, linkB, visited, ex, ey, out, level);
  }
  for (let t = 0; t < nt; t++) {
    const id = touched[t];
    if (visited[id]) continue;
    cdrWalk(id, linkA, linkB, visited, ex, ey, out, level);
  }
  for (let t = 0; t < nt; t++) {
    const id = touched[t];
    linkA[id] = -1;
    linkB[id] = -1;
    visited[id] = 0;
  }
}

function cdrLink(linkA, linkB, from, to, touched, nt) {
  if (linkA[from] === -1) {
    linkA[from] = to;
    touched[nt] = from;
    return nt + 1;
  }
  linkB[from] = to;
  return nt;
}

// Follows links from a start edge and stores one chain (grid units, flat x,y pairs).
function cdrWalk(start, linkA, linkB, visited, ex, ey, out, level) {
  const pts = [ex[start], ey[start]];
  let cur = start;
  let prev = -1;
  visited[cur] = 1;
  for (;;) {
    const next = linkA[cur] !== prev ? linkA[cur] : linkB[cur];
    if (next === -1) break;
    if (next === start) {
      pts.push(ex[next], ey[next]);
      break;
    }
    if (visited[next]) break;
    pts.push(ex[next], ey[next]);
    visited[next] = 1;
    prev = cur;
    cur = next;
  }
  out.push({ lv: level, pts: pts });
}

// Crossing point for an edge, written into ex/ey at slot id (grid units).
function cdrPlace(ex, ey, id, gx, gy, s, edge, va, vb, level) {
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
  ex[id] = ax + (bx - ax) * t;
  ey[id] = ay + (by - ay) * t;
}

