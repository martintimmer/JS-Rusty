// Colour for the video pipeline: transfer curves (sRGB, Rec. 709, HLG, PQ), primaries (Rec. 709, Rec. 2020, Display P3),
// YUV to RGB for 8 and 10-bit 4:2:0 frames, and conversions into sRGB (the preview), Rec. 709 or Display P3 (exports).
// Pure functions, no DOM, so the maths can be tested on its own.
//
// Terms. An encoded value is what a file or a picture stores, from 0 to 1. A linear value is light: 1 is SDR reference
// white. The app's colours (the canvas, the palettes) are sRGB-encoded. A source is converted to that for the preview.
// HDR (HLG or PQ) is mapped to SDR white with the BT.2408 convention: HLG's 75% signal is 203 nits, the SDR white.

export const COLOUR_OPTIONS = ['srgb', 'rec709', 'p3'];

const LUT_N = 4096;
// Linear values above this are not representable. HDR highlights are shouldered down to 1 before they reach it.
const LIN_MAX = 8;
const SDR_WHITE_NITS = 203;
const HLG_PEAK_NITS = 1000;
const HLG_SCALE = HLG_PEAK_NITS / SDR_WHITE_NITS;
// HLG's system gamma (BT.2100, 1000 nits): display light = scene light * Y^(gamma - 1).
const HLG_OOTF_EXPONENT = 0.2;
// Highlights above this linear level roll off smoothly toward 1 instead of clipping. At 0.9, HLG's 75% signal (SDR white)
// lands at about 251 rather than 246: the research on BT.2408 puts SDR white at 75%, so less headroom is taken from it.
const SHOULDER_KNEE = 0.9;

const D65 = [0.3127, 0.329];
const PRIMARIES = {
  bt709: { r: [0.64, 0.33], g: [0.3, 0.6], b: [0.15, 0.06] },
  bt2020: { r: [0.708, 0.292], g: [0.17, 0.797], b: [0.131, 0.046] },
  // Display P3: the DCI-P3 primaries with the D65 white, and the sRGB curve.
  p3: { r: [0.68, 0.32], g: [0.265, 0.69], b: [0.15, 0.06] },
  // DCI-P3, the cinema primaries, with the DCI white (x 0.314, y 0.351). Converted to D65 by Bradford adaptation, so a
  // DCI-P3 source maps to the same white as the others. Used for a source tagged DCI-P3 (SMPTE 431).
  'dci-p3': { r: [0.68, 0.32], g: [0.265, 0.69], b: [0.15, 0.06], white: [0.314, 0.351] },
};
// Bradford cone response matrix, used to adapt one white point to another.
const BRADFORD = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];

// Where each output colour option sends its primaries and curve.
const TARGETS = {
  srgb: { primaries: 'bt709', transfer: 'srgb' },
  rec709: { primaries: 'bt709', transfer: 'bt709' },
  p3: { primaries: 'p3', transfer: 'srgb' },
};

// ---------- Transfer curves ----------

