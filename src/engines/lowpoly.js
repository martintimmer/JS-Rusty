import { clamp, lerp, sampleInk } from '../rendering/core.js';

// Geometric low poly: the picture is cut into triangles, and every triangle is filled with one flat
// shade taken from the darkness under its centre.
//   Points     a coarse, jittered lattice covers the whole picture (its outer ring sits on the frame, so
//              there are no holes). Extra points are drawn in proportion to the local tone gradient, so
//              facets are small at edges and features and large in flat areas (Feature detail).
//   Mesh       Delaunay triangulation of those points: no thin slivers, and the edges follow the features.
//   Shades     triangles are quantised to a number of shades between paper and ink.
//   Gaps       each triangle is shrunk toward its centre, leaving paper between facets (Facet gap).
//   Outline    optional darker outline around each facet (Outline).
// The mesh depends only on the size, Facet size, Vertex jitter and Feature detail, so it is cached and
// rebuilt when those change. On video it is built from the frame it was first needed for, so the
// geometry holds still while the shading follows the picture.

const LP_MAX_POINTS = 4000;

function lpHash(n) {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}

// Darkness gradient (0..1) at canvas point (x, y), from the analysis grid.
function lpGradient(grid, W, H, x, y) {
  const gw = grid.gw;
  const gh = grid.gh;
  const ink = grid.ink;
  const cx = clamp(Math.floor((x / W) * gw), 1, gw - 2);
  const cy = clamp(Math.floor((y / H) * gh), 1, gh - 2);
  const gx = ink[cy * gw + cx + 1] - ink[cy * gw + cx - 1];
  const gy = ink[(cy + 1) * gw + cx] - ink[(cy - 1) * gw + cx];
  // A small dead zone keeps flat areas and fine texture from attracting points.
  return clamp(((Math.abs(gx) + Math.abs(gy)) * 4 - 0.04) * 1.5, 0, 1);
}

// Points: a jittered lattice (outer ring on the frame) plus feature points drawn by rejection sampling
// in proportion to the tone gradient.
function lpPoints(grid, W, H, cell, feature, jitter) {
  const xs = [];
  const ys = [];
  const spacing = cell * 2.4;
  const cols = Math.ceil(W / spacing) + 1;
  const rows = Math.ceil(H / spacing) + 1;
  const jit = jitter * 0.4 * spacing;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const id = j * cols + i;
      const edge = i === 0 || j === 0 || i === cols - 1 || j === rows - 1;
      let x = i === cols - 1 ? W : i * spacing;
      let y = j === rows - 1 ? H : j * spacing;
      if (!edge) {
        x += (lpHash(id * 2.1 + 0.4) - 0.5) * 2 * jit;
        y += (lpHash(id * 3.7 + 1.1) - 0.5) * 2 * jit;
      }
      xs.push(clamp(x, 0, W));
      ys.push(clamp(y, 0, H));
    }
  }

  const want = Math.round(feature * 0.35 * (W * H) / (cell * cell));
  let placed = 0;
  const maxTries = want * 40 + 100;
  for (let tries = 1; placed < want && tries < maxTries; tries++) {
    const x = lpHash(tries * 0.731 + 11.3) * W;
    const y = lpHash(tries * 1.37 + 5.9) * H;
    if (lpHash(tries * 2.11 + 3.7) < lpGradient(grid, W, H, x, y)) {
      xs.push(clamp(x + (lpHash(tries * 4.3 + 1.7) - 0.5) * cell * jitter, 0, W));
      ys.push(clamp(y + (lpHash(tries * 5.9 + 2.9) - 0.5) * cell * jitter, 0, H));
      placed++;
    }
  }
  return { xs: xs, ys: ys };
}

// Circumcircle of triangle (a, b, c) as { ux, uy, r2 }.
function lpMakeTri(X, Y, a, b, c) {
  const ax = X[a];
  const ay = Y[a];
  const bx = X[b];
  const by = Y[b];
  const cx = X[c];
  const cy = Y[c];
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  const a2 = ax * ax + ay * ay;
  const b2 = bx * bx + by * by;
  const c2 = cx * cx + cy * cy;
  let ux = 0;
  let uy = 0;
  if (Math.abs(d) > 1e-12) {
    ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
    uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  }
  const r2 = (ax - ux) * (ax - ux) + (ay - uy) * (ay - uy);
  return { a: a, b: b, c: c, ux: ux, uy: uy, r2: Math.abs(d) > 1e-12 ? r2 : Infinity };
}

