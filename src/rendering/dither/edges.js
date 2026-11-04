import { smoothstep } from '../core.js';

// Edge detection for edge-aware error diffusion (Edge preservation).
// Strength per cell, 0-1, from the central-difference gradient of the tone. A hard step between
// paper and ink gives about 0.5 per axis, so it reaches 1 on the edge; flat areas give 0.
// Cost: one pass over the grid, and only when Edge preservation is above zero.
export function dtEdgeMap(tone, gw, gh, out) {
  for (let y = 0; y < gh; y++) {
    const row = y * gw;
    const up = (y > 0 ? y - 1 : 0) * gw;
    const down = (y < gh - 1 ? y + 1 : gh - 1) * gw;
    for (let x = 0; x < gw; x++) {
      const left = x > 0 ? x - 1 : 0;
      const right = x < gw - 1 ? x + 1 : gw - 1;
      const gx = (tone[row + right] - tone[row + left]) * 0.5;
      const gy = (tone[down + x] - tone[up + x]) * 0.5;
      out[row + x] = smoothstep(0.05, 0.25, Math.sqrt(gx * gx + gy * gy));
    }
  }
}
