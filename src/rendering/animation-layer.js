import { clamp, sampleMotion, CANVAS_SCALE } from './core.js';
import { buildFlow, createFlowBuffers } from './flow.js';

// Motion layer: animation laid over whichever algorithm is selected. The algorithm draws the
// still picture first; this layer then moves it, so the chosen look is kept.
//   snake   snakes crawl along the flow of the subject's contours (line follow)
//   pulse   the picture breathes, and rings of displacement travel out from the centre
//   hover   fine, irregular floating: neighbouring regions bob slightly out of step
//   ripple  a wave travels across the picture in the chosen direction
// Displacement types move pixels: the frame is read back, every output pixel is taken from a
// displaced source position (nearest sample), and the result is written back. Displacement is
// evaluated on a coarse node grid and interpolated bilinearly, so it stays smooth and cheap.
// On video, the motion vectors add to the displacement, scaled by Motion influence.
// The clock is rc.t (video time, or the still-image clock while playing) times Speed.

export const MOTION_TYPES = ['snake', 'pulse', 'hover', 'ripple'];

const MOT_NODE = 8; // px between displacement nodes (at 1080p)
const MOT_TAIL = 30; // snake tail length, in streamline points
const MOT_STEPS = 170; // streamline length, in steps
const MOT_STEP = 0.9; // step length, in analysis cells
const MOT_RATE = 26; // snake head speed, in streamline points per second (Speed 1)

function motHash(n) {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}

function motLattice(ix, iy) {
  return motHash(ix * 57.31 + iy * 113.7);
}

// Smooth value noise in [0, 1) with lattice spacing `cell` (px).
function motNoise(x, y, cell) {
  const gx = x / cell;
  const gy = y / cell;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  const fx = gx - ix;
  const fy = gy - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const top = motLattice(ix, iy) * (1 - sx) + motLattice(ix + 1, iy) * sx;
  const bottom = motLattice(ix, iy + 1) * (1 - sx) + motLattice(ix + 1, iy + 1) * sx;
  return top * (1 - sy) + bottom * sy;
}

// Displacement (px) at every node for the pixel-moving types. Writes state.dx / state.dy.
function motWaveField(rc, type, state, time, scale, amount, motion) {
  const { W, H, p, data } = rc;
  const nx = Math.ceil(W / MOT_NODE) + 1;
  const ny = Math.ceil(H / MOT_NODE) + 1;
  if (!state.dx || state.dx.length !== nx * ny) {
    state.dx = new Float32Array(nx * ny);
    state.dy = new Float32Array(nx * ny);
  }
  state.nx = nx;
  state.ny = ny;
  const dxs = state.dx;
  const dys = state.dy;
  const cx = W / 2;
  const cy = H / 2;
  const diag = Math.hypot(W, H);
  const dir = ((p.direction || 0) * Math.PI) / 180;
  const ux = Math.cos(dir);
  const uy = Math.sin(dir);
  const mv = state.mv;
  const useMotion = motion > 0 && !!data.motion;

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = i * MOT_NODE;
      const y = j * MOT_NODE;
      let dx = 0;
      let dy = 0;
      if (type === 'hover') {
        // Each region has its own phase (value noise), so neighbours bob out of step.
        const a = 2 * Math.PI * (0.3 * time + motNoise(x, y, 96));
        // Floor of 1.2 px so the float stays visible at small export sizes (nearest sampling rounds smaller moves away).
        const amp = Math.max(1.2, 1.6 * scale) * amount;
        dy = amp * Math.sin(a);
        dx = amp * 0.6 * Math.sin(a * 0.83 + 1.9);
      } else if (type === 'ripple') {
        const along = ux * x + uy * y;
        const d = 5 * scale * amount * Math.sin(2 * Math.PI * (along / (240 * scale) - 0.22 * time));
        dx = ux * d;
        dy = uy * d;
      } else {
        // Pulse: rings travel outward from the centre, and the picture breathes in and out.
        const rx = x - cx;
        const ry = y - cy;
        const r = Math.sqrt(rx * rx + ry * ry) || 1;
        const env = 1 / (1 + r / (0.6 * diag));
        const ring = 5 * scale * amount * Math.sin(2 * Math.PI * (r / (170 * scale) - 0.3 * time)) * env;
        const breath = 0.012 * amount * Math.sin(2 * Math.PI * 0.3 * time);
        dx = (rx / r) * ring + rx * breath;
        dy = (ry / r) * ring + ry * breath;
      }
      if (useMotion) {
        sampleMotion(data, rc.k, x / CANVAS_SCALE, y / CANVAS_SCALE, mv);
        const lim = 16 * scale;
        dx += clamp(mv[0] * 4 * motion, -lim, lim);
        dy += clamp(mv[1] * 4 * motion, -lim, lim);
      }
      dxs[j * nx + i] = dx;
      dys[j * nx + i] = dy;
    }
  }
}

