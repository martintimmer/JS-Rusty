// Builds a standalone, dependency-free JavaScript file that renders the artwork.
// The renderer source is read from the app's own modules (so the export runs the
// exact same engine code), stripped of module syntax, and wrapped in an IIFE that
// exposes `window.RasterArt.mount(target, options)`.
//
// Frame data: 8-bit grayscale at the chosen export width (RGB for a rendered loop). The frames are encoded with the
// browser's video encoder (WebCodecs) into a 'JSRV' container, which the file decodes again when it loads. Where no
// video encoder is available, each frame is stored as a byte-wise delta from the one before, and the block is deflated.
// Motion vectors and colour are deflated, then base64-encoded.

import { DEFAULT_PARAMS, normalizeParams, CANVAS_SCALE, GRID_CELL, resolvePalette, stillLoopSeconds } from '../rendering/core.js';
import { createArtwork } from '../rendering/artwork.js';
import { dtResolveSettings } from '../rendering/dither/settings.js';
import { dtPaletteTable } from '../engines/dither.js';
import { RangeDecoder, codeIndices, encodeIndices } from './ctx-coder.js';

// Concatenation order matters: core primitives first, then engines, then the orchestrator.
const RUNTIME_MODULES = [
  '../rendering/core.js',
  '../rendering/flow.js',
  '../rendering/motion-field.js',
  '../engines/engraving.js',
  '../engines/stippling.js',
  '../engines/contour.js',
  '../engines/halftone.js',
  '../engines/pencil.js',
  '../engines/waves.js',
  '../engines/contour-drawing.js',
  '../engines/lowpoly.js',
  '../rendering/dither/colour.js',
  '../rendering/dither/palettes.js',
  '../rendering/dither/settings.js',
  '../rendering/dither/tone.js',
  '../rendering/dither/temporal.js',
  '../rendering/dither/edges.js',
  '../rendering/dither/quantize.js',
  '../rendering/dither/diffusion.js',
  '../rendering/dither/atkinson.js',
  '../rendering/dither/floyd-steinberg.js',
  '../rendering/dither/jarvis-judice-ninke.js',
  '../rendering/dither/bayer.js',
  '../rendering/dither/blue-noise.js',
  '../rendering/dither/random-threshold.js',
  '../rendering/dither/direct.js',
  '../engines/dither.js',
  '../engines/oil.js',
  '../engines/linocut.js',
  '../engines/ascii.js',
  '../engines/sort.js',
  '../rendering/optics.js',
  '../rendering/artwork.js',
];

export const EXPORT_MAX_WIDTH = 960;

export async function buildRuntimeSource() {
  const parts = [];
  for (const rel of RUNTIME_MODULES) {
    const url = new URL(rel, import.meta.url);
    const res = await fetch(url);
    if (!res.ok) throw new Error('Could not read renderer source: ' + rel);
    parts.push(stripModuleSyntax(await res.text()));
  }
  return parts.join('\n');
}

export function stripModuleSyntax(src) {
  return src
    .replace(/^import\s[\s\S]*?from\s*['"][^'"]+['"];?[ \t]*$/gm, '')
    .replace(/^export\s+(?=(function|const|let|var|class)\b)/gm, '');
}

// Resamples the processed frames to the export width and packs them (delta + deflate).
// withColour: also pack the colour of the analysis grid (one still frame), for the algorithms that read it.
// The analysis colour of a still, resampled to the grid of a targetW x targetH export (3 bytes per cell), or null when
// the picture has no colour.
function stillColourAt(data, targetW, targetH) {
  const gw0 = Math.round(data.width / GRID_CELL);
  const gh0 = Math.round(data.height / GRID_CELL);
  if (!data.colour || !data.colour[0] || data.colour[0].length < 3 * gw0 * gh0) return null;
  const src = data.colour[0];
  const gwE = Math.ceil(targetW / GRID_CELL);
  const ghE = Math.ceil(targetH / GRID_CELL);
  const bytes = new Uint8Array(3 * gwE * ghE);
  for (let gy = 0; gy < ghE; gy++) {
    const sy = Math.min(gh0 - 1, Math.floor(((gy + 0.5) * gh0) / ghE));
    for (let gx = 0; gx < gwE; gx++) {
      const sx = Math.min(gw0 - 1, Math.floor(((gx + 0.5) * gw0) / gwE));
      const s = 3 * (sy * gw0 + sx);
      const o = 3 * (gy * gwE + gx);
      bytes[o] = src[s];
      bytes[o + 1] = src[s + 1];
      bytes[o + 2] = src[s + 2];
    }
  }
  return bytes;
}

