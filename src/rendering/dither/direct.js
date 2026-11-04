import { dtRunOrdered } from './quantize.js';

// Direct quantisation: no dithering. Every cell takes the nearest tonal level or palette colour, so the picture is
// posterised, with flat areas and hard steps between tones. The threshold is one half everywhere, so Dither
// strength has no effect on this method.

const DIRECT_MATRIX = Float32Array.of(0.5);

export function ditherNone(env) {
  dtRunOrdered(env, DIRECT_MATRIX, 1);
}
