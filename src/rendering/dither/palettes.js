import { dtSrgbToLinearExact, dtOklabFromLinear } from './colour.js';

// Palette library for the Dither engine. Each preset is a list of exact sRGB colours. The order of the
// list is only the order in which the swatches are shown. Rendering does not depend on it: colours are
// matched by OKLab distance, and ordered mixing works on the colours themselves.
//
// Every entry is parsed and converted once, when this module loads (sRGB 0-1, linear light and OKLab).
// The two-colour mix table for ordered dithering is built the first time a palette is used for an
// ordered method. Custom palettes are rebuilt only when their text changes.

export const DT_PALETTE_CATEGORIES = [
  { id: 'retro-displays', label: 'Retro Displays' },
  { id: 'retro-gaming', label: 'Retro Gaming' },
  { id: 'artistic-photography', label: 'Artistic Photography' },
];

// The 13 presets shown in the library. method is the suggested dithering method; choosing a palette
// does not change the method by itself.
const DT_PRESETS = [
  {
    id: 'green-phosphor', name: 'Green Phosphor', category: 'retro-displays', method: 'floyd-steinberg',
    description: 'Classic monochrome computer terminal with luminous green highlights.',
    use: 'terminal-style monochrome detail',
    hex: ['#071A0F', '#163B24', '#3F7F4F', '#8FCB78', '#D5F5B8'],
  },
  {
    id: 'amber-crt', name: 'Amber CRT', category: 'retro-displays', method: 'floyd-steinberg',
    description: 'Vintage amber phosphor monitor with warm golden highlights.',
    use: 'warm vintage monitor look for portraits and interiors',
    hex: ['#1B1007', '#58300D', '#A65C18', '#E3A34A', '#FFE3A3'],
  },
  {
    id: 'blue-phosphor', name: 'Blue Phosphor', category: 'retro-displays', method: 'jjn',
    description: 'Cold blue monochrome monitor with bright cyan-white highlights.',
    use: 'cold monochrome monitor look, good for night scenes',
    hex: ['#061522', '#123B5B', '#2D7296', '#74B8CE', '#D5F3F5'],
  },
  {
    id: 'game-boy-classic', name: 'Game Boy Classic', category: 'retro-displays', method: 'bayer',
    description: 'Four-shade green LCD appearance inspired by the original handheld console.',
    use: 'handheld-console pixel look',
    hex: ['#0F380F', '#306230', '#8BAC0F', '#9BBC0F'],
  },
  {
    id: 'ibm-cga-neon', name: 'IBM CGA Neon', category: 'retro-displays', method: 'bayer',
    description: 'Classic early PC graphics with electric cyan, magenta, black and white.',
    use: 'early-PC graphics, bold and high-contrast images',
    hex: ['#000000', '#55FFFF', '#FF55FF', '#FFFFFF'],
  },
  {
    id: 'commodore-64', name: 'Commodore 64 Inspired', category: 'retro-gaming', method: 'atkinson',
    description: 'A nostalgic 16-colour palette inspired by vintage home computers.',
    use: 'home-computer illustration and pixel art',
    hex: ['#000000', '#FFFFFF', '#68372B', '#70A4B2', '#6F3D86', '#588D43', '#352879', '#B8C76F',
      '#6F4F25', '#433900', '#9A6759', '#444444', '#6C6C6C', '#9AD284', '#6C5EB5', '#959595'],
  },
  {
    id: 'pico-8', name: 'PICO-8', category: 'retro-gaming', method: 'bayer',
    description: 'The iconic 16-colour fantasy-console palette, suitable for pixel art and stylized graphics.',
    use: 'pixel art and stylised game graphics',
    hex: ['#000000', '#1D2B53', '#7E2553', '#008751', '#AB5236', '#5F574F', '#C2C3C7', '#FFF1E8',
      '#FF004D', '#FFA300', '#FFEC27', '#00E756', '#29ADFF', '#83769C', '#FF77A8', '#FFCCAA'],
  },
  {
    id: 'synthwave-sunset', name: 'Synthwave Sunset', category: 'artistic-photography', method: 'jjn',
    description: 'Retro-futuristic palette with deep purple shadows, neon pinks and warm orange highlights.',
    use: 'neon night scenes and poster looks',
    hex: ['#140B2D', '#4B1D5E', '#A33772', '#F06A5B', '#FFB36B', '#FFF1C1'],
  },
  {
    id: 'thermal-imaging', name: 'Thermal Imaging', category: 'artistic-photography', method: 'floyd-steinberg',
    description: 'False-colour infrared style, transitioning from deep violet to bright yellow-white.',
    use: 'heat-map style images and scientific looks',
    hex: ['#120C3F', '#302A8C', '#7B2CA3', '#D8426A', '#F88A45', '#FFE7A1', '#FFF9D5'],
  },
  {
    id: 'cyanotype', name: 'Cyanotype', category: 'artistic-photography', method: 'floyd-steinberg',
    description: 'Historical photographic printing aesthetic using navy, blue and turquoise shades.',
    use: 'blueprint and historical photographic prints',
    hex: ['#071B2C', '#123D52', '#2E7184', '#78B6BD', '#B5DAD0', '#E2F3E8'],
  },
  {
    id: 'vintage-newsprint', name: 'Vintage Newsprint', category: 'artistic-photography', method: 'blue-noise',
    description: 'Aged newspaper and printed photograph appearance with warm paper and faded ink colours.',
    use: 'printed-page and halftone-era photographs',
    hex: ['#171411', '#514B43', '#9B9284', '#C8BDAA', '#E1D7C6', '#F7F0E2'],
  },
  {
    id: 'vintage-sepia', name: 'Vintage Sepia', category: 'artistic-photography', method: 'jjn',
    description: 'Antique photographic print with brown shadows, faded midtones and aged cream highlights.',
    use: 'antique portraits and archive photographs',
    hex: ['#21150F', '#593A28', '#906747', '#C49A6C', '#E4CBA4', '#F6E8CC'],
  },
  {
    id: 'arctic-frost', name: 'Arctic Frost', category: 'artistic-photography', method: 'floyd-steinberg',
    description: 'Cold, atmospheric winter aesthetic with desaturated blues, icy turquoise and pale highlights.',
    use: 'winter and cold-light landscapes',
    hex: ['#081A2A', '#1D4965', '#4F8FA3', '#9AC7C3', '#D0E1D8', '#EFF4E8'],
  },
];

