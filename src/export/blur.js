// Blur for exported pixels. Three box-blur passes per axis approximate a Gaussian. The radius is in
// pixels of the image being blurred, and a radius below 1 leaves the pixels unchanged. The blur works in
// place on RGBA data (Uint8ClampedArray) with one scratch buffer per call, and edges are clamped.

export function blurRGBA(rgba, w, h, radius) {
  const r = Math.round(radius);
  if (!(r >= 1) || w < 1 || h < 1) return rgba;
  const tmp = new Uint8ClampedArray(rgba.length);
  for (let pass = 0; pass < 3; pass++) {
    boxPassX(rgba, tmp, w, h, r);
    boxPassY(tmp, rgba, w, h, r);
  }
  return rgba;
}

function clampIndex(i, n) {
  return i < 0 ? 0 : (i >= n ? n - 1 : i);
}

// Horizontal box blur from src to dst, using running sums.
function boxPassX(src, dst, w, h, r) {
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let x = -r; x <= r; x++) sum += src[row + clampIndex(x, w) * 4 + c];
      for (let x = 0; x < w; x++) {
        dst[row + x * 4 + c] = sum * inv;
        sum += src[row + clampIndex(x + r + 1, w) * 4 + c] - src[row + clampIndex(x - r, w) * 4 + c];
      }
    }
  }
}

// Vertical box blur from src to dst, using running sums.
function boxPassY(src, dst, w, h, r) {
  const inv = 1 / (2 * r + 1);
  const stride = w * 4;
  for (let x = 0; x < w; x++) {
    const col = x * 4;
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let y = -r; y <= r; y++) sum += src[clampIndex(y, h) * stride + col + c];
      for (let y = 0; y < h; y++) {
        dst[y * stride + col + c] = sum * inv;
        sum += src[clampIndex(y + r + 1, h) * stride + col + c] - src[clampIndex(y - r, h) * stride + col + c];
      }
    }
  }
}
