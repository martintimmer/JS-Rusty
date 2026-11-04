import { clamp, lerp } from '../core.js';
import { dtResolveColourSet } from './palettes.js';

// Dither settings: reads the dt* parameters (defaults in rendering/core.js) and clamps them to their
// ranges. The palette is resolved by palettes.js, which caches it, so dragging a slider does not rebuild
// palettes.

// Dithering algorithms, in sidebar order.
export const DT_METHODS = ['atkinson', 'floyd-steinberg', 'jjn', 'bayer', 'blue-noise'];
// Methods that diffuse error. Serpentine scan, diffusion strength and edge preservation apply only to these.
export const DT_DIFFUSION_METHODS = ['atkinson', 'floyd-steinberg', 'jjn'];
// Tonal level counts offered for the paper-and-ink ramp.
export const DT_LEVEL_STEPS = [2, 3, 4, 8, 16];
// Dither cell size in canvas pixels (Grid size).
export const DT_CELL_PX_MIN = 1;
export const DT_CELL_PX_MAX = 16;

function num(v, fallback) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function pct(v, fallback) {
  return clamp(num(v, fallback), 0, 100) / 100;
}

// Nearest allowed level count to v (ties go to the lower count).
function nearestLevelStep(v) {
  let best = DT_LEVEL_STEPS[0];
  for (let s = 1; s < DT_LEVEL_STEPS.length; s++) {
    const step = DT_LEVEL_STEPS[s];
    if (Math.abs(step - v) < Math.abs(best - v)) best = step;
  }
  return best;
}

// Resolves every dt* parameter for one frame.
//   method        one of DT_METHODS (unknown values fall back to atkinson)
//   diffusion     true for the error-diffusion methods
//   colours       palette colour set (see palettes.js) or null for paper-and-ink
//   levels        tonal levels: the ramp length, or the colour count of a palette
//   gain          tone gain from Density (the original dither contrast)
//   threshold     global threshold, 0-1
//   adaptive      adaptive threshold strength, 0-1
//   edge          edge preservation, 0-1
//   gamma         midtone gamma (1 = unchanged)
//   noise         grain amplitude, 0-1 (re-rolled on every rendered frame)
//   invert        swap light and dark
//   cellPx        dither cell size in canvas pixels, 1-16 (Grid size)
//   strength      diffusion strength, 0-1 (used as a kernel multiplier)
//   serpentine    alternate scan direction
//   temporal      temporal stability, 0-1
export function dtResolveSettings(p) {
  const method = DT_METHODS.indexOf(p.dtMethod) >= 0 ? p.dtMethod : 'atkinson';
  const colours = dtResolveColourSet(p.dtPalette, p.dtColours);
  const levels = colours ? colours.count : nearestLevelStep(num(p.dtLevels, 2));
  const gamma = clamp(num(p.dtGamma, 1), 0.2, 4);
  const cellPx = clamp(Math.round(num(p.dtGrid, 2)), DT_CELL_PX_MIN, DT_CELL_PX_MAX);
  return {
    method: method,
    diffusion: DT_DIFFUSION_METHODS.indexOf(method) >= 0,
    colours: colours,
    levels: levels,
    gain: lerp(0.8, 1.6, clamp(num(p.density, 75), 0, 100) / 100),
    threshold: pct(p.dtThreshold, 50),
    adaptive: pct(p.dtAdaptive, 0),
    edge: pct(p.dtEdge, 0),
    gamma: gamma,
    noise: pct(p.dtNoise, 0),
    invert: p.dtInvert === true,
    cellPx: cellPx,
    strength: pct(p.dtDiffusion, 100),
    serpentine: p.dtSerpentine === true,
    temporal: pct(p.dtTemporal, 0),
  };
}
