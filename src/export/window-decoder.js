// On-demand decoding for a standalone video page. A clip whose frames would be too large to hold at once is kept as its
// encoded container, and only the frames around the playhead are decoded and kept. The renderer reads the current frame
// and the next one (frameAt in core.js), so a small window is enough.
//
// This module has no imports and no module-level state: the exported file carries parseVideoContainer and WindowedVideo
// as source text (see javascript-exporter.js), so the page runs the same code the tests run. The decoder itself is passed
// in (makeDecoder), so the scheduling can be tested without a browser.

// Reads the container written by the exporter (see buildContainer in javascript-exporter.js): 'JSRV', a version byte,
// a header (u32 length, then its JSON), then one record per frame in decode order: the data length (u32), a flags byte
// (1 = key frame), the frame index (u32), and the encoded bytes. Numbers are little-endian.
export function parseVideoContainer(bytes) {
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== 'JSRV' || bytes[4] !== 1) throw new Error('The frame data is not a JS Rusty video container.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(5, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(9, 9 + headerLength)));
  const records = [];
  let pos = 9 + headerLength;
  while (pos < bytes.length) {
    const length = view.getUint32(pos, true);
    records.push({
      index: view.getUint32(pos + 5, true),
      key: (bytes[pos + 4] & 1) === 1,
      data: bytes.subarray(pos + 9, pos + 9 + length),
    });
    pos += 9 + length;
  }
  return { header: header, records: records };
}

// Decodes the frames of a container on demand. frames[i] holds frame i once it is decoded, and is undefined otherwise.
// want(from, to) asks for frames from..to (and a few ahead), decoding from the nearest key frame when the decoder has
// not reached them. ready(from, to) says whether they are all decoded.
//   opts.count, opts.fps: the frame count and rate.
//   opts.chunks: the records of parseVideoContainer, in decode order.
//   opts.config: the decoder configuration. opts.makeDecoder(output, error) returns a decoder with configure, decode,
//   close. opts.makeChunk({ type, timestamp, data }) returns a chunk. opts.toPixels(frame) returns the frame's bytes.
//   opts.behind, opts.ahead: frames kept behind and decoded ahead of the request (defaults 3 and 8).
export class WindowedVideo {
  constructor(opts) {
    this.count = opts.count;
    this.fps = opts.fps;
    this.chunks = opts.chunks;
    this.config = opts.config;
    this.makeDecoder = opts.makeDecoder;
    this.makeChunk = opts.makeChunk;
    this.toPixels = opts.toPixels;
    this.behind = opts.behind === undefined ? 3 : opts.behind;
    this.ahead = opts.ahead === undefined ? 8 : opts.ahead;
    this.frames = new Array(this.count);
    this.pending = new Array(this.count);
    this.position = new Array(this.count);
    this.keyAt = new Array(this.chunks.length);
    for (let p = 0; p < this.chunks.length; p++) {
      this.position[this.chunks[p].index] = p;
      this.keyAt[p] = this.chunks[p].key ? p : (p > 0 ? this.keyAt[p - 1] : 0);
    }
    this.decoder = null;
    this.session = 0;
    this.fed = 0;
    this.lo = 0;
    this.hi = -1;
  }

  // Asks for frames from..to. Frames outside the window are released, and the frames the window needs are decoded.
  want(from, to) {
    const count = this.count;
    const first = Math.max(0, Math.min(count - 1, from));
    this.lo = Math.max(0, first - this.behind);
    this.hi = Math.min(count - 1, Math.max(first, to) + this.ahead);
    for (let i = 0; i < count; i++) {
      if ((i < this.lo || i > this.hi) && this.frames[i] !== undefined) this.frames[i] = undefined;
    }
    // The first frame in the window that is neither decoded nor on its way to the decoder.
    let needed = -1;
    for (let i = first; i <= this.hi; i++) {
      if (this.frames[i] === undefined && !this.pending[i]) {
        needed = i;
        break;
      }
    }
    if (needed < 0 || this.position[needed] === undefined) return;
    const start = this.position[needed];
    // Restart from a key frame when the decoder has passed the frame, has no decoder, or would have to decode far ahead.
    if (!this.decoder || start < this.fed || start - this.fed > 30) this.restart(start);
    let last = start;
    for (let i = needed; i <= this.hi; i++) {
      if (this.frames[i] === undefined && this.position[i] !== undefined && this.position[i] > last) last = this.position[i];
    }
    while (this.fed <= last && this.fed < this.chunks.length) {
      this.feed(this.fed);
      this.fed++;
    }
  }

  // True when frames from..to are all decoded.
  ready(from, to) {
    for (let i = Math.max(0, from); i <= to; i++) {
      if (this.frames[i] === undefined) return false;
    }
    return true;
  }

  // Starts a decoder at the key frame at or before chunk position p. Output from an earlier decoder is ignored.
  restart(p) {
    if (this.decoder) {
      try {
        this.decoder.close();
      } catch (err) {
        // A decoder that failed is already closed.
      }
    }
    this.session++;
    this.pending = new Array(this.count);
    const session = this.session;
    this.decoder = this.makeDecoder(
      (frame) => this.output(session, frame),
      () => {
        // A decoder error ends this session. The next request starts a new one.
        this.decoder = null;
      }
    );
    this.decoder.configure(this.config);
    this.fed = this.keyAt[p];
  }

  feed(p) {
    const chunk = this.chunks[p];
    this.pending[chunk.index] = true;
    this.decoder.decode(this.makeChunk({
      type: chunk.key ? 'key' : 'delta',
      timestamp: Math.round((chunk.index * 1e6) / this.fps),
      data: chunk.data,
    }));
  }

  // A decoded frame arrives. It is kept if it is in the window, and closed either way.
  output(session, frame) {
    if (session !== this.session) {
      frame.close();
      return;
    }
    const index = Math.round((frame.timestamp * this.fps) / 1e6);
    if (index >= 0 && index < this.count) {
      this.pending[index] = false;
      if (index >= this.lo && index <= this.hi) this.frames[index] = this.toPixels(frame);
    }
    frame.close();
  }

  close() {
    if (this.decoder) {
      try {
        this.decoder.close();
      } catch (err) {
        // Already closed.
      }
    }
    this.decoder = null;
  }
}
