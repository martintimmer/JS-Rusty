// Lossless coder for the packed Dither indices. Every cell is coded with an adaptive binary range coder (LZMA style),
// from its neighbourhood: the cells left, above, above-left and above-right in this frame, the same cell in the previous
// frame, and the local tone (the mean index of a causal window in this frame and the 3 x 3 around the cell last frame).
// A flag says whether the cell kept its value from the previous frame. A changed cell is coded as a binary tree over
// its index bits, in a context made from the tone and its neighbours.
//
// The coder has no imports. The exported file carries RangeDecoder and codeIndices as source text (see
// javascript-exporter.js), so the decoder runs the same model as the encoder. Keep both functions self-contained: they
// may not refer to anything outside themselves.

// Range encoder. A probability is the chance of a 0 bit, in 16 bits, and adapts by 1/32 after each bit.
export class RangeEncoder {
  constructor(capacity) {
    this.low = 0;
    this.range = 0xFFFFFFFF;
    this.cache = 0;
    this.cacheSize = 1;
    this.buf = new Uint8Array(Math.max(16, capacity));
    this.n = 0;
  }
  // Writes one byte. The coded size is not known in advance, so the buffer doubles when it is full. (A typed array
  // ignores writes past its end, so without this a larger output would be silently cut short.)
  put(byte) {
    if (this.n >= this.buf.length) {
      const grown = new Uint8Array(this.buf.length * 2);
      grown.set(this.buf);
      this.buf = grown;
    }
    this.buf[this.n++] = byte;
  }
  shiftLow() {
    const low32 = this.low % 0x100000000;
    const carry = this.low >= 0x100000000 ? 1 : 0;
    if (low32 < 0xFF000000 || carry) {
      let temp = this.cache;
      do {
        this.put((temp + carry) & 0xFF);
        temp = 0xFF;
      } while (--this.cacheSize !== 0);
      this.cache = Math.floor(low32 / 0x1000000) & 0xFF;
    }
    this.cacheSize++;
    this.low = (low32 % 0x1000000) * 256;
  }
  bit(probs, i, b) {
    const p = probs[i];
    const bound = (this.range >>> 16) * p;
    if (b === 0) {
      this.range = bound;
      probs[i] = p + ((65536 - p) >> 5);
    } else {
      this.low += bound;
      this.range -= bound;
      probs[i] = p - (p >> 5);
    }
    while (this.range < 0x1000000) {
      this.range = this.range * 256;
      this.shiftLow();
    }
    return b;
  }
  finish() {
    for (let k = 0; k < 5; k++) this.shiftLow();
    return this.buf.subarray(0, this.n);
  }
}

// Range decoder: the mirror of RangeEncoder. bit(probs, i) returns the decoded bit.
export class RangeDecoder {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
    this.range = 0xFFFFFFFF;
    this.code = 0;
    for (let k = 0; k < 5; k++) this.code = (this.code * 256 + this.next()) % 0x100000000;
  }
  next() {
    return this.pos < this.buf.length ? this.buf[this.pos++] : 0;
  }
  bit(probs, i) {
    const p = probs[i];
    const bound = (this.range >>> 16) * p;
    let b;
    if (this.code < bound) {
      this.range = bound;
      probs[i] = p + ((65536 - p) >> 5);
      b = 0;
    } else {
      this.code -= bound;
      this.range -= bound;
      probs[i] = p - (p >> 5);
      b = 1;
    }
    while (this.range < 0x1000000) {
      this.range = this.range * 256;
      this.code = this.code * 256 + this.next();
    }
    return b;
  }
}

// The model, run by the encoder (decoding false) and the decoder (decoding true). data holds count frames of W x H
// indices of `bits` bits each, frame after frame. The encoder reads data; the decoder fills it in, cell by cell.
export function codeIndices(io, data, W, H, count, bits, decoding) {
  const L = 1 << bits;
  const cells = W * H;
  const flagP = new Uint16Array(256).fill(32768);
  const treeP = new Uint16Array(2 * L * L * L * L).fill(32768);
  // The bits of an index, as a binary tree, in the context (region, tone q, left a, c).
  const tree = (region, q, a, c, v) => {
    const base = region * L * L * L * L + ((q * L + a) * L + c) * L;
    let node = 1;
    for (let k = bits - 1; k >= 0; k--) {
      node = (node << 1) | io.bit(treeP, base + node, decoding ? 0 : (v >> k) & 1);
    }
    return node - L;
  };
  for (let t = 0; t < count; t++) {
    const base = t * cells;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const pos = base + y * W + x;
        const left = x > 0 ? data[pos - 1] : (y > 0 ? data[pos - W] : 0);
        const up = y > 0 ? data[pos - W] : left;
        const upLeft = x > 0 && y > 0 ? data[pos - W - 1] : up;
        const upRight = y > 0 && x < W - 1 ? data[pos - W + 1] : up;

        // Tone: the mean of a causal window in this frame, and of the 3 x 3 around the cell in the previous frame.
        let sum = 0;
        let cnt = 0;
        for (let dy = -2; dy <= 0; dy++) {
          const yy = y + dy;
          if (yy < 0) continue;
          const xEnd = dy === 0 ? -1 : 2;
          for (let dx = -2; dx <= xEnd; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= W) continue;
            sum += data[base + yy * W + xx];
            cnt++;
          }
        }
        if (t > 0) {
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= H) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              if (xx < 0 || xx >= W) continue;
              sum += data[base - cells + yy * W + xx];
              cnt++;
            }
          }
        }
        const q = Math.min(L - 1, Math.round(cnt > 0 ? sum / cnt : 0));

        const v0 = decoding ? 0 : data[pos];
        let v;
        if (t === 0) {
          v = tree(1, q, left, upLeft, v0);
        } else {
          const prev = data[pos - cells];
          // Which neighbours kept their value from the previous frame, and whether this cell changed last frame.
          const mL = x > 0 ? (data[pos - 1] === data[pos - 1 - cells] ? 1 : 0) : 1;
          const mU = y > 0 ? (data[pos - W] === data[pos - W - cells] ? 1 : 0) : 1;
          const mUL = x > 0 && y > 0 ? (data[pos - W - 1] === data[pos - W - 1 - cells] ? 1 : 0) : 1;
          const mUR = y > 0 && x < W - 1 ? (data[pos - W + 1] === data[pos - W + 1 - cells] ? 1 : 0) : 1;
          const hist = t >= 2 && data[pos - cells] !== data[pos - 2 * cells] ? 1 : 0;
          const fc = (mL + mU + mUL + mUR) | (hist << 3) | ((prev === left ? 1 : 0) << 4) |
            ((prev === up ? 1 : 0) << 5) | ((prev === upRight ? 1 : 0) << 6) | ((prev === upLeft ? 1 : 0) << 7);
          const changed = io.bit(flagP, fc, decoding ? 0 : (v0 === prev ? 0 : 1));
          v = changed === 0 ? prev : tree(0, q, left, prev, v0);
        }
        data[pos] = v;
      }
    }
  }
}

// Codes the indices and returns the bytes. data is not changed.
export function encodeIndices(data, W, H, count, bits) {
  const enc = new RangeEncoder(data.length + 1024);
  codeIndices(enc, data, W, H, count, bits, false);
  return enc.finish();
}