export function srgbEotf(v) {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
export function srgbOetf(l) {
  return l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
}
export function bt709Eotf(v) {
  return v < 0.081 ? v / 4.5 : Math.pow((v + 0.099) / 1.099, 1 / 0.45);
}
export function bt709Oetf(l) {
  return l < 0.018 ? 4.5 * l : 1.099 * Math.pow(l, 0.45) - 0.099;
}
// HLG (ITU-R BT.2100): signal to scene light, 0 to 1.
const HLG_A = 0.17883277;
const HLG_B = 0.28466892;
const HLG_C = 0.55991073;
export function hlgEotf(v) {
  return v <= 0.5 ? (v * v) / 3 : (Math.exp((v - HLG_C) / HLG_A) + HLG_B) / 12;
}
// PQ (SMPTE ST 2084): signal to light relative to 10000 nits.
export function pqEotf(v) {
  const m1 = 0.1593017578125;
  const m2 = 78.84375;
  const c1 = 0.8359375;
  const c2 = 18.8515625;
  const c3 = 18.6875;
  const p = Math.pow(Math.max(v, 0), 1 / m2);
  return Math.pow(Math.max(p - c1, 0) / (c2 - c3 * p), 1 / m1);
}
// Smooth roll-off above the knee: continuous with the straight line, and it approaches 1 but never reaches it.
export function shoulder(l) {
  if (l <= SHOULDER_KNEE) return l;
  return SHOULDER_KNEE + (1 - SHOULDER_KNEE) * (1 - Math.exp(-(l - SHOULDER_KNEE) / (1 - SHOULDER_KNEE)));
}

function decodeFn(transfer) {
  switch (transfer) {
    case 'srgb': return srgbEotf;
    case 'linear': return (v) => v;
    case 'hlg': return hlgEotf;
    case 'pq': return (v) => (pqEotf(v) * 10000) / SDR_WHITE_NITS;
    default: return bt709Eotf;
  }
}
function encodeFn(transfer) {
  return transfer === 'srgb' ? srgbOetf : bt709Oetf;
}

// ---------- Matrices ----------

export function matMul(a, b) {
  const c = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      for (let k = 0; k < 3; k++) c[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
    }
  }
  return c;
}
export function matInv(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ];
}
export function mulVec(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}
// The Bradford matrix that moves XYZ from one white point to another (both XYZ, white at Y = 1).
function bradfordAdapt(srcWhite, dstWhite) {
  const rs = mulVec(BRADFORD, srcWhite);
  const rd = mulVec(BRADFORD, dstWhite);
  const scale = [rd[0] / rs[0], 0, 0, 0, rd[1] / rs[1], 0, 0, 0, rd[2] / rs[2]];
  return matMul(matInv(BRADFORD), matMul(scale, BRADFORD));
}

// Linear RGB to CIE XYZ (white at Y = 1), adapted to the D65 white, for a set of primaries.
export function rgbToXyz(name) {
  const p = PRIMARIES[name];
  const column = (x, y) => [x / y, 1, (1 - x - y) / y];
  const R = column(p.r[0], p.r[1]);
  const G = column(p.g[0], p.g[1]);
  const B = column(p.b[0], p.b[1]);
  // The primaries are scaled to their own white (D65, or the DCI white for DCI-P3).
  const white = p.white || D65;
  const W = column(white[0], white[1]);
  const s = mulVec(matInv([R[0], G[0], B[0], R[1], G[1], B[1], R[2], G[2], B[2]]), W);
  const m = [
    R[0] * s[0], G[0] * s[1], B[0] * s[2],
    R[1] * s[0], G[1] * s[1], B[1] * s[2],
    R[2] * s[0], G[2] * s[1], B[2] * s[2],
  ];
  if (!p.white) return m;
  // Adapt the DCI white to D65, so the result is comparable with the other primaries.
  return matMul(bradfordAdapt(W, column(D65[0], D65[1])), m);
}
// Linear RGB of one primaries set to linear RGB of another (both with the D65 white).
export function primariesMatrix(from, to) {
  return matMul(matInv(rgbToXyz(to)), rgbToXyz(from));
}

// ---------- Converters ----------

