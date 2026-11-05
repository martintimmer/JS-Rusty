// Reads the codec, bit depth and colour tags of a video file from its MP4 or QuickTime boxes, without decoding it. The
// file is read a box at a time, and only the 'moov' box (the index of the clip) is read whole, so a large clip costs
// little. iPhone clips are HEVC with an 'nclx' colour box (Rec. 2020, HLG) and a 10-bit 'hvcC' record.

import { tagsFromColr } from './colour.js';

const CODEC_NAMES = { avc1: 'H.264', avc3: 'H.264', hvc1: 'HEVC', hev1: 'HEVC', av01: 'AV1', vp09: 'VP9', mp4v: 'MPEG-4' };
const CONTAINERS = ['moov', 'trak', 'mdia', 'minf', 'stbl'];

// { codec, bitDepth, primaries, transfer, matrix, fullRange } for the first video track, or null when the file has none.
// Tags the file does not state are 'unknown'. A browser can then still play the clip, but the pipeline assumes Rec. 709.
export async function probeVideoColour(file) {
  if (!file || typeof file.slice !== 'function') return null;
  let pos = 0;
  while (pos + 8 <= file.size) {
    const head = await readView(file, pos, Math.min(16, file.size - pos));
    let size = head.getUint32(0);
    const type = fourcc(head, 4);
    let headerSize = 8;
    if (size === 1) {
      size = Number(head.getBigUint64(8));
      headerSize = 16;
    } else if (size === 0) {
      size = file.size - pos;
    }
    if (size < headerSize) return null;
    if (type === 'moov') {
      const moov = await readView(file, pos + headerSize, size - headerSize);
      return findVideoTrack(moov, 0, moov.byteLength);
    }
    pos += size;
  }
  return null;
}

function readView(file, start, length) {
  return file.slice(start, start + length).arrayBuffer().then((buf) => new DataView(buf));
}

function fourcc(dv, at) {
  return String.fromCharCode(dv.getUint8(at), dv.getUint8(at + 1), dv.getUint8(at + 2), dv.getUint8(at + 3));
}

// The boxes between start and end: { type, start (of the payload), end }.
function* boxes(dv, start, end) {
  let pos = start;
  while (pos + 8 <= end) {
    let size = dv.getUint32(pos);
    const type = fourcc(dv, pos + 4);
    let headerSize = 8;
    if (size === 1 && pos + 16 <= end) {
      size = Number(dv.getBigUint64(pos + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < headerSize || pos + size > end) return;
    yield { type: type, start: pos + headerSize, end: pos + size };
    pos += size;
  }
}

function findVideoTrack(dv, start, end) {
  for (const box of boxes(dv, start, end)) {
    if (CONTAINERS.indexOf(box.type) >= 0) {
      const found = findVideoTrack(dv, box.start, box.end);
      if (found) return found;
    } else if (box.type === 'stsd') {
      // Full box header (4 bytes of version and flags) and the entry count (4 bytes), then the sample entries.
      for (const entry of boxes(dv, box.start + 8, box.end)) {
        const info = visualEntry(dv, entry);
        if (info) return info;
      }
    }
  }
  return null;
}

// A visual sample entry: 78 bytes of fields, then the child boxes (colr, hvcC, av1C, vpcC, avcC).
function visualEntry(dv, entry) {
  const codec = entry.type;
  if (!CODEC_NAMES[codec]) return null;
  let colr = null;
  let bitDepth = 8;
  for (const child of boxes(dv, entry.start + 78, entry.end)) {
    if (child.type === 'colr' && fourcc(dv, child.start) === 'nclx') {
      colr = {
        primaries: dv.getUint16(child.start + 4),
        transfer: dv.getUint16(child.start + 6),
        matrix: dv.getUint16(child.start + 8),
        fullRange: (dv.getUint8(child.start + 10) & 0x80) !== 0,
      };
    } else if (child.type === 'hvcC') {
      // Byte 17 of the HEVC decoder configuration: bit_depth_luma_minus8 in its low three bits.
      bitDepth = (dv.getUint8(child.start + 17) & 0x07) + 8;
    } else if (child.type === 'av1C') {
      // Byte 2: high_bitdepth (bit 6) and twelve_bit (bit 5).
      const b = dv.getUint8(child.start + 2);
      bitDepth = (b & 0x40) ? ((b & 0x20) ? 12 : 10) : 8;
    } else if (child.type === 'vpcC') {
      // A full box: after version and flags, the profile, the level, then bit depth in the top four bits.
      bitDepth = dv.getUint8(child.start + 6) >> 4 || 8;
    }
  }
  const tags = colr ? tagsFromColr(colr) : { primaries: 'unknown', transfer: 'unknown', matrix: 'unknown', fullRange: false };
  return Object.assign({ codec: CODEC_NAMES[codec], bitDepth: bitDepth }, tags);
}
