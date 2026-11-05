// Colour profiles for the exports. A PNG or JPEG written from the canvas has no profile, so a viewer shows its values as
// sRGB. For a Rec. 709 or Display P3 export the values are encoded for that space, so the file carries an ICC profile
// that says so. This module builds the profiles (ICC version 2 matrix/TRC display profiles, with the colorants adapted
// to the D50 white that ICC uses) and inserts them into PNG and JPEG bytes.

import { rgbToXyz, matMul, matInv, mulVec, srgbEotf, bt709Eotf } from '../media/colour.js';

const D50 = [0.9642, 1.0, 0.8249];
const D65 = [0.95047, 1.0, 1.08883];
// Bradford cone response matrix, used to move the colorants from the D65 white to D50.
const BRADFORD = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];
const CURVE_POINTS = 1024;

const PROFILES = {
  rec709: { primaries: 'bt709', curve: 'bt709', description: 'Rec. 709 (JS Rusty)' },
  p3: { primaries: 'p3', curve: 'srgb', description: 'Display P3 (JS Rusty)' },
};

export const PROFILE_KINDS = Object.keys(PROFILES);

function bradfordD65ToD50() {
  const cone = mulVec(BRADFORD, D65);
  const target = mulVec(BRADFORD, D50);
  const scale = [target[0] / cone[0], 0, 0, 0, target[1] / cone[1], 0, 0, 0, target[2] / cone[2]];
  return matMul(matInv(BRADFORD), matMul(scale, BRADFORD));
}

// The colorants (the XYZ of each primary, adapted to D50) of a set of primaries.
function colorants(primaries) {
  const m = matMul(bradfordD65ToD50(), rgbToXyz(primaries));
  return {
    r: [m[0], m[3], m[6]],
    g: [m[1], m[4], m[7]],
    b: [m[2], m[5], m[8]],
  };
}

// s15Fixed16 (signed, 16 fractional bits), big-endian.
function s15(view, at, v) {
  view.setInt32(at, Math.round(v * 65536));
}

function xyzTag(xyz) {
  const data = new Uint8Array(20);
  const view = new DataView(data.buffer);
  data.set(ascii('XYZ '), 0);
  s15(view, 8, xyz[0]);
  s15(view, 12, xyz[1]);
  s15(view, 16, xyz[2]);
  return data;
}

// The TRC: a 'curv' table of the decoding curve (device value to linear light), sampled evenly over 0 to 1.
function curveTag(eotf) {
  const data = new Uint8Array(12 + 2 * CURVE_POINTS);
  const view = new DataView(data.buffer);
  data.set(ascii('curv'), 0);
  view.setUint32(8, CURVE_POINTS);
  for (let i = 0; i < CURVE_POINTS; i++) {
    const v = Math.max(0, Math.min(1, eotf(i / (CURVE_POINTS - 1))));
    view.setUint16(12 + 2 * i, Math.round(v * 65535));
  }
  return data;
}

// The 'desc' tag (ICC version 2 textDescriptionType). Only the ASCII name is filled in.
function descTag(text) {
  const ascii0 = ascii(text + '\0');
  const size = 12 + ascii0.length + 4 + 4 + 2 + 1 + 67;
  const data = new Uint8Array(size);
  const view = new DataView(data.buffer);
  data.set(ascii('desc'), 0);
  view.setUint32(8, ascii0.length);
  data.set(ascii0, 12);
  return data;
}

function ascii(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0x7f;
  return out;
}