// A converter takes encoded RGB (0 to 1, per channel) from a source and writes sRGB, Rec. 709 or Display P3 bytes.
// src: { primaries: 'bt709' | 'bt2020' | 'p3', transfer: 'srgb' | 'bt709' | 'linear' | 'hlg' | 'pq' }.
// Unknown names are treated as Rec. 709, the usual default for a video without tags.
export function createConverter(src, target) {
  const dst = TARGETS[target] || TARGETS.srgb;
  const primaries = PRIMARIES[src.primaries] ? src.primaries : 'bt709';
  const transfer = ['srgb', 'bt709', 'linear', 'hlg', 'pq'].indexOf(src.transfer) >= 0 ? src.transfer : 'bt709';
  const hlg = transfer === 'hlg';
  const hdr = hlg || transfer === 'pq';

  const decode = decodeFn(transfer);
  const decodeLut = new Float64Array(LUT_N);
  for (let i = 0; i < LUT_N; i++) decodeLut[i] = decode(i / (LUT_N - 1));

  const m = primariesMatrix(primaries, dst.primaries);
  const luma = rgbToXyz(primaries).slice(3, 6);

  // Linear to encoded, indexed by a square-root warp of the linear value, so the dark end keeps its steps.
  const encode = encodeFn(dst.transfer);
  const encodeLut = new Uint8Array(LUT_N);
  for (let k = 0; k < LUT_N; k++) {
    const u = k / (LUT_N - 1);
    const lin = u * u * LIN_MAX;
    const v = encode(hdr ? shoulder(lin) : lin);
    encodeLut[k] = Math.max(0, Math.min(255, Math.round(255 * v)));
  }
  const linIndex = (lin) => {
    if (!(lin > 0)) return 0;
    if (lin >= LIN_MAX) return LUT_N - 1;
    return Math.round(Math.sqrt(lin / LIN_MAX) * (LUT_N - 1));
  };
  const encIndex = (v) => {
    if (!(v > 0)) return 0;
    if (v >= 1) return LUT_N - 1;
    return Math.round(v * (LUT_N - 1));
  };

  return {
    target: target,
    // r, g, b: encoded source values from 0 to 1. Writes three bytes at out[o].
    rgb(r, g, b, out, o) {
      let R = decodeLut[encIndex(r)];
      let G = decodeLut[encIndex(g)];
      let B = decodeLut[encIndex(b)];
      if (hlg) {
        // The OOTF turns scene light into display light, and the 1000 to 203 nit scale puts HLG white at 1.
        const ys = luma[0] * R + luma[1] * G + luma[2] * B;
        const f = ys > 0 ? Math.pow(ys, HLG_OOTF_EXPONENT) * HLG_SCALE : 0;
        R *= f;
        G *= f;
        B *= f;
      }
      const rl = m[0] * R + m[1] * G + m[2] * B;
      const gl = m[3] * R + m[4] * G + m[5] * B;
      const bl = m[6] * R + m[7] * G + m[8] * B;
      out[o] = encodeLut[linIndex(rl)];
      out[o + 1] = encodeLut[linIndex(gl)];
      out[o + 2] = encodeLut[linIndex(bl)];
    },
    // Converts sRGB-encoded RGBA bytes in place (alpha is kept).
    rgbaInPlace(rgba) {
      for (let j = 0; j < rgba.length; j += 4) {
        this.rgb(rgba[j] / 255, rgba[j + 1] / 255, rgba[j + 2] / 255, rgba, j);
      }
      return rgba;
    },
  };
}

// The converter from sRGB (what the app paints) to an export colour space, or null for sRGB itself.
export function exportConverter(target) {
  if (target === 'srgb' || !TARGETS[target]) return null;
  return createConverter({ primaries: 'bt709', transfer: 'srgb' }, target);
}

// ---------- YUV frames ----------

const LUMA_COEFFS = { bt2020: [0.2627, 0.0593], bt709: [0.2126, 0.0722], bt601: [0.299, 0.114] };

// Converts a decoded 4:2:0 frame to RGBA bytes in the converter's target space.
// frame: { width, height, bitDepth (8 or 10), layout ('I420' or 'NV12'), fullRange, matrix ('bt2020'|'bt709'|'bt601'),
//          planes: [Y, U, V] (I420) or [Y, UV] (NV12), each { data: Uint8Array, offset, stride } in bytes }
export function yuvToRgba(frame, converter) {
  const W = frame.width;
  const H = frame.height;
  const wide = frame.bitDepth > 8;
  const bps = wide ? 2 : 1;
  const shift = frame.bitDepth - 8;
  const [kr, kb] = LUMA_COEFFS[frame.matrix] || LUMA_COEFFS.bt709;
  const kg = 1 - kr - kb;
  const maxv = (1 << frame.bitDepth) - 1;
  const half = 1 << (frame.bitDepth - 1);
  const yScale = frame.fullRange ? maxv : 219 * (1 << shift);
  const yOffset = frame.fullRange ? 0 : 16 * (1 << shift);
  const cScale = frame.fullRange ? maxv : 224 * (1 << shift);
  const nv12 = frame.layout === 'NV12';
  const sample = (p, at) => (wide ? p.data[at] | (p.data[at + 1] << 8) : p.data[at]);
  const Y = frame.planes[0];
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const cy = y >> 1;
    for (let x = 0; x < W; x++) {
      const cx = x >> 1;
      const yCode = sample(Y, Y.offset + y * Y.stride + x * bps);
      let cbCode;
      let crCode;
      if (nv12) {
        const uv = frame.planes[1];
        const at = uv.offset + cy * uv.stride + cx * 2 * bps;
        cbCode = sample(uv, at);
        crCode = sample(uv, at + bps);
      } else {
        const U = frame.planes[1];
        const V = frame.planes[2];
        cbCode = sample(U, U.offset + cy * U.stride + cx * bps);
        crCode = sample(V, V.offset + cy * V.stride + cx * bps);
      }
      const yp = (yCode - yOffset) / yScale;
      const cb = (cbCode - half) / cScale;
      const cr = (crCode - half) / cScale;
      const rp = yp + 2 * (1 - kr) * cr;
      const bp = yp + 2 * (1 - kb) * cb;
      const gp = (yp - kr * rp - kb * bp) / kg;
      const j = (y * W + x) * 4;
      converter.rgb(clamp01(rp), clamp01(gp), clamp01(bp), out, j);
      out[j + 3] = 255;
    }
  }
  return out;
}