// Palettes kept for settings saved by earlier versions. They are not shown in the library.
const DT_LEGACY_PALETTES = [
  { id: 'amber', name: 'Amber terminal (legacy)', legacy: true, hex: ['#140a00', '#5c3500', '#b86a00', '#ffb000'] },
  { id: 'riso', name: 'Risograph (legacy)', legacy: true, hex: ['#1b1b1b', '#0078bf', '#ff48b0', '#ffe800', '#f4efe6'] },
  { id: 'pastel', name: 'Pastel (legacy)', legacy: true, hex: ['#22223b', '#4a4e69', '#9a8c98', '#c9ada7', '#f2e9e4', '#ffd6a5'] },
  { id: 'sunset', name: 'Sunset (legacy)', legacy: true, hex: ['#1a1423', '#3d2645', '#6e2f5f', '#b03a48', '#e2572b', '#f29e4c', '#f7d774', '#fff4d6'] },
];

// Old names that map to presets with the same colours.
const DT_PALETTE_ALIASES = { gameboy: 'game-boy-classic', cga: 'ibm-cga-neon' };

// The library shown in the sidebar.
export const DT_PALETTE_LIBRARY = DT_PRESETS;

const DT_PALETTE_BY_ID = {};
for (const entry of DT_PRESETS.concat(DT_LEGACY_PALETTES)) {
  entry.set = dtBuildColourSet(dtParseHexList(entry.hex.join(' ')));
  DT_PALETTE_BY_ID[entry.id] = entry;
}

// The preset or legacy entry for an id (old names included), or null.
export function dtFindPreset(id) {
  const key = Object.prototype.hasOwnProperty.call(DT_PALETTE_ALIASES, id) ? DT_PALETTE_ALIASES[id] : id;
  return Object.prototype.hasOwnProperty.call(DT_PALETTE_BY_ID, key) ? DT_PALETTE_BY_ID[key] : null;
}

