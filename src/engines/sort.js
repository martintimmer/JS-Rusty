import { clamp, lerp, CELL_PX } from '../rendering/core.js';
import { mfActive, MOTION_BASE } from '../rendering/motion-field.js';

// Pixel sorting (glitch art, after Kim Asendorf's popularisation of the technique).
// Within each row (or column), runs of pixels whose luminance falls in a band are sorted
// ascending, so dark values gather on one side of the run and light values on the other.
// The band is set by Detail (lower edge) and Density (upper edge). Direction follows the
// Flow direction slider: near 90 or 270 degrees sorts columns, otherwise rows.
// Runs on the analysis grid (2 px cells at 1080p), and each run is sorted natively.

export function renderSort(rc) {
  const { ctx, W, H, grid, p, pal, state } = rc;
  const gw = grid.gw;
  const gh = grid.gh;
  const n = gw * gh;
  if (!state.sorted || state.sorted.length !== n) {
    state.sorted = new Float32Array(n);
    state.run = new Float32Array(Math.max(gw, gh));
  }
  if (!state.img || state.img.width !== W || state.img.height !== H) {
    state.img = ctx.createImageData(W, H);
  }
  const src = grid.lum;
  const dst = state.sorted;
  dst.set(src);

  let lo = lerp(20, 120, clamp(p.detail, 0, 100) / 100);
  let hi = lerp(140, 250, clamp(p.density, 0, 100) / 100);
  if (mfActive(rc, 'pulse')) {
    // Pulse: the luminance band slides up and down, so the runs that get sorted move through the picture. Both edges
    // move together, so the band keeps its width.
    const shift = 40 * rc.motion.amount * Math.sin(2 * Math.PI * rc.motion.freq(MOTION_BASE.pulse) * rc.motion.time);
    lo = clamp(lo + shift, 0, 255);
    hi = clamp(hi + shift, 0, 255);
  }
  const dir = ((p.direction % 180) + 180) % 180;
  const vertical = dir > 45 && dir < 135;
  const lines = vertical ? gw : gh;
  const len = vertical ? gh : gw;
  const run = state.run;

  for (let li = 0; li < lines; li++) {
    let q = 0;
    while (q < len) {
      let m = 0;
      const start = q;
      while (q < len) {
        const idx = vertical ? q * gw + li : li * gw + q;
        const v = src[idx];
        if (v < lo || v > hi) break;
        run[m++] = v;
        q++;
      }
      if (m > 1) {
        const sub = run.subarray(0, m);
        sub.sort();
        for (let j = 0; j < m; j++) {
          const idx = vertical ? (start + j) * gw + li : li * gw + (start + j);
          dst[idx] = sub[j];
        }
      }
      q++; // the pixel that ended the run is outside the band; step past it
    }
  }

  // Paint from the sorted luminance: darker is more ink.
  const out = state.img.data;
  const bg = pal.bg;
  const ink = pal.stroke;
  for (let y = 0; y < H; y++) {
    const gy = Math.min(gh - 1, Math.floor(y / CELL_PX));
    for (let x = 0; x < W; x++) {
      const gx = Math.min(gw - 1, Math.floor(x / CELL_PX));
      const darkness = 1 - dst[gy * gw + gx] / 255;
      const o = (y * W + x) * 4;
      out[o] = bg[0] + (ink[0] - bg[0]) * darkness;
      out[o + 1] = bg[1] + (ink[1] - bg[1]) * darkness;
      out[o + 2] = bg[2] + (ink[2] - bg[2]) * darkness;
      out[o + 3] = 255;
    }
  }
  ctx.putImageData(state.img, 0, 0);
  rc.elements = n;
}
