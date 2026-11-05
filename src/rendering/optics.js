import { clamp, lerp } from './core.js';

// Optics: two optional effects on the finished frame, applied after the engine has drawn it.
//   Halation             the bright parts of the picture give off light that spreads into the dark parts around them
//                        and warms them, as light does in film. It is worked out on a copy a quarter of the size, and
//                        is added back over the frame with Screen.
//   Chromatic aberration a lens that magnifies red a little more than blue, so the colours fringe toward the edges.
//                        Each colour is taken from a copy of the frame, scaled about the centre, and the three are
//                        added back together.
// Both work on the canvas itself, so the preview, the exports and the recordings all carry them. A strength of 0 is
// off and leaves the frame as the engine drew it.
// Names here are shared with the standalone export, so they all start with op.

const OP_DOWN = 4; // halation is worked out on a frame this many times smaller
const OP_REACH = 0.015; // the largest scale change of the aberration, at strength 100 (about 16 px at a 1080p corner)

export function createOpticsState() {
  return { small: null, img: null, r: null, g: null, b: null, t: null, src: null, tmp: null };
}

// A canvas kept in the state under key, at the size asked for.
function opCanvas(state, key, w, h) {
  let c = state[key];
  if (!c) {
    c = document.createElement('canvas');
    state[key] = c;
  }
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  return c;
}

function opSmooth(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

// Box blur of a w x h Float32Array, in place, with radius r: one horizontal and one vertical pass, edges clamped.
function opBlur(buf, tmp, w, h, r) {
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += buf[row + (i < 0 ? 0 : (i >= w ? w - 1 : i))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum * inv;
      const add = x + r + 1;
      const sub = x - r;
      sum += buf[row + (add >= w ? w - 1 : add)] - buf[row + (sub < 0 ? 0 : sub)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += tmp[(i < 0 ? 0 : (i >= h ? h - 1 : i)) * w + x];
    for (let y = 0; y < h; y++) {
      buf[y * w + x] = sum * inv;
      const add = y + r + 1;
      const sub = y - r;
      sum += tmp[(add >= h ? h - 1 : add) * w + x] - tmp[(sub < 0 ? 0 : sub) * w + x];
    }
  }
}

// Halation. strength (0-100) is how much light is added; size (0-100) is how far it spreads.
export function applyHalation(ctx, W, H, state, strength, size, scale) {
  const sw = Math.max(4, Math.round(W / OP_DOWN));
  const sh = Math.max(4, Math.round(H / OP_DOWN));
  const n = sw * sh;
  const small = opCanvas(state, 'small', sw, sh);
  const sctx = small.getContext('2d', { willReadFrequently: true });
  sctx.globalCompositeOperation = 'source-over';
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(ctx.canvas, 0, 0, sw, sh);
  const pixels = sctx.getImageData(0, 0, sw, sh).data;

  if (!state.r || state.r.length !== n) {
    state.r = new Float32Array(n);
    state.g = new Float32Array(n);
    state.b = new Float32Array(n);
    state.t = new Float32Array(n);
  }
  if (!state.img || state.img.width !== sw || state.img.height !== sh) {
    state.img = sctx.createImageData(sw, sh);
  }
  const R = state.r;
  const G = state.g;
  const B = state.b;
  // Only the bright parts give off light: a knee on luminance, and warm, as the emulsion's halation is (red strongest).
  for (let i = 0; i < n; i++) {
    const o = 4 * i;
    const lum = (0.3 * pixels[o] + 0.59 * pixels[o + 1] + 0.11 * pixels[o + 2]) / 255;
    const k = opSmooth(0.55, 0.9, lum);
    R[i] = (k * pixels[o]) / 255;
    G[i] = (k * pixels[o + 1]) / 255 * 0.5;
    B[i] = (k * pixels[o + 2]) / 255 * 0.25;
  }
  const radius = Math.max(1, Math.round((lerp(6, 90, clamp(size, 0, 100) / 100) * scale) / OP_DOWN));
  for (const buf of [R, G, B]) {
    opBlur(buf, state.t, sw, sh, radius);
    opBlur(buf, state.t, sw, sh, radius);
  }

  const out = state.img.data;
  for (let i = 0; i < n; i++) {
    const o = 4 * i;
    out[o] = R[i] * 255;
    out[o + 1] = G[i] * 255;
    out[o + 2] = B[i] * 255;
    out[o + 3] = 255;
  }
  sctx.putImageData(state.img, 0, 0);
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = 0.8 * clamp(strength, 0, 100) / 100;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(small, 0, 0, sw, sh, 0, 0, W, H);
  ctx.restore();
}

// Chromatic aberration. strength (0-100) is how far red and blue part from green toward the edges.
export function applyAberration(ctx, W, H, state, strength) {
  const src = opCanvas(state, 'src', W, H);
  const sctx = src.getContext('2d');
  sctx.globalCompositeOperation = 'copy';
  sctx.drawImage(ctx.canvas, 0, 0);
  sctx.globalCompositeOperation = 'source-over';

  const tmp = opCanvas(state, 'tmp', W, H);
  const tctx = tmp.getContext('2d');
  const reach = OP_REACH * clamp(strength, 0, 100) / 100;
  const cx = W / 2;
  const cy = H / 2;
  // Each colour is kept from the copy by multiplying with that colour alone, then scaled about the centre and added to
  // the frame, which starts black. Red grows, blue shrinks, green stays.
  const layers = [
    { rgb: 'rgb(255,0,0)', s: 1 + reach },
    { rgb: 'rgb(0,255,0)', s: 1 },
    { rgb: 'rgb(0,0,255)', s: 1 - reach },
  ];
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'lighter';
  for (const layer of layers) {
    tctx.globalCompositeOperation = 'copy';
    tctx.drawImage(src, 0, 0);
    tctx.globalCompositeOperation = 'multiply';
    tctx.fillStyle = layer.rgb;
    tctx.fillRect(0, 0, W, H);
    tctx.globalCompositeOperation = 'source-over';
    ctx.setTransform(layer.s, 0, 0, layer.s, cx * (1 - layer.s), cy * (1 - layer.s));
    ctx.drawImage(tmp, 0, 0);
  }
  ctx.restore();
}
