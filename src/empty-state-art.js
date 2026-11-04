// The drawing on the empty canvas: a small landscape drawn in lines and flat colour. Its colours come from the
// palette presets, the same ones the Palette panel lists. Every few seconds the next preset is applied, and the
// colours fade from one to the next. A caption under the drawing names the preset and shows its colours.
// With reduced motion the drawing is shown finished and the presets do not change.

import { DT_PALETTE_LIBRARY } from './rendering/dither/palettes.js';

const FIRST_PRESET = 'vintage-sepia';
const SWAP_MS = 6000;
const LIFT_BELOW = 0.22;               // colours darker than this relative luminance are lifted, so lines show on the dark stage
const LIFT_TOWARDS = [236, 233, 226];  // the app's text colour; lifted colours are mixed towards it
const LIFT_AMOUNT = 0.45;
const CAPTION_SWATCHES = 8;

export function initEmptyStateArt() {
  const art = document.querySelector('.dy-art');
  const name = document.getElementById('dy-name');
  const swatches = document.getElementById('dy-swatches');
  const presets = DT_PALETTE_LIBRARY;
  if (!art || !name || !swatches || !presets.length) return;

  let index = Math.max(0, presets.findIndex((p) => p.id === FIRST_PRESET));
  const show = () => {
    const preset = presets[index];
    roleColours(preset.hex).forEach((hex, i) => art.style.setProperty('--dy-c' + i, hex));
    name.textContent = preset.name;
    swatches.replaceChildren(...evenly(preset.hex, CAPTION_SWATCHES).map((hex) => {
      const dot = document.createElement('i');
      dot.style.background = hex;
      return dot;
    }));
  };
  show();

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  setInterval(() => {
    if (document.hidden) return;
    index = (index + 1) % presets.length;
    show();
  }, SWAP_MS);
}

// Six roles for the drawing, taken from the preset's colours sorted brightest first:
// 0 frame and near-hill contours, 1 sun and hatching, 2 far hill, 3 near hill, 4 corner marks and dots, 5 contours and bird.
function roleColours(hexes) {
  const sorted = hexes.slice().sort((a, b) => luminance(b) - luminance(a));
  const at = (fraction) => sorted[Math.round(fraction * (sorted.length - 1))];
  return [at(0), at(0.12), at(0.5), at(0.85), at(0.2), at(0.35)].map(lift);
}

// Relative luminance (WCAG) of a '#rrggbb' colour, from 0 to 1.
function luminance(hex) {
  const channel = (i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function lift(hex) {
  if (luminance(hex) >= LIFT_BELOW) return hex;
  const mixed = [1, 3, 5].map((start, i) => {
    const c = parseInt(hex.slice(start, start + 2), 16);
    return Math.round(c + (LIFT_TOWARDS[i] - c) * LIFT_AMOUNT);
  });
  return '#' + mixed.map((v) => v.toString(16).padStart(2, '0')).join('');
}

// Up to n colours spread evenly along a palette, so a long palette still fits in the caption.
function evenly(list, n) {
  if (list.length <= n) return list;
  const out = [];
  for (let i = 0; i < n; i++) out.push(list[Math.round((i * (list.length - 1)) / (n - 1))]);
  return out;
}
