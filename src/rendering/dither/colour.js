// Colour helpers for the palette system. Colours are kept as sRGB (0-1), which is how the palette
// presets are written and how the renderer paints them. Blending happens in linear light, and colour
// distances are measured in OKLab (Björn Ottosson, 2020), which is close to perceptually uniform. So
// "nearest" means nearest by eye. Nothing here allocates per call: results go into a caller's Float32Array(3).

export function dtSrgbToLinearExact(v) {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

// sRGB to linear light, sampled at 1025 points over 0-1. Used per pixel, so it is a lookup, not a power.
const DT_LINEAR_LUT = new Float32Array(1025);
for (let i = 0; i <= 1024; i++) DT_LINEAR_LUT[i] = dtSrgbToLinearExact(i / 1024);

export function dtSrgbToLinear(v) {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  const x = v * 1024;
  const i = Math.floor(x);
  const f = x - i;
  return DT_LINEAR_LUT[i] + (DT_LINEAR_LUT[i + 1] - DT_LINEAR_LUT[i]) * f;
}

// Linear RGB to OKLab. Writes L, a, b to out[0..2].
export function dtOklabFromLinear(r, g, b, out) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  out[0] = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  out[1] = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  out[2] = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
}

// sRGB (0-1) to OKLab. Writes L, a, b to out[0..2].
export function dtOklabFromSrgb(r, g, b, out) {
  dtOklabFromLinear(dtSrgbToLinear(r), dtSrgbToLinear(g), dtSrgbToLinear(b), out);
}
