// Which sidebar controls each algorithm and motion type uses, and what each one means for it.
// Derived from the engine code: a control is listed only if the engine reads it.
// Global controls (contrast, brightness, palette, background) apply to every algorithm.
// Some controls need a video source (motion) or a particular pattern (line wobble only exists
// for horizontal engraving). This module has no DOM access, so it can be tested directly.

const VIDEO = (x) => x.mediaKind === 'video';
const HORIZONTAL = (x) => x.pattern === 'horizontal';
// Error-diffusion methods only (ordered methods have no error to diffuse).
const DIFFUSION = (x) => ['atkinson', 'floyd-steinberg', 'jjn'].indexOf(x.dtMethod) >= 0;
// Ordered and random threshold methods: the threshold pattern, which Dither strength scales.
const ORDERED = (x) => ['bayer', 'bayer4', 'random', 'blue-noise'].indexOf(x.dtMethod) >= 0;
// Random threshold: the scatter pattern, which Seed chooses.
const RANDOM = (x) => x.dtMethod === 'random';

function ctl(label, hint, when) {
  return { label: label, hint: hint, when: when || null };
}

const EDGE = ctl('Edge halo', 'Heavier outline and lighter margin around dark subjects.');
// Detail and Edge halo act on the shared analysis grid, so every algorithm gets them. An algorithm that has no
// specific control for Detail gets this general one.
const GRID_DETAIL = ctl('Detail', 'How much fine structure the analysis keeps. Lower values smooth more.');
// Oil paint and pixel sort read the luminance grid, which the halo does not change, so they have no Edge halo.
const GRID_EDGE_UNUSED = ['oil', 'sort'];
// Tonal levels are ignored while a palette from the library is chosen.
const PAPER_INK_ONLY = (x) => !(x.dtPalette && x.dtPalette !== 'paper-ink');