function clamp01(v) {
  return v < 0 ? 0 : (v > 1 ? 1 : v);
}

// ---------- Tags and names ----------

// Names for the numbers in an MP4 'colr' box (ISO/IEC 23001-8 and 23091-2 code points).
const COLR_PRIMARIES = { 1: 'bt709', 9: 'bt2020', 11: 'dci-p3', 12: 'p3' };
const COLR_TRANSFER = { 1: 'bt709', 8: 'linear', 13: 'srgb', 16: 'pq', 18: 'hlg' };
const COLR_MATRIX = { 0: 'rgb', 1: 'bt709', 5: 'bt601', 6: 'bt601', 9: 'bt2020' };

export function tagsFromColr(colr) {
  return {
    primaries: COLR_PRIMARIES[colr.primaries] || 'unknown',
    transfer: COLR_TRANSFER[colr.transfer] || 'unknown',
    matrix: COLR_MATRIX[colr.matrix] || 'unknown',
    fullRange: !!colr.fullRange,
  };
}

// Tags from a WebCodecs VideoFrame.colorSpace (strings from the WebCodecs registry).
export function tagsFromColorSpace(cs) {
  const primaries = { bt709: 'bt709', bt2020: 'bt2020', smpte432: 'p3', smpte431: 'dci-p3' }[cs.primaries] || 'unknown';
  const transfer = {
    bt709: 'bt709', smpte170m: 'bt709', 'iec61966-2-1': 'srgb', linear: 'linear', hlg: 'hlg', pq: 'pq',
  }[cs.transfer] || 'unknown';
  const matrix = {
    bt709: 'bt709', 'bt2020-ncl': 'bt2020', smpte170m: 'bt601', bt470bg: 'bt601', rgb: 'rgb',
  }[cs.matrix] || 'unknown';
  return { primaries: primaries, transfer: transfer, matrix: matrix, fullRange: !!cs.fullRange };
}

// True when the source is HDR (HLG or PQ) or wider than Rec. 709: it needs the colour pipeline for an sRGB preview.
export function needsColourPipeline(tags) {
  return !!tags && (tags.transfer === 'hlg' || tags.transfer === 'pq' || tags.primaries === 'bt2020');
}

const PRIMARY_NAMES = { bt709: 'Rec. 709', bt2020: 'Rec. 2020', p3: 'Display P3', 'dci-p3': 'DCI-P3' };
const TRANSFER_NAMES = { bt709: 'Rec. 709 curve', srgb: 'sRGB curve', linear: 'linear', hlg: 'HLG (HDR)', pq: 'PQ (HDR)' };

// A short description of a source's colour, for the info panel: "Rec. 2020 · HLG (HDR)".
export function describeTags(tags) {
  if (!tags) return 'Untagged';
  if (tags.primaries === 'unknown' && tags.transfer === 'unknown') return 'Untagged (Rec. 709 assumed)';
  const parts = [];
  parts.push(PRIMARY_NAMES[tags.primaries] || 'Untagged primaries');
  parts.push(TRANSFER_NAMES[tags.transfer] || 'Untagged curve');
  return parts.join(' · ');
}