// The grey frame of a still, resampled to a targetW x targetH export.
function stillFrameAt(data, targetW, targetH) {
  const src = data.frames[0];
  const out = new Uint8Array(targetW * targetH);
  for (let y = 0; y < targetH; y++) {
    const sy = Math.min(data.height - 1, Math.floor((y * data.height) / targetH));
    for (let x = 0; x < targetW; x++) {
      const sx = Math.min(data.width - 1, Math.floor((x * data.width) / targetW));
      out[y * targetW + x] = src[sy * data.width + sx];
    }
  }
  return out;
}

// Video frames. The frames of a standalone file are encoded with the browser's own video encoder (WebCodecs) and packed
// into a container; the file's decoder reads them back when it loads. The first codec in VIDEO_CODECS that this browser
// can both encode and decode is used. Where none is, the frames are deflated as before.
const VIDEO_CODECS = ['vp09.00.41.08', 'avc1.640028'];
// Bits per pixel per second, for grey frames (the live picture) and colour frames (a rendered loop). This is the
// starting point, chosen to aim at about 95% below the deflated frames: a higher value gives a sharper picture and a
// larger file.
const VIDEO_BPP = { 1: 0.08, 3: 0.2 };
const VIDEO_MIN_BITRATE = 250000;
// A key frame at least this often, in seconds.
const VIDEO_KEY_SECONDS = 2;
const CONTAINER_MAGIC = [0x4a, 0x53, 0x52, 0x56]; // 'JSRV'
const CONTAINER_VERSION = 1;

// The export width for a maximum width: never wider than the data, and even, as the video encoders need.
export function exportWidth(dataWidth, maxWidth) {
  const w = Math.max(16, Math.min(dataWidth, Math.round(maxWidth || EXPORT_MAX_WIDTH)));
  return w - (w % 2);
}

function videoEncoderConfig(codec, w, h, fps, channels) {
  // The bit rate is worked out for at least 12 frames a second, so a single still gets a fair share of it.
  const bitrate = Math.max(VIDEO_MIN_BITRATE, Math.round(w * h * Math.max(fps, 12) * VIDEO_BPP[channels]));
  const config = { codec: codec, width: w, height: h, framerate: fps, bitrate: bitrate, latencyMode: 'quality' };
  if (codec.indexOf('avc') === 0) config.avc = { format: 'avc' };
  return config;
}

// The first codec this browser can both encode and decode at this size, or null when there is none.
async function chooseVideoCodec(w, h, fps, channels) {
  if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined' || typeof VideoFrame === 'undefined') {
    return null;
  }
  for (const codec of VIDEO_CODECS) {
    try {
      const enc = await VideoEncoder.isConfigSupported(videoEncoderConfig(codec, w, h, fps, channels));
      const dec = await VideoDecoder.isConfigSupported({ codec: codec, codedWidth: w, codedHeight: h });
      if (enc.supported && dec.supported) return codec;
    } catch (err) {
      // Not usable in this form: try the next codec.
    }
  }
  return null;
}