// Per-algorithm controls. Keys are the control ids used in index.html (data-ctrl).
const SPEC = {
  engraving: {
    detail: ctl('Line wobble', 'Hand-drawn waviness of each horizontal line.', HORIZONTAL),
    density: ctl('Line density', 'Number of lines (the pitch between them).'),
    edge: EDGE,
    thickness: ctl('Line weight', 'Maximum weight of the darkest lines.'),
    pattern: ctl('Pattern', 'Horizontal, diagonal or crosshatched lines.'),
  },
  stippling: {
    detail: ctl('Dot concentration', 'How strongly dots gather in the darkest areas.'),
    particles: ctl('Dots', 'Number of dots.'),
    edge: EDGE,
    thickness: ctl('Dot size', 'Size of each dot.'),
    motion: ctl('Motion influence', 'How strongly video motion moves the dots.', VIDEO),
  },
  contour: {
    detail: ctl('Contour detail', 'Grid resolution of the contour lines (finer is slower).'),
    density: ctl('Contour levels', 'Number of contour lines.'),
    edge: EDGE,
    thickness: ctl('Line weight', 'Width of the contour lines.'),
    motion: ctl('Motion influence', 'How strongly video motion moves the lines.', VIDEO),
  },
  'contour-drawing': {
    detail: ctl('Grid detail', 'Resolution of the contour search (finer is slower).'),
    edge: EDGE,
    thickness: ctl('Line weight', 'Maximum width of a line.'),
    cdLevels: ctl('Levels', 'Number of contour lines.'),
    cdSmooth: ctl('Smoothing', 'Blur before the lines are found: smoother lines, fewer wobbles.'),
    cdTaper: ctl('Taper', 'How much each line thins toward its ends.'),
    cdToneWeight: ctl('Tone weight', 'Darker levels get heavier lines.'),
    cdShade: ctl('Level shading', 'Lighter levels are drawn in lighter ink.'),
    cdJitter: ctl('Hand jitter', 'A small irregular wobble, as if drawn by hand.'),
    cdMinLen: ctl('Minimum length', 'Short fragments below this length are dropped (px at 1080p).'),
    cdBreaks: ctl('Breaks', 'How often a line is interrupted.'),
    cdHatch: ctl('Hatch fill', 'Hatching in the darkest areas.'),
    cdHatchAngle: ctl('Hatch angle', 'Direction of the hatching lines.'),
    cdHatchSpacing: ctl('Hatch spacing', 'Distance between hatching lines (px at 1080p).'),
  },
  lowpoly: {
    density: ctl('Facet size', 'Size of the triangles (smaller = more facets).'),
    edge: EDGE,
    lpJitter: ctl('Vertex jitter', 'How irregular the point placement is.'),
    lpShades: ctl('Shades', 'Number of different triangle shades.'),
    lpBias: ctl('Feature detail', 'How strongly facets gather on edges and features (0 = even).'),
    lpGap: ctl('Facet gap', 'Paper gap between triangles.'),
    lpOutline: ctl('Outline', 'Strength of the lines between triangles.'),
  },
  halftone: {
    density: ctl('Screen pitch', 'Spacing of the dot screen.'),
    edge: EDGE,
    thickness: ctl('Dot size', 'Maximum size of each dot.'),
  },
  pencil: {
    detail: ctl('Stroke length', 'Length of the pencil strokes.'),
    density: ctl('Pressure', 'How hard the pencil presses (how much shading).'),
    edge: EDGE,
  },
  waves: {
    detail: ctl('Ridge height', 'How high the dark areas lift each line.'),
    density: ctl('Row pitch', 'Spacing between the lines.'),
    edge: EDGE,
    thickness: ctl('Line weight', 'Width of each line.'),
  },
  dither: {
    density: ctl('Tone gain', 'Contrast applied before dithering (higher = more black and white).'),
    edge: EDGE,
    dtMethod: ctl('Method', 'Error diffusion (Atkinson, Floyd–Steinberg, Jarvis–Judice–Ninke) or ordered (Bayer 8×8 and 4×4, random threshold, blue noise), or none (direct quantisation).'),
    dtSeed: ctl('Seed', 'The scatter of random threshold dithering. Each seed gives a different pattern; the same seed always gives the same one.', RANDOM),
    dtLevels: ctl('Tonal levels', 'Tones per output (2 = black and white).', PAPER_INK_ONLY),
    saturation: ctl('Saturation', 'Colour strength of the photo, used when Grayscale is off and a palette is chosen. 100% is as photographed.'),
    grayscale: ctl('Grayscale', 'On: palette colours follow the tone. Off: each cell takes the palette colour closest to the photo. Needs a palette. Off by default; choosing an 8 bit palette turns it off.'),
    dtThreshold: ctl('Threshold', 'Tone at which a cell turns to ink. Higher = lighter picture.'),
    dtAdaptive: ctl('Adaptive threshold', 'Each area sets its own threshold from its neighbourhood, keeping detail in dark and bright areas. 0 = global threshold.'),
    dtEdge: ctl('Edge preservation', 'Error leaving a strong edge is reduced, so outlines stay crisp (error diffusion only).', DIFFUSION),
    dtDiffusion: Object.assign(ctl('Diffusion strength', 'How much quantisation error is passed to neighbours.', DIFFUSION), {
      alt: ctl('Dither strength', 'How strongly the threshold pattern is applied. 0% is plain rounding; 100% is the full pattern.', ORDERED),
    }),
    dtSerpentine: ctl('Serpentine scan', 'Alternates the scan direction on each row, reducing streaks.', DIFFUSION),
    dtGamma: ctl('Gamma', 'Midtone curve before dithering. Above 1 lightens, below 1 darkens.'),
    dtNoise: ctl('Grain', 'Grain added to the tone. It is re-rolled on every frame, so it moves.'),
    dtInvert: ctl('Invert', 'Swaps light and dark before dithering.'),
    dtGrid: ctl('Grid size', 'Size of each dither cell in canvas pixels, from 1 px. Larger cells are coarser and faster.'),
    dtTemporal: ctl('Temporal stability', 'Smooths flicker between frames of a video. Off by default.', VIDEO),
  },
  oil: {
    detail: ctl('Brush size', 'Radius of the brush (larger = broader strokes).'),
  },
  linocut: {
    detail: ctl('Gouge length', 'Length of the carved streaks.'),
    density: ctl('Cut amount', 'How much of the middle tone is cut away.'),
    edge: EDGE,
  },
  ascii: {
    detail: ctl('Tone levels', 'Number of different characters used for the tones.'),
    density: ctl('Cell size', 'Size of each character cell (smaller = more detail).'),
    edge: EDGE,
  },
  sort: {
    detail: ctl('Sort threshold', 'Lower edge of the luminance band that gets sorted.'),
    density: ctl('Sort range', 'Upper edge of the luminance band that gets sorted.'),
    direction: ctl('Sort angle', 'Near 90 or 270 degrees sorts columns; otherwise rows.'),
  },
};