// Reads the frame back, takes every output pixel from its displaced source position and writes it.
function motRemap(rc, state) {
  const { ctx, W, H } = rc;
  const nx = state.nx;
  const ny = state.ny;
  const src = ctx.getImageData(0, 0, W, H);
  if (!state.out || state.out.width !== W || state.out.height !== H) {
    state.out = ctx.createImageData(W, H);
  }
  const srcView = new Uint32Array(src.data.buffer);
  const out = state.out;
  const outView = new Uint32Array(out.data.buffer);
  const dxs = state.dx;
  const dys = state.dy;

  for (let y = 0; y < H; y++) {
    const gy = y / MOT_NODE;
    const j0 = Math.floor(gy);
    const ty = gy - j0;
    const j1 = j0 + 1 < ny ? j0 + 1 : j0;
    const row0 = j0 * nx;
    const row1 = j1 * nx;
    for (let x = 0; x < W; x++) {
      const gx = x / MOT_NODE;
      const i0 = Math.floor(gx);
      const tx = gx - i0;
      const i1 = i0 + 1 < nx ? i0 + 1 : i0;
      const a = row0 + i0;
      const b = row0 + i1;
      const c = row1 + i0;
      const d = row1 + i1;
      const ddx = (dxs[a] * (1 - tx) + dxs[b] * tx) * (1 - ty) + (dxs[c] * (1 - tx) + dxs[d] * tx) * ty;
      const ddy = (dys[a] * (1 - tx) + dys[b] * tx) * (1 - ty) + (dys[c] * (1 - tx) + dys[d] * tx) * ty;
      let sx = Math.round(x + ddx);
      let sy = Math.round(y + ddy);
      if (sx < 0) sx = 0; else if (sx >= W) sx = W - 1;
      if (sy < 0) sy = 0; else if (sy >= H) sy = H - 1;
      outView[y * W + x] = srcView[sy * W + sx];
    }
  }
  ctx.putImageData(out, 0, 0);
}

// Traces one streamline per snake from a seed on the subject, following the structure-tensor flow.
// Points are stored in canvas pixels in one flat array.
function motTrace(rc, state, count) {
  const { grid, W, H } = rc;
  const gw = grid.gw;
  const gh = grid.gh;
  const cellW = W / gw;
  const cellH = H / gh;
  if (!state.flow || state.flow.fx.length !== gw * gh) state.flow = createFlowBuffers(gw * gh);
  buildFlow(grid, state.flow);
  const fx = state.flow.fx;
  const fy = state.flow.fy;
  const ink = grid.ink;
  const pts = [];
  const start = new Int32Array(count);
  const lens = new Int32Array(count);
  const phase = new Float32Array(count);
  const rate = new Float32Array(count);

  for (let s = 0; s < count; s++) {
    // Seeds prefer darker cells, so the snakes gather on the subject.
    let seedX = 0;
    let seedY = 0;
    for (let tries = 0; tries < 6; tries++) {
      seedX = Math.floor(motHash(s * 2.3 + tries * 7.9 + 0.5) * gw);
      seedY = Math.floor(motHash(s * 3.1 + tries * 4.3 + 9.1) * gh);
      if (ink[seedY * gw + seedX] > 0.1 + 0.5 * motHash(s * 5.7 + tries * 1.3)) break;
    }
    let px = seedX + 0.5;
    let py = seedY + 0.5;
    let pvx = 0;
    let pvy = 0;
    const first = pts.length / 2;
    let n = 0;
    for (let st = 0; st < MOT_STEPS; st++) {
      const ix = Math.floor(px);
      const iy = Math.floor(py);
      if (ix < 0 || iy < 0 || ix >= gw || iy >= gh) break;
      const c = iy * gw + ix;
      let vx = fx[c];
      let vy = fy[c];
      // The field has no sign, so keep the direction continuous along the line.
      if (vx * pvx + vy * pvy < 0) {
        vx = -vx;
        vy = -vy;
      }
      px += vx * MOT_STEP;
      py += vy * MOT_STEP;
      pvx = vx;
      pvy = vy;
      pts.push(px * cellW, py * cellH);
      n++;
    }
    start[s] = first;
    lens[s] = n;
    phase[s] = motHash(s * 1.7 + 0.3) * (n + MOT_TAIL);
    rate[s] = MOT_RATE * (0.6 + 0.8 * motHash(s * 2.9 + 1.1));
  }
  return { pts: Float32Array.from(pts), start: start, lens: lens, phase: phase, rate: rate, count: count };
}