// An ICC profile for one of PROFILES, as bytes.
export function buildIccProfile(kind) {
  const spec = PROFILES[kind];
  if (!spec) throw new Error('Unknown colour profile: ' + kind);
  const c = colorants(spec.primaries);
  const eotf = spec.curve === 'srgb' ? srgbEotf : bt709Eotf;
  const curve = curveTag(eotf);
  const white = xyzTag(D50);
  // Tags in the order they are written. The three curve tags share one copy of the table.
  const tags = [
    { sig: 'desc', data: descTag(spec.description) },
    { sig: 'wtpt', data: white },
    { sig: 'rXYZ', data: xyzTag(c.r) },
    { sig: 'gXYZ', data: xyzTag(c.g) },
    { sig: 'bXYZ', data: xyzTag(c.b) },
    { sig: 'rTRC', data: curve, shared: 'curve' },
    { sig: 'gTRC', data: curve, shared: 'curve' },
    { sig: 'bTRC', data: curve, shared: 'curve' },
  ];

  const tableAt = 128;
  const dataStart = tableAt + 4 + 12 * tags.length;
  let size = dataStart;
  const offsets = new Map();
  const placed = [];
  for (const tag of tags) {
    if (tag.shared && offsets.has(tag.shared)) {
      placed.push({ sig: tag.sig, offset: offsets.get(tag.shared), size: tag.data.length });
      continue;
    }
    const offset = size;
    if (tag.shared) offsets.set(tag.shared, offset);
    placed.push({ sig: tag.sig, offset: offset, size: tag.data.length, data: tag.data });
    size += tag.data.length + ((4 - (tag.data.length % 4)) % 4);
  }

  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setUint32(0, size);
  out.set(ascii('none'), 4);
  view.setUint32(8, 0x02100000); // version 2.1
  out.set(ascii('mntr'), 12); // display device
  out.set(ascii('RGB '), 16);
  out.set(ascii('XYZ '), 20);
  view.setUint16(24, 2026);
  view.setUint16(26, 11);
  view.setUint16(28, 5);
  out.set(ascii('acsp'), 36);
  s15(view, 68, D50[0]);
  s15(view, 72, D50[1]);
  s15(view, 76, D50[2]);

  view.setUint32(tableAt, tags.length);
  placed.forEach((p, i) => {
    const at = tableAt + 4 + 12 * i;
    out.set(ascii(p.sig), at);
    view.setUint32(at + 4, p.offset);
    view.setUint32(at + 8, p.size);
    if (p.data) out.set(p.data, p.offset);
  });
  return out;
}

// CRC-32 (PNG and zlib use the same polynomial).
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function concat(parts) {
  const size = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(ascii(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

// Adds an iCCP chunk to a PNG, right after IHDR. Chunks that describe the colour some other way (sRGB, gAMA, cHRM,
// an older iCCP) are dropped, because a PNG should carry one description. deflate(bytes) returns zlib-compressed bytes.
export async function insertPngIcc(png, profile, deflate) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  if (String.fromCharCode(...png.subarray(12, 16)) !== 'IHDR') throw new Error('Not a PNG file.');
  const ihdrEnd = 8 + 12 + view.getUint32(8);
  const kept = [png.subarray(0, ihdrEnd)];
  let at = ihdrEnd;
  const dropped = ['sRGB', 'gAMA', 'cHRM', 'iCCP'];
  while (at + 8 <= png.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const end = at + 12 + length;
    if (dropped.indexOf(type) < 0) kept.push(png.subarray(at, end));
    at = end;
  }
  const compressed = await deflate(profile);
  const payload = concat([ascii('ICC profile'), new Uint8Array([0, 0]), compressed]);
  const iccp = pngChunk('iCCP', payload);
  return concat([kept[0], iccp, ...kept.slice(1)]);
}

// Adds an ICC profile to a JPEG as APP2 segments (one segment: the profile is well under 64 KB). The segment goes after
// the SOI marker, and after a JFIF APP0 segment if there is one.
export function insertJpegIcc(jpeg, profile) {
  const header = concat([ascii('ICC_PROFILE'), new Uint8Array([0, 1, 1])]);
  const payloadLength = header.length + profile.length + 2;
  if (payloadLength > 65535) throw new Error('The colour profile is too large for a JPEG segment.');
  const segment = concat([
    new Uint8Array([0xff, 0xe2, payloadLength >> 8, payloadLength & 0xff]),
    header,
    profile,
  ]);
  let at = 2;
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) at = 4 + ((jpeg[4] << 8) | jpeg[5]);
  return concat([jpeg.subarray(0, at), segment, jpeg.subarray(at)]);
}
