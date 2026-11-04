// Block-based motion estimation and frame differencing.
// For each transition frame k -> k+1 and each BLOCK_SIZE x BLOCK_SIZE block of frame k,
// a three-step search finds the integer displacement (within +/-SEARCH_RADIUS) that
// minimises the sum of absolute differences in frame k+1. The zero-displacement
// mean absolute difference is stored as the block's frame-difference energy.
// Vectors are stored in quarter-pixel units (Int8), energy as Uint8.

export const BLOCK_SIZE = 16;
const SEARCH_RADIUS = 8;
const SUB = 2; // compare every 2nd pixel inside a block

// `scale` converts analysis-resolution results to display pixels (e.g. 2 when the
// frames were analysed at half size). Block size and vectors are returned scaled.
export function analyseMotion(frames, width, height, options) {
  const opts = options || {};
  const onProgress = opts.onProgress || null;
  const scale = opts.scale || 1;
  const bs = BLOCK_SIZE;
  const bw = Math.max(1, Math.floor(width / bs));
  const bh = Math.max(1, Math.floor(height / bs));
  const transitions = Math.max(0, frames.length - 1);
  const blocks = bw * bh;
  const vx = new Int8Array(transitions * blocks);
  const vy = new Int8Array(transitions * blocks);
  const diff = new Uint8Array(transitions * blocks);

  for (let k = 0; k < transitions; k++) {
    const A = frames[k];
    const B = frames[k + 1];
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        const x0 = bx * bs;
        const y0 = by * bs;
        const idx = (k * bh + by) * bw + bx;

        const zeroSad = blockSad(A, B, width, height, x0, y0, 0, 0, Infinity);
        diff[idx] = clampByte(Math.round((zeroSad / (bs * bs / (SUB * SUB))) * 4));

        let cx = 0;
        let cy = 0;
        let best = zeroSad;
        for (let step = 4; step >= 1; step >>= 1) {
          let bestX = cx;
          let bestY = cy;
          for (let oy = -1; oy <= 1; oy++) {
            for (let ox = -1; ox <= 1; ox++) {
              if (ox === 0 && oy === 0) continue;
              const nx = cx + ox * step;
              const ny = cy + oy * step;
              if (nx < -SEARCH_RADIUS || nx > SEARCH_RADIUS || ny < -SEARCH_RADIUS || ny > SEARCH_RADIUS) continue;
              const s = blockSad(A, B, width, height, x0, y0, nx, ny, best);
              if (s < best) {
                best = s;
                bestX = nx;
                bestY = ny;
              }
            }
          }
          cx = bestX;
          cy = bestY;
        }
        vx[idx] = clampSigned(Math.round(cx * scale * 4));
        vy[idx] = clampSigned(Math.round(cy * scale * 4));
      }
    }
    if (onProgress) onProgress((k + 1) / transitions);
  }

  return { bs: bs * scale, bw: bw, bh: bh, vx: vx, vy: vy, diff: diff };
}

// Sum of absolute differences for a block displaced by (dx, dy).
// Returns early once the running sum exceeds limit.
function blockSad(A, B, width, height, x0, y0, dx, dy, limit) {
  const bs = BLOCK_SIZE;
  if (x0 + dx < 0 || y0 + dy < 0 || x0 + dx + bs > width || y0 + dy + bs > height) {
    return Infinity;
  }
  let sad = 0;
  for (let y = 0; y < bs; y += SUB) {
    const rowA = (y0 + y) * width + x0;
    const rowB = (y0 + y + dy) * width + x0 + dx;
    for (let x = 0; x < bs; x += SUB) {
      const d = A[rowA + x] - B[rowB + x];
      sad += d < 0 ? -d : d;
    }
    if (sad > limit) return sad;
  }
  return sad;
}

function clampSigned(v) {
  return v < -127 ? -127 : (v > 127 ? 127 : v);
}

function clampByte(v) {
  return v < 0 ? 0 : (v > 255 ? 255 : v);
}