// Bowyer-Watson Delaunay triangulation. Returns an Int32Array of triangle vertex indices (3 per triangle)
// into the point arrays, without the temporary super-triangle.
function lpDelaunay(xs, ys, W, H) {
  const n = xs.length;
  const X = new Float64Array(n + 3);
  const Y = new Float64Array(n + 3);
  for (let i = 0; i < n; i++) {
    X[i] = xs[i];
    Y[i] = ys[i];
  }
  const big = 50 * (W + H);
  X[n] = W / 2 - big;
  Y[n] = H / 2 - big;
  X[n + 1] = W / 2 + big;
  Y[n + 1] = H / 2 - big;
  X[n + 2] = W / 2;
  Y[n + 2] = H / 2 + big;

  let tris = [lpMakeTri(X, Y, n, n + 1, n + 2)];
  for (let i = 0; i < n; i++) {
    const px = X[i];
    const py = Y[i];
    const bad = [];
    const keep = [];
    for (let t = 0; t < tris.length; t++) {
      const tri = tris[t];
      const dx = px - tri.ux;
      const dy = py - tri.uy;
      if (dx * dx + dy * dy < tri.r2) bad.push(tri);
      else keep.push(tri);
    }
    // The cavity boundary is every edge that belongs to exactly one bad triangle.
    const edges = new Map();
    for (let t = 0; t < bad.length; t++) {
      const tri = bad[t];
      const pairs = [[tri.a, tri.b], [tri.b, tri.c], [tri.c, tri.a]];
      for (let e = 0; e < 3; e++) {
        const u = pairs[e][0];
        const v = pairs[e][1];
        const key = u < v ? u * (n + 3) + v : v * (n + 3) + u;
        const seen = edges.get(key);
        if (seen) seen.count++;
        else edges.set(key, { u: u, v: v, count: 1 });
      }
    }
    tris = keep;
    edges.forEach((e) => {
      if (e.count === 1) tris.push(lpMakeTri(X, Y, e.u, e.v, i));
    });
  }

  const out = [];
  for (let t = 0; t < tris.length; t++) {
    const tri = tris[t];
    if (tri.a < n && tri.b < n && tri.c < n) out.push(tri.a, tri.b, tri.c);
  }
  return Int32Array.from(out);
}

// The mesh for the current size and layout settings, cached in state.
function lpMesh(rc, cell, feature, jitter) {
  const { W, H, grid, state, p } = rc;
  // The tone settings are part of the key because the feature points are drawn from the tone gradient.
  const key = [W, H, Math.round(cell * 10), Math.round(feature * 100), Math.round(jitter * 100),
    p.contrast, p.brightness, p.edge, p.detail].join('|');
  if (state.mesh && state.mesh.key === key) return state.mesh;
  const pts = lpPoints(grid, W, H, cell, feature, jitter);
  const tris = lpDelaunay(pts.xs, pts.ys, W, H);
  state.mesh = { key: key, xs: pts.xs, ys: pts.ys, tris: tris };
  return state.mesh;
}

export function renderLowPoly(rc) {
  const { ctx, W, H, grid, p, pal } = rc;
  const scale = W / 1920;
  const density = clamp(p.density, 0, 100) / 100;
  const feature = clamp(p.lpBias, 0, 100) / 100;
  const jitter = clamp(p.lpJitter, 0, 100) / 100;

  // Facet size sets the base cell. The cell grows if the point count would exceed the cap.
  let cell = Math.max(10, lerp(90, 14, density) * scale);
  for (let guard = 0; guard < 40; guard++) {
    const est = (W / (cell * 2.4) + 2) * (H / (cell * 2.4) + 2) + feature * 0.35 * (W * H) / (cell * cell);
    if (est <= LP_MAX_POINTS) break;
    cell *= 1.08;
  }

  const mesh = lpMesh(rc, cell, feature, jitter);
  const xs = mesh.xs;
  const ys = mesh.ys;
  const tris = mesh.tris;
  const triCount = tris.length / 3;

  const bg = pal.bg;
  const ink = pal.stroke;
  const shades = clamp(Math.round(p.lpShades), 2, 16);
  const gap = (clamp(p.lpGap, 0, 100) / 100) * 0.4;
  const outline = clamp(p.lpOutline, 0, 100) / 100;
  const paths = [];
  for (let s = 0; s < shades; s++) paths.push(new Path2D());
  const edges = new Path2D();

  for (let t = 0; t < triCount; t++) {
    const a = tris[3 * t];
    const b = tris[3 * t + 1];
    const c = tris[3 * t + 2];
    const cx = (xs[a] + xs[b] + xs[c]) / 3;
    const cy = (ys[a] + ys[b] + ys[c]) / 3;
    const d = clamp(sampleInk(grid, cx, cy), 0, 1);
    const path = paths[Math.round(d * (shades - 1))];
    const ids = [a, b, c];
    const px = ids.map((id) => cx + (xs[id] - cx) * (1 - gap));
    const py = ids.map((id) => cy + (ys[id] - cy) * (1 - gap));
    path.moveTo(px[0], py[0]);
    path.lineTo(px[1], py[1]);
    path.lineTo(px[2], py[2]);
    path.closePath();
    if (outline > 0) {
      edges.moveTo(px[0], py[0]);
      edges.lineTo(px[1], py[1]);
      edges.lineTo(px[2], py[2]);
      edges.closePath();
    }
  }

  ctx.fillStyle = pal.bgCss;
  ctx.fillRect(0, 0, W, H);
  for (let s = 0; s < shades; s++) {
    const t = s / (shades - 1);
    ctx.fillStyle = 'rgb(' + Math.round(lerp(bg[0], ink[0], t)) + ',' +
      Math.round(lerp(bg[1], ink[1], t)) + ',' + Math.round(lerp(bg[2], ink[2], t)) + ')';
    ctx.fill(paths[s]);
  }

  if (outline > 0) {
    ctx.globalAlpha = outline;
    ctx.strokeStyle = pal.strokeCss;
    ctx.lineWidth = Math.max(0.6, 0.9 * scale);
    ctx.lineJoin = 'round';
    ctx.stroke(edges);
    ctx.globalAlpha = 1;
  }
  rc.elements = triCount;
}