// Normalises a HEX colour ("#1a2B3c", "1a2b3c", "#abc") to "#rrggbb" in lower case, or null.
export function dtNormaliseHex(text) {
  let h = String(text || '').trim().replace(/^#/, '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return '#' + h.toLowerCase();
}

// Parses "#ff0000, 00ff00 #00f" into [r, g, b] triples (0-255). Invalid tokens are skipped and at most
// 16 colours are kept.
export function dtParseHexList(text) {
  const out = [];
  const tokens = String(text || '').split(/[\s,;]+/);
  for (let t = 0; t < tokens.length && out.length < 16; t++) {
    const hex = dtNormaliseHex(tokens[t]);
    if (!hex) continue;
    out.push([parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]);
  }
  return out;
}

// Builds the numeric form of a palette from [r, g, b] triples: sRGB 0-1 (rgb), linear light (lin) and
// OKLab (oklab), each as a flat Float32Array with three values per colour. The mix table is added later.
function dtBuildColourSet(list) {
  const count = list.length;
  const rgb = new Float32Array(count * 3);
  const lin = new Float32Array(count * 3);
  const oklab = new Float32Array(count * 3);
  const lab = new Float32Array(3);
  for (let j = 0; j < count; j++) {
    const k = 3 * j;
    for (let c = 0; c < 3; c++) {
      const s = list[j][c] / 255;
      rgb[k + c] = s;
      lin[k + c] = dtSrgbToLinearExact(s);
    }
    dtOklabFromLinear(lin[k], lin[k + 1], lin[k + 2], lab);
    oklab[k] = lab[0];
    oklab[k + 1] = lab[1];
    oklab[k + 2] = lab[2];
  }
  return { count: count, rgb: rgb, lin: lin, oklab: oklab, mixA: null, mixB: null, mixF: null };
}

// Two-colour mix table for ordered dithering. For each grey level v (0-255, sRGB), it finds the pair of
// palette colours a and b, and the fraction f of b, whose linear-light mix best matches that grey in
// OKLab. When one colour is already the best match, the pair is (a, a) with f = 0. Built once per palette.
export function dtEnsureMixTable(set) {
  if (set.mixA) return set;
  const K = set.count;
  const mixA = new Uint8Array(256);
  const mixB = new Uint8Array(256);
  const mixF = new Float32Array(256);
  const lab = new Float32Array(3);
  const STEPS = 32;
  for (let v = 0; v < 256; v++) {
    const g = dtSrgbToLinearExact(v / 255);
    dtOklabFromLinear(g, g, g, lab);
    const tL = lab[0];
    const tA = lab[1];
    const tB = lab[2];
    let best = Infinity;
    let bestA = 0;
    let bestB = 0;
    let bestF = 0;
    for (let i = 0; i < K; i++) {
      for (let j = i; j < K; j++) {
        const steps = j === i ? 0 : STEPS;
        for (let s = 0; s <= steps; s++) {
          const f = steps ? s / steps : 0;
          const a = 3 * i;
          const b = 3 * j;
          dtOklabFromLinear(
            (1 - f) * set.lin[a] + f * set.lin[b],
            (1 - f) * set.lin[a + 1] + f * set.lin[b + 1],
            (1 - f) * set.lin[a + 2] + f * set.lin[b + 2],
            lab);
          const dL = lab[0] - tL;
          const dA = lab[1] - tA;
          const dB = lab[2] - tB;
          const d = dL * dL + dA * dA + dB * dB;
          if (d < best) {
            best = d;
            bestA = i;
            bestB = j;
            bestF = f;
          }
        }
      }
    }
    mixA[v] = bestA;
    mixB[v] = bestB;
    mixF[v] = bestF;
  }
  set.mixA = mixA;
  set.mixB = mixB;
  set.mixF = mixF;
  return set;
}

// Single-entry cache for a custom palette: rebuilt only when its text changes.
const DT_CUSTOM_CACHE = { text: undefined, set: null };

// Resolves a palette name to its colour set, or null for paper-and-ink. For 'custom', custom is the
// colour list text. A result of null (fewer than two valid colours) makes the renderer fall back to the
// two-colour paper-and-ink rendering.
export function dtResolveColourSet(name, custom) {
  if (name === 'custom') {
    const text = String(custom || '');
    if (DT_CUSTOM_CACHE.text === text) return DT_CUSTOM_CACHE.set;
    const list = dtParseHexList(text);
    DT_CUSTOM_CACHE.text = text;
    DT_CUSTOM_CACHE.set = list.length >= 2 ? dtBuildColourSet(list) : null;
    return DT_CUSTOM_CACHE.set;
  }
  const entry = dtFindPreset(name);
  return entry ? entry.set : null;
}

// Paper (lightest colour) and ink (darkest colour) of a palette, as [r, g, b] integers. The engines that draw
// with two colours use these, so every algorithm takes the palette. Lightness is OKLab L, so the order of the
// palette does not matter.
export function dtPaletteInk(set) {
  let light = 0;
  let dark = 0;
  for (let j = 1; j < set.count; j++) {
    if (set.oklab[3 * j] > set.oklab[3 * light]) light = j;
    if (set.oklab[3 * j] < set.oklab[3 * dark]) dark = j;
  }
  const ints = (j) => [Math.round(set.rgb[3 * j] * 255), Math.round(set.rgb[3 * j + 1] * 255), Math.round(set.rgb[3 * j + 2] * 255)];
  return { paper: ints(light), ink: ints(dark) };
}