// Draws every snake as a tail with a head, in the ink colour, over the algorithm's output.
function motDrawSnakes(rc, sn, mv, time, scale, motion) {
  const { ctx, p, pal, data, k } = rc;
  const body = new Path2D();
  const heads = new Path2D();
  const pts = sn.pts;
  const useMotion = motion > 0 && !!data.motion;

  for (let s = 0; s < sn.count; s++) {
    const n = sn.lens[s];
    if (n < 8) continue;
    const period = n + MOT_TAIL;
    const head = (sn.phase[s] + sn.rate[s] * time) % period;
    const hi = Math.floor(head);
    const a = hi - MOT_TAIL > 0 ? hi - MOT_TAIL : 0;
    const b = hi < n - 1 ? hi : n - 1;
    if (a > b) continue;
    const o = sn.start[s] * 2;
    body.moveTo(pts[o + 2 * a], pts[o + 2 * a + 1]);
    for (let i = a + 1; i <= b; i++) body.lineTo(pts[o + 2 * i], pts[o + 2 * i + 1]);
    if (hi <= n - 1) {
      const hx = pts[o + 2 * hi];
      const hy = pts[o + 2 * hi + 1];
      let r = 3.2 * scale;
      if (useMotion) {
        // Video motion swells the snake heads where things move.
        sampleMotion(data, k, hx / CANVAS_SCALE, hy / CANVAS_SCALE, mv);
        r *= 1 + Math.min(2, mv[2] * 8 * motion);
      }
      heads.moveTo(hx + r, hy);
      heads.arc(hx, hy, r, 0, Math.PI * 2);
    }
  }

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = pal.strokeCss;
  ctx.fillStyle = pal.strokeCss;
  ctx.globalAlpha = 0.95;
  ctx.lineWidth = Math.max(1.2, 2.4 * clamp(p.thickness, 0.2, 1.6) * scale);
  ctx.stroke(body);
  ctx.fill(heads);
  ctx.restore();
}

// Lays the chosen motion over the frame the algorithm has just drawn.
// rc is the artwork render context; state is the layer's own persistent state.
export function applyMotionLayer(rc, type, state) {
  const p = rc.p;
  const scale = rc.W / 1920;
  const time = (rc.t || 0) * clamp(p.speed, 0, 3);
  const amount = clamp(p.velocity, 0, 3);
  const motion = clamp(p.motion, 0, 3);
  if (!state.mv) state.mv = new Float32Array(3);

  if (type === 'snake') {
    const count = clamp(Math.round(p.animCount), 20, 2000);
    const key = [rc.k, rc.W, rc.H, count, p.contrast, p.brightness, p.detail, p.edge].join('|');
    if (!state.snake || state.snake.key !== key) {
      state.snake = motTrace(rc, state, count);
      state.snake.key = key;
    }
    motDrawSnakes(rc, state.snake, state.mv, time, scale, motion);
    rc.elements = (rc.elements || 0) + state.snake.count;
    return;
  }

  motWaveField(rc, type, state, time, scale, amount, motion);
  motRemap(rc, state);
}
