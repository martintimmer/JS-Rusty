// GIF89a encoder (no dependencies). Writes a global 256-colour palette, one or more full
// indexed frames with LZW compression, and a NETSCAPE2.0 loop extension for animations.
// Frames are full-size (no inter-frame optimisation), which keeps the encoder simple.

const GIF_MIN_CODE_SIZE = 8;
const GIF_CLEAR = 1 << GIF_MIN_CODE_SIZE;
const GIF_END = GIF_CLEAR + 1;
const GIF_HASH_BITS = 13;
const GIF_HASH_SIZE = 1 << GIF_HASH_BITS;
const GIF_HASH_MASK = GIF_HASH_SIZE - 1;
const GIF_MAX_CODES = 4094; // reset the dictionary before it reaches 4096 entries

// LZW-compresses one frame of palette indices (Uint8Array). Returns a plain array of bytes.
export function gifLzw(indices) {
  const hKeys = new Int32Array(GIF_HASH_SIZE);
  const hVals = new Int32Array(GIF_HASH_SIZE);
  const out = [];
  let bitBuf = 0;
  let bitCount = 0;
  let codeSize = GIF_MIN_CODE_SIZE + 1;
  let nextCode = 0;

  const emit = (code) => {
    bitBuf |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      out.push(bitBuf & 255);
      bitBuf >>>= 8;
      bitCount -= 8;
    }
  };
  const resetDictionary = () => {
    hKeys.fill(-1);
    nextCode = GIF_END + 1;
    codeSize = GIF_MIN_CODE_SIZE + 1;
  };

  resetDictionary();
  emit(GIF_CLEAR);
  if (indices.length === 0) {
    emit(GIF_END);
  } else {
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const c = indices[i];
      const key = (prefix << 8) | c;
      let h = Math.imul(key, 0x9e3779b1) >>> (32 - GIF_HASH_BITS);
      let found = -1;
      while (hKeys[h] !== -1) {
        if (hKeys[h] === key) {
          found = hVals[h];
          break;
        }
        h = (h + 1) & GIF_HASH_MASK;
      }
      if (found !== -1) {
        prefix = found;
        continue;
      }
      emit(prefix);
      if (nextCode < GIF_MAX_CODES) {
        hKeys[h] = key;
        hVals[h] = nextCode;
        nextCode++;
        // The decoder's table lags one entry behind, so the width grows one entry later than
        // the naive "table full" point: switch once the table exceeds the current width.
        if (nextCode > (1 << codeSize) && codeSize < 12) codeSize++;
      } else {
        emit(GIF_CLEAR);
        resetDictionary();
      }
      prefix = c;
    }
    emit(prefix);
    emit(GIF_END);
  }
  if (bitCount > 0) out.push(bitBuf & 255);
  return out;
}

// Splits LZW bytes into GIF sub-blocks (each at most 255 bytes, prefixed by its length).
function gifSubBlocks(bytes) {
  const parts = [];
  for (let i = 0; i < bytes.length; i += 255) {
    const chunk = bytes.slice(i, Math.min(bytes.length, i + 255));
    parts.push(Uint8Array.of(chunk.length));
    parts.push(Uint8Array.from(chunk));
  }
  parts.push(Uint8Array.of(0));
  return parts;
}

// Encodes frames into a GIF Blob.
//   width, height   pixel size (same for every frame)
//   palette         Uint8Array(768): 256 RGB entries
//   frames          Array<Uint8Array(width*height)> of palette indices
//   delayCs         frame delay in hundredths of a second (GIF minimum is 2)
//   loop            loop count for animations (0 = forever)
export function encodeGif({ width, height, palette, frames, delayCs, loop }) {
  if (palette.length !== 768) throw new Error('GIF palette must have 256 RGB entries.');
  const parts = [];
  parts.push(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])); // "GIF89a"
  parts.push(Uint8Array.from([
    width & 255, width >> 8, height & 255, height >> 8,
    0xf7, // global colour table, 8 bits per channel, table size 256
    0, // background colour index
    0, // pixel aspect ratio
  ]));
  parts.push(palette);
  if (frames.length > 1) {
    const n = loop || 0;
    parts.push(Uint8Array.from([
      0x21, 0xff, 0x0b,
      0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30, // "NETSCAPE2.0"
      0x03, 0x01, n & 255, n >> 8, 0x00,
    ]));
  }
  const delay = Math.max(2, Math.round(delayCs));
  for (const indices of frames) {
    parts.push(Uint8Array.from([
      0x21, 0xf9, 0x04,
      0x04, // disposal: leave the frame in place
      delay & 255, delay >> 8,
      0x00, // transparent index (unused)
      0x00,
    ]));
    parts.push(Uint8Array.from([
      0x2c, 0, 0, 0, 0,
      width & 255, width >> 8, height & 255, height >> 8,
      0x00, // no local table, not interlaced
    ]));
    parts.push(Uint8Array.of(GIF_MIN_CODE_SIZE));
    parts.push(...gifSubBlocks(gifLzw(indices)));
  }
  parts.push(Uint8Array.of(0x3b)); // trailer
  return new Blob(parts, { type: 'image/gif' });
}