// Encodes count frames with the browser's video encoder and returns the container (see buildContainer).
// drawFrame(i, ctx) paints frame i on a w x h canvas. Each frame is encoded as it is drawn, so the raw frames are
// never all held in memory.
async function encodeVideoContainer(codec, w, h, fps, channels, count, drawFrame, onProgress) {
  const records = [];
  let description = null;
  let failure = null;
  const encoder = new VideoEncoder({
    output: function (chunk, meta) {
      const dc = meta && meta.decoderConfig;
      if (!description && dc && dc.description) {
        const d = dc.description;
        description = (ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d)).slice();
      }
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      records.push({ key: chunk.type === 'key', index: Math.round((chunk.timestamp * fps) / 1e6), bytes: bytes });
    },
    error: function (err) { failure = err; },
  });
  try {
    encoder.configure(videoEncoderConfig(codec, w, h, fps, channels));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const keyEvery = Math.max(1, Math.round(fps * VIDEO_KEY_SECONDS));
    const duration = Math.round(1e6 / fps);
    for (let i = 0; i < count; i++) {
      drawFrame(i, ctx);
      const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: duration });
      encoder.encode(frame, { keyFrame: i % keyEvery === 0 });
      frame.close();
      if (failure) throw failure;
      if (onProgress) onProgress(i + 1, count);
      // Let the encoder and the page catch up now and then.
      if (i % 4 === 3 || encoder.encodeQueueSize > 4) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await encoder.flush();
    if (failure) throw failure;
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
  if (records.length !== count) throw new Error('The video encoder returned ' + records.length + ' of ' + count + ' frames.');
  return buildContainer({ codec: codec, width: w, height: h, fps: fps, count: count, channels: channels }, description, records);
}

// The container: 'JSRV', a version byte, then a header (u32 length, then its JSON), then one record per frame: the length
// of its data (u32), a flags byte (1 = key frame), the frame index (u32), and the encoded bytes. Numbers are
// little-endian. The header names the codec and, for codecs that need one, its decoder description.
function buildContainer(header, description, records) {
  const json = new TextEncoder().encode(JSON.stringify(Object.assign({}, header, {
    description: description ? bytesToBase64(description) : '',
  })));
  let size = 9 + json.length;
  for (const r of records) size += 9 + r.bytes.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(CONTAINER_MAGIC, 0);
  out[4] = CONTAINER_VERSION;
  view.setUint32(5, json.length, true);
  out.set(json, 9);
  let pos = 9 + json.length;
  for (const r of records) {
    view.setUint32(pos, r.bytes.length, true);
    out[pos + 4] = r.key ? 1 : 0;
    view.setUint32(pos + 5, r.index, true);
    out.set(r.bytes, pos + 9);
    pos += 9 + r.bytes.length;
  }
  return out;
}

// Loop render. The most raw frame data a rendered loop may hold (about 160 MB), and the most frames it may have.
export const LOOP_FRAME_BYTES = 160 * 1024 * 1024;
export const LOOP_FRAME_MAX = 150;

// How a rendered loop is sampled: the frame count and rate that cover one loop of loopSeconds at the rate asked for,
// within the memory budget. The loop always covers exactly loopSeconds, so its last frame leads into its first.
export function loopFrameTiming(loopSeconds, fps, frameBytes) {
  const wanted = Math.max(2, Math.round(loopSeconds * fps));
  const fit = Math.max(2, Math.floor(LOOP_FRAME_BYTES / Math.max(1, frameBytes)));
  const count = Math.min(LOOP_FRAME_MAX, fit, wanted);
  return { count: count, rate: count / loopSeconds, seconds: loopSeconds };
}

