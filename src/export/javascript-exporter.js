// Builds a standalone, dependency-free JavaScript file that renders the artwork.
// The renderer source is read from the app's own modules (so the export runs the
// exact same engine code), stripped of module syntax, and wrapped in an IIFE that
// exposes `window.RasterArt.mount(target, options)`.
//
// Frame data: 8-bit grayscale at the chosen export width. The first frame is stored
// whole; each later frame is stored as a byte-wise delta from the one before (mostly
// zeros for video), then the whole block is deflate-compressed and base64-encoded.
// Motion vectors are stored as Int8 / Uint8 and base64-encoded.

import { DEFAULT_PARAMS, normalizeParams } from '../rendering/core.js';

// Concatenation order matters: core primitives first, then engines, then the orchestrator.
const RUNTIME_MODULES = [
  '../rendering/core.js',
  '../rendering/flow.js',
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
  '../engines/dither.js',
  '../engines/oil.js',
  '../engines/linocut.js',
  '../engines/ascii.js',
  '../engines/sort.js',
  '../rendering/animation-layer.js',
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
export async function encodeData(data, maxWidth) {
  const targetW = Math.max(16, Math.min(data.width, Math.round(maxWidth || EXPORT_MAX_WIDTH)));
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

  const packed = new Uint8Array(n * count);
  let prev = new Uint8Array(n);
  for (let f = 0; f < count; f++) {
    const src = data.frames[f];
    const cur = new Uint8Array(n);
    for (let i = 0; i < n; i++) cur[i] = src[srcIndex[i]];
    const base = f * n;
    if (f === 0) {
      packed.set(cur, base);
    } else {
      for (let i = 0; i < n; i++) packed[base + i] = (cur[i] - prev[i]) & 255;
    }
    prev = cur;
  }

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
      vx: bytesToBase64(vx),
      vy: bytesToBase64(vy),
      diff: bytesToBase64(m.diff),
    };
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
  function decodeArtworkData(d) {
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
      var motion = null;
      if (d.motion) {
        motion = {
          bs: d.motion.bs, bw: d.motion.bw, bh: d.motion.bh,
          vx: new Int8Array(b64ToBytes(d.motion.vx).buffer),
          vy: new Int8Array(b64ToBytes(d.motion.vy).buffer),
          diff: b64ToBytes(d.motion.diff)
        };
      }
      return { width: d.width, height: d.height, fps: d.fps, duration: d.duration,
               count: d.count, frames: frames, motion: motion };
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
      art = createArtwork(canvas, data);
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

// Produces the full JavaScript source for the standalone file.
export async function createStandaloneScript(data, params, options) {
  const opts = options || {};
  const runtime = await buildRuntimeSource();
  const payload = await encodeData(data, opts.maxWidth);
  const p = normalizeParams(params || DEFAULT_PARAMS);
  const title = opts.title || 'JS Rusty artwork';

  return [
    '/*! ' + title + ' - generated by JS Rusty. Standalone: no dependencies. */',
    '(function (global) {',
    "  'use strict';",
    runtime,
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

export async function exportStandaloneJs(data, params, filename, maxWidth) {
  const source = await createStandaloneScript(data, params, { title: filename, maxWidth: maxWidth });
  downloadBlob(filename, new Blob([source], { type: 'text/javascript' }));
  return source.length;
}