// Motion types. Each one is laid over the selected algorithm, so the algorithm's own controls stay
// visible. Where a key is in both, the motion's label and hint are shown while that motion is on.
const MOTION_SPEC = {
  snake: {
    speed: ctl('Snake speed', 'How fast the snakes crawl along the lines (0 = frozen).'),
    animCount: ctl('Snakes', 'Number of snakes.'),
    thickness: ctl('Snake width', 'Width of each snake.'),
    motion: ctl('Motion influence', 'How strongly video motion swells the snake heads.', VIDEO),
  },
  pulse: {
    speed: ctl('Pulse rate', 'How fast the rings travel and the picture breathes (0 = frozen).'),
    velocity: ctl('Pulse depth', 'How deep the rings and the breathing go.'),
    motion: ctl('Motion influence', 'How strongly video motion adds to the displacement.', VIDEO),
  },
  hover: {
    speed: ctl('Hover speed', 'How fast the regions float (0 = frozen).'),
    velocity: ctl('Hover amount', 'How far the regions float.'),
    motion: ctl('Motion influence', 'How strongly video motion pushes the regions.', VIDEO),
  },
  ripple: {
    speed: ctl('Wave speed', 'How fast the wave travels (0 = frozen).'),
    velocity: ctl('Wave height', 'How high the wave lifts the picture.'),
    direction: ctl('Wave direction', 'Direction the wave travels in.'),
    motion: ctl('Motion influence', 'How strongly video motion adds to the displacement.', VIDEO),
  },
};

// Every control that can appear in the right-hand sidebar.
export const RENDER_CONTROL_KEYS = [
  'detail', 'density', 'edge', 'pattern', 'particles', 'animCount', 'motion',
  'speed', 'direction', 'velocity', 'thickness', 'contrast', 'brightness',
  'palette', 'background',
  'cdLevels', 'cdSmooth', 'cdTaper', 'cdToneWeight', 'cdShade', 'cdJitter', 'cdMinLen',
  'cdBreaks', 'cdHatch', 'cdHatchAngle', 'cdHatchSpacing',
  'lpJitter', 'lpShades', 'lpBias', 'lpGap', 'lpOutline',
  'dtMethod', 'dtLevels', 'dtThreshold', 'dtAdaptive', 'dtEdge',
  'dtDiffusion', 'dtSerpentine', 'dtGamma', 'dtNoise', 'dtInvert', 'dtGrid', 'dtTemporal',
  'saturation', 'grayscale', 'dtSeed',
];

// Controls every algorithm has.
const GLOBAL = {
  contrast: ctl('Contrast', 'Contrast of the source before rendering.'),
  brightness: ctl('Brightness', 'Brightness of the source before rendering.'),
  palette: ctl('Palette', 'Ink and paper colours.'),
  background: ctl('Background', 'Paper (light) or ink (dark) background.'),
};

// Returns { [controlKey]: { visible, label, hint } } for an algorithm and context.
// context: { mediaKind, pattern, animation, dtMethod, dtPalette }.
// Palette and Background apply only while no palette from the library is chosen: a palette replaces them.
// Detail and Edge halo are offered to every algorithm that the grid affects (see GRID_DETAIL, GRID_EDGE_UNUSED).
export function controlsFor(algorithm, context) {
  const ctx = context || {};
  const own = SPEC[algorithm] || {};
  const motionOn = !!ctx.animation && ctx.animation !== 'off';
  const motion = motionOn ? (MOTION_SPEC[ctx.animation] || {}) : {};
  const paletteChosen = !!ctx.dtPalette && ctx.dtPalette !== 'paper-ink';
  const out = {};
  for (const key of RENDER_CONTROL_KEYS) {
    if (key === 'palette' || key === 'background') {
      out[key] = { visible: !paletteChosen, label: GLOBAL[key].label, hint: GLOBAL[key].hint };
      continue;
    }
    const globalEntry = GLOBAL[key];
    if (globalEntry) {
      out[key] = { visible: true, label: globalEntry.label, hint: globalEntry.hint };
      continue;
    }
    const motionEntry = motion[key];
    const motionVisible = !!motionEntry && (!motionEntry.when || motionEntry.when(ctx));
    // An entry can carry an alternative (alt) with its own label and rule. Dither strength replaces Diffusion
    // strength for the ordered methods.
    const algoEntry = own[key] && own[key].alt && own[key].alt.when(ctx) ? own[key].alt : own[key];
    const algoVisible = !!algoEntry && (!algoEntry.when || algoEntry.when(ctx));
    let fallback = null;
    if (!own[key] && key === 'detail') fallback = GRID_DETAIL;
    if (!own[key] && key === 'edge' && GRID_EDGE_UNUSED.indexOf(algorithm) < 0) fallback = EDGE;
    const entry = motionVisible ? motionEntry : (algoEntry || fallback);
    out[key] = {
      visible: motionVisible || algoVisible || !!fallback,
      label: entry ? entry.label : key,
      hint: entry ? entry.hint : '',
    };
  }
  return out;
}

// The algorithm ids, in the order they appear in the sidebar.
export const ALGORITHM_IDS = Object.keys(SPEC);

// The motion type ids (the animation choices other than off).
export const MOTION_IDS = Object.keys(MOTION_SPEC);