// Renders one loop of an animated still into frames at the export size (the Loop render option). The frames are
// rendered the way the GIF is: a closed loop, so the last frame leads into the first. Each frame is stored as RGB: as
// a video-encoded sequence when a video encoder is available, otherwise as the difference from the one before it,
// deflated.
export async function encodeLoopFrames(data, params, maxWidth, fps, onProgress) {
  const targetW = exportWidth(data.width, maxWidth);
  const targetH = Math.max(16, Math.round((data.height * (targetW / data.width)) / 2) * 2);
  const frameBytes = targetW * targetH * 3;
  const seconds = stillLoopSeconds(params.speed);
  const timing = loopFrameTiming(seconds, fps, frameBytes);
  const count = timing.count;
  const dt = 1 / timing.rate;

  const colourBytes = stillColourAt(data, targetW, targetH);
  const small = {
    width: targetW,
    height: targetH,
    fps: timing.rate,
    duration: 0,
    count: 1,
    frames: [stillFrameAt(data, targetW, targetH)],
    colour: colourBytes ? [colourBytes] : null,
    motion: null,
  };
  const canvas = document.createElement('canvas');
  const art = createArtwork(canvas, small);
  art.setParams(params);
  const ctx = canvas.getContext('2d');
  const renderFrame = (i) => art.render(i * dt, i === 0 ? 0 : dt, { reset: i === 0, loop: seconds });

  const codec = await chooseVideoCodec(targetW, targetH, timing.rate, 3);
  if (codec) {
    const bytes = await encodeVideoContainer(codec, targetW, targetH, timing.rate, 3, count, (i, dst) => {
      renderFrame(i);
      dst.drawImage(canvas, 0, 0);
    }, onProgress);
    return {
      mode: 'video', channels: 3, width: targetW, height: targetH, fps: timing.rate, duration: timing.seconds,
      count: count, frameBytes: frameBytes, frames: bytesToBase64(bytes), motion: null, colour: null,
    };
  }

  const out = new Uint8Array(count * frameBytes);
  const prev = new Uint8Array(frameBytes);
  const cur = new Uint8Array(frameBytes);
  for (let i = 0; i < count; i++) {
    renderFrame(i);
    const px = ctx.getImageData(0, 0, targetW, targetH).data;
    for (let k = 0, j = 0; k < px.length; k += 4, j += 3) {
      cur[j] = px[k];
      cur[j + 1] = px[k + 1];
      cur[j + 2] = px[k + 2];
    }
    const base = i * frameBytes;
    if (i === 0) {
      out.set(cur, 0);
    } else {
      for (let j = 0; j < frameBytes; j++) out[base + j] = (cur[j] - prev[j]) & 255;
    }
    prev.set(cur);
    if (onProgress) onProgress(i + 1, count);
    // Yield to the UI now and then, so the page stays responsive during a long render.
    if (i % 4 === 3) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const compressed = await deflate(out);
  return {
    mode: 'frames',
    width: targetW,
    height: targetH,
    fps: timing.rate,
    duration: timing.seconds,
    count: count,
    frameBytes: frameBytes,
    frames: bytesToBase64(compressed),
    motion: null,
    colour: null,
  };
}

export async function encodeData(data, maxWidth, withColour) {
  const targetW = exportWidth(data.width, maxWidth);
  const scale = targetW / data.width;
  const targetH = Math.max(16, Math.round((data.height * scale) / 2) * 2);
  const n = targetW * targetH;
  const count = data.count;

  // Nearest-neighbour source index for every export pixel, computed once.
  const srcIndex = new Uint32Array(n);
  for (let y = 0; y < targetH; y++) {
    const sy = Math.min(data.height - 1, Math.floor((y * data.height) / targetH));
    for (let x = 0; x < targetW; x++) {
      const sx = Math.min(data.width - 1, Math.floor((x * data.width) / targetW));
      srcIndex[y * targetW + x] = sy * data.width + sx;
    }
  }

  // The grey frame f at the export size.
  const greyFrame = (f) => {
    const src = data.frames[f];
    const cur = new Uint8Array(n);
    for (let i = 0; i < n; i++) cur[i] = src[srcIndex[i]];
    return cur;
  };

  let motion = null;
  if (data.motion) {
    const m = data.motion;
    const vx = new Uint8Array(m.vx.length);
    const vy = new Uint8Array(m.vy.length);
    for (let i = 0; i < m.vx.length; i++) {
      vx[i] = clampSigned(Math.round(m.vx[i] * scale)) & 0xff;
      vy[i] = clampSigned(Math.round(m.vy[i] * scale)) & 0xff;
    }
    motion = {
      bs: +(m.bs * scale).toFixed(3),
      bw: m.bw,
      bh: m.bh,
      vx: bytesToBase64(await deflate(vx)),
      vy: bytesToBase64(await deflate(vy)),
      diff: bytesToBase64(await deflate(m.diff)),
    };
  }

  let colour = null;
  if (withColour) {
    const bytes = stillColourAt(data, targetW, targetH);
    if (bytes) colour = bytesToBase64(await deflate(bytes));
  }

  const codec = await chooseVideoCodec(targetW, targetH, data.fps, 1);
  if (codec) {
    // Grey frames: R, G and B hold the same value, so the encoder's luma is the grey value itself.
    const pixels = new ImageData(targetW, targetH);
    const px = pixels.data;
    const bytes = await encodeVideoContainer(codec, targetW, targetH, data.fps, 1, count, (f, dst) => {
      const cur = greyFrame(f);
      for (let i = 0, j = 0; i < n; i++, j += 4) {
        px[j] = cur[i];
        px[j + 1] = cur[i];
        px[j + 2] = cur[i];
        px[j + 3] = 255;
      }
      dst.putImageData(pixels, 0, 0);
    });
    return {
      mode: 'video', channels: 1, width: targetW, height: targetH, fps: data.fps, duration: data.duration,
      count: count, frameBytes: n, frames: bytesToBase64(bytes), motion: motion, colour: colour,
    };
  }

  // Without a video encoder: each frame is stored as the difference from the one before it, and the block is deflated.
  const packed = new Uint8Array(n * count);
  let prev = new Uint8Array(n);
  for (let f = 0; f < count; f++) {
    const cur = greyFrame(f);
    const base = f * n;
    if (f === 0) {
      packed.set(cur, base);
    } else {
      for (let i = 0; i < n; i++) packed[base + i] = (cur[i] - prev[i]) & 255;
    }
    prev = cur;
  }
  const compressed = await deflate(packed);
  return {
    width: targetW,
    height: targetH,
    fps: data.fps,
    duration: data.duration,
    count: count,
    frameBytes: n,
    frames: bytesToBase64(compressed),
    motion: motion,
    colour: colour,
  };
}

// Packed palette indices (Dither). The Dither engine runs for every frame, and each cell's palette index is packed
// at the smallest bit depth that holds the palette: 1 bit for 2 colours, 2 bits for 3 or 4, 3 bits for 5 to 8, and
// 4 bits for 9 to 16. The indices are then coded losslessly by the context coder (ctx-coder.js). The standalone file
// paints the indices with the
// palette table, so it shows what the app showed, without dithering again at run time.
export function packedBitsFor(levels) {
  let bits = 1;
  while ((1 << bits) < levels) bits++;
  return bits;
}

async function encodePacked(data, params) {
  const p = normalizeParams(params);
  const opt = dtResolveSettings(p);
  const bits = packedBitsFor(opt.levels);
  const art = createArtwork(document.createElement('canvas'), data);
  // The packed frames are the picture as drawn, without motion or optics: the standalone player only paints them.
  art.setParams(Object.assign({}, p, { animation: 'off', halation: 0, aberration: 0 }));
  const frames = [];
  let gw = 0;
  let gh = 0;
  for (let k = 0; k < data.count; k++) {
    const r = art.render(k / data.fps, 0, { reset: k === 0 });
    if (!r.lattice) throw new Error('The dither output is not available for export.');
    gw = r.lattice.gw;
    gh = r.lattice.gh;
    frames.push(Uint8Array.from(r.lattice.index));
  }
  const cells = gw * gh;
  const indices = new Uint8Array(cells * data.count);
  frames.forEach((frame, k) => indices.set(frame, k * cells));
  const coded = encodeIndices(indices, gw, gh, data.count, bits);
  return {
    mode: 'packed',
    width: data.width * CANVAS_SCALE,
    height: data.height * CANVAS_SCALE,
    gw: gw,
    gh: gh,
    bits: bits,
    levels: opt.levels,
    count: data.count,
    fps: data.fps,
    duration: data.duration,
    table: bytesToBase64(dtPaletteTable(opt, resolvePalette(p))),
    frames: bytesToBase64(coded),
  };
}

async function deflate(bytes) {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('This browser cannot compress the export (CompressionStream missing).');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function clampSigned(v) {
  return v < -127 ? -127 : (v > 127 ? 127 : v);
}

export function bytesToBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// Decoder that runs inside the exported file. Emitted verbatim as a string.
const DECODER_SOURCE = `
  function b64ToBytes(s) {
    var bin = atob(s);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function inflateBytes(bytes) {
    var ds = new DecompressionStream('deflate');
    var stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Response(stream).arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
  }
  // Packed Dither: the indices are decoded with the context coder (codeIndices), and each frame is a view on them.
  function decodePacked(d) {
    var cells = d.gw * d.gh;
    var data = new Uint8Array(cells * d.count);
    codeIndices(new RangeDecoder(b64ToBytes(d.frames)), data, d.gw, d.gh, d.count, d.bits, true);
    var frames = new Array(d.count);
    for (var f = 0; f < d.count; f++) frames[f] = data.subarray(f * cells, (f + 1) * cells);
    return { packed: true, width: d.width, height: d.height, gw: d.gw, gh: d.gh, bits: d.bits,
             levels: d.levels, count: d.count, fps: d.fps, duration: d.duration,
             table: b64ToBytes(d.table), frames: frames };
  }
  // Delta frames: inflate, then add each frame's bytes to the frame before it.
  function decodeDeltaFrames(d) {
    return inflateBytes(b64ToBytes(d.frames)).then(function (packed) {
      var n = d.frameBytes;
      var frames = new Array(d.count);
      frames[0] = packed.slice(0, n);
      for (var f = 1; f < d.count; f++) {
        var cur = new Uint8Array(n);
        var prev = frames[f - 1];
        var base = f * n;
        for (var i = 0; i < n; i++) cur[i] = (prev[i] + packed[base + i]) & 255;
        frames[f] = cur;
      }
      return frames;
    });
  }
  // Video frames: the container written by the exporter (see buildContainer). The frames are decoded with the browser's
  // video decoder and read back as grey (1 channel) or RGB (3 channels), one array per frame.
  function decodeVideoFrames(d) {
    var bytes = b64ToBytes(d.frames);
    if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'JSRV' || bytes[4] !== 1) {
      return Promise.reject(new Error('The frame data is not a JS Rusty video container.'));
    }
    if (typeof VideoDecoder === 'undefined' || typeof EncodedVideoChunk === 'undefined') {
      return Promise.reject(new Error('This browser cannot decode the video frames (WebCodecs is missing).'));
    }
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var hlen = view.getUint32(5, true);
    var header = JSON.parse(new TextDecoder().decode(bytes.subarray(9, 9 + hlen)));
    var W = header.width, H = header.height, fps = header.fps, count = header.count;
    var n = W * H, channels = header.channels;
    var canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    var frames = new Array(count);
    var got = 0;
    return new Promise(function (resolve, reject) {
      var config = { codec: header.codec, codedWidth: W, codedHeight: H, optimizeForLatency: true };
      if (header.description) config.description = b64ToBytes(header.description);
      var decoder = new VideoDecoder({
        output: function (frame) {
          try {
            var index = Math.round((frame.timestamp * fps) / 1e6);
            ctx.drawImage(frame, 0, 0, W, H);
            var px = ctx.getImageData(0, 0, W, H).data;
            var out = new Uint8Array(n * channels);
            for (var i = 0; i < n; i++) {
              if (channels === 1) {
                out[i] = px[i * 4];
              } else {
                out[i * 3] = px[i * 4];
                out[i * 3 + 1] = px[i * 4 + 1];
                out[i * 3 + 2] = px[i * 4 + 2];
              }
            }
            if (index >= 0 && index < count) {
              if (!frames[index]) got++;
              frames[index] = out;
            }
          } catch (err) {
            reject(err);
          } finally {
            frame.close();
          }
        },
        error: function (err) { reject(err); }
      });
      decoder.configure(config);
      var pos = 9 + hlen;
      while (pos < bytes.length) {
        var len = view.getUint32(pos, true);
        var key = (bytes[pos + 4] & 1) === 1;
        var index = view.getUint32(pos + 5, true);
        decoder.decode(new EncodedVideoChunk({
          type: key ? 'key' : 'delta',
          timestamp: Math.round((index * 1e6) / fps),
          data: bytes.subarray(pos + 9, pos + 9 + len)
        }));
        pos += 9 + len;
      }
      decoder.flush().then(function () {
        decoder.close();
        if (got === count) resolve(frames);
        else reject(new Error('The video decoder returned ' + got + ' of ' + count + ' frames.'));
      }, reject);
    });
  }
  function decodeArtworkData(d) {
    if (d.mode === 'packed') return new Promise(function (resolve) { resolve(decodePacked(d)); });
    var framesP = d.mode === 'video' ? decodeVideoFrames(d) : decodeDeltaFrames(d);
    var motionP = d.motion ? Promise.all([
      inflateBytes(b64ToBytes(d.motion.vx)),
      inflateBytes(b64ToBytes(d.motion.vy)),
      inflateBytes(b64ToBytes(d.motion.diff))
    ]) : Promise.resolve(null);
    var colourP = d.colour ? inflateBytes(b64ToBytes(d.colour)) : Promise.resolve(null);
    return Promise.all([framesP, motionP, colourP]).then(function (r) {
      var motion = null;
      if (r[1]) {
        motion = {
          bs: d.motion.bs, bw: d.motion.bw, bh: d.motion.bh,
          vx: new Int8Array(r[1][0].buffer),
          vy: new Int8Array(r[1][1].buffer),
          diff: r[1][2]
        };
      }
      return { width: d.width, height: d.height, fps: d.fps, duration: d.duration,
               count: d.count, frames: r[0], motion: motion, colour: r[2] ? [r[2]] : null,
               frameMode: d.mode === 'frames' || (d.mode === 'video' && d.channels === 3) };
    });
  }
`;

// Mount logic. Decoding is asynchronous, so the returned controller queues state
// until the renderer is ready.
const MOUNT_SOURCE = `
  var ARTWORK_PROMISE = null;
  function loadArtwork() {
    if (!ARTWORK_PROMISE) ARTWORK_PROMISE = decodeArtworkData(ARTWORK_DATA);
    return ARTWORK_PROMISE;
  }
  // Paints decoded palette indices. The same picture the app drew: each cell is its palette colour, scaled up with
  // smoothing off. Nothing is dithered here, and the settings are fixed in the file, so setParams does nothing.
  function createPackedArtwork(canvas, data) {
    canvas.width = data.width;
    canvas.height = data.height;
    var ctx = canvas.getContext('2d');
    var cell = document.createElement('canvas');
    cell.width = data.gw;
    cell.height = data.gh;
    var cellCtx = cell.getContext('2d');
    var img = cellCtx.createImageData(data.gw, data.gh);
    var pixels = img.data;
    var table = data.table;
    var shown = -1;
    return {
      canvas: canvas,
      params: { animation: 'off' },
      setParams: function () {},
      render: function (t) {
        var f = Math.floor(Math.max(0, t) * data.fps + 1e-6);
        if (f > data.count - 1) f = data.count - 1;
        if (f === shown) return { ms: 0, elements: 0 };
        shown = f;
        var idx = data.frames[f];
        for (var i = 0; i < idx.length; i++) {
          var q = idx[i] * 3;
          var j = i * 4;
          pixels[j] = table[q];
          pixels[j + 1] = table[q + 1];
          pixels[j + 2] = table[q + 2];
          pixels[j + 3] = 255;
        }
        cellCtx.putImageData(img, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(cell, 0, 0, data.gw, data.gh, 0, 0, data.width, data.height);
        return { ms: 0, elements: idx.length };
      }
    };
  }
  // Plays a rendered loop: each frame is RGB, shown at its time. The loop wraps at the end of its last frame.
  function createFrameArtwork(canvas, data) {
    canvas.width = data.width;
    canvas.height = data.height;
    var ctx = canvas.getContext('2d');
    var img = ctx.createImageData(data.width, data.height);
    var pixels = img.data;
    var n = data.width * data.height;
    var shown = -1;
    return {
      canvas: canvas,
      params: { animation: 'off' },
      setParams: function () {},
      render: function (t) {
        var f = Math.floor(Math.max(0, t) * data.fps + 1e-6);
        if (f > data.count - 1) f = data.count - 1;
        if (f === shown) return { ms: 0, elements: 0 };
        shown = f;
        var src = data.frames[f];
        for (var i = 0; i < n; i++) {
          var j = i * 4;
          var s = i * 3;
          pixels[j] = src[s];
          pixels[j + 1] = src[s + 1];
          pixels[j + 2] = src[s + 2];
          pixels[j + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        return { ms: 0, elements: n };
      }
    };
  }
  function mount(target, options) {
    var opts = options || {};
    var canvas = target;
    if (!target || target.tagName !== 'CANVAS') {
      canvas = document.createElement('canvas');
      canvas.style.maxWidth = '100%';
      canvas.style.height = 'auto';
      (target || document.body).appendChild(canvas);
    }
    var art = null, raf = null, last = null, dirty = true, reset = true;
    var playing = opts.autoplay !== false, loop = opts.loop !== false, time = 0, duration = 0;
    var pendingParams = normalizeParams(Object.assign({}, ARTWORK_PARAMS, opts.params || {}));

    function frame(now) {
      raf = requestAnimationFrame(frame);
      if (!art) return;
      var dt = last == null ? 0 : Math.min(0.1, (now - last) / 1000);
      last = now;
      var animated = art.params.animation !== 'off';
      var continuous = playing && (duration > 0 || animated);
      if (playing) {
        time += dt;
        if (duration > 0) {
          if (loop) time = time % duration;
          else if (time >= duration) { time = duration; playing = false; }
        }
      }
      if (continuous || dirty) {
        art.render(time, continuous ? dt : 0, { reset: reset });
        dirty = false;
        reset = false;
      }
    }
    canvas.addEventListener('click', function () { api.toggle(); });
    loadArtwork().then(function (data) {
      duration = data.duration > 0 ? data.duration : 0;
      art = data.packed ? createPackedArtwork(canvas, data)
        : (data.frameMode ? createFrameArtwork(canvas, data) : createArtwork(canvas, data));
      art.setParams(pendingParams);
      dirty = true;
      reset = true;
    });
    raf = requestAnimationFrame(frame);

    var api = {
      play: function () { playing = true; last = null; dirty = true; },
      pause: function () { playing = false; last = null; dirty = true; },
      toggle: function () { if (playing) api.pause(); else api.play(); },
      seek: function (t) { time = duration > 0 ? Math.max(0, Math.min(duration, t)) : 0; dirty = true; reset = true; },
      setParams: function (p) {
        if (art) art.setParams(p);
        else pendingParams = normalizeParams(Object.assign({}, pendingParams, p));
        dirty = true;
        reset = true;
      },
      destroy: function () { if (raf) cancelAnimationFrame(raf); }
    };
    return api;
  }
`;

// The decoder of the context coder, as source text for the standalone file (see ctx-coder.js).
const CODER_SOURCE = [RangeDecoder, codeIndices].map((f) => f.toString()).join('\n');

// Produces the full JavaScript source for the standalone file.
export async function createStandaloneScript(data, params, options) {
  const opts = options || {};
  const runtime = await buildRuntimeSource();
  const p = normalizeParams(params || DEFAULT_PARAMS);
  // Dither artwork is packed as palette indices. Every other algorithm ships its frames and renders them at run time.
  // The Low poly Mosaic reads colour, so a still of that algorithm carries its colour frame.
  const withColour = p.algorithm === 'lowpoly' && data.count === 1 && !!data.colour;
  // Loop render: an animated still can be rendered into a loop of frames (loopFps), played back by the page instead of
  // running the engine live. Video and Dither keep their own formats.
  const framesWanted = !!opts.loopFps && data.count === 1 && !data.duration && p.algorithm !== 'dither' &&
    p.animation !== 'off';
  let payload;
  if (p.algorithm === 'dither') payload = await encodePacked(data, p);
  else if (framesWanted) payload = await encodeLoopFrames(data, p, opts.maxWidth, opts.loopFps, opts.onProgress);
  else payload = await encodeData(data, opts.maxWidth, withColour);
  // Packed Dither artwork is a fixed picture (see encodePacked), so it does not carry motion.
  const title = opts.title || 'JS Rusty artwork';

  return [
    '/*! ' + title + ' - generated by JS Rusty. Standalone: no dependencies. */',
    '(function (global) {',
    "  'use strict';",
    runtime,
    CODER_SOURCE,
    DECODER_SOURCE,
    '  var ARTWORK_DATA = ' + JSON.stringify(payload) + ';',
    '  var ARTWORK_PARAMS = ' + JSON.stringify(p) + ';',
    MOUNT_SOURCE,
    '  global.RasterArt = { mount: mount, DEFAULT_PARAMS: DEFAULT_PARAMS, version: 2 };',
    '})(typeof window !== "undefined" ? window : globalThis);',
    '',
  ].join('\n');
}

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// options: loopFps (0 = live; otherwise the frame rate of a rendered loop), onProgress(i, n) for the loop render.
export async function exportStandaloneJs(data, params, filename, maxWidth, options) {
  const extra = options || {};
  const source = await createStandaloneScript(data, params, {
    title: filename, maxWidth: maxWidth, loopFps: extra.loopFps, onProgress: extra.onProgress,
  });
  downloadBlob(filename, new Blob([source], { type: 'text/javascript' }));
  return source.length;
}
