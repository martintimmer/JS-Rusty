// Monochrome line-art icons for the algorithm selector. Each glyph is drawn with strokes only, on a 32-unit
// grid, in the current text colour, so the icons follow the interface colours (muted when idle, bright when
// selected). The markup is fixed here (no user content), so inserting it as HTML is safe.
// initAlgorithmIcons adds the glyph to each existing button and leaves the buttons' behaviour alone.

const SVG_OPEN = '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.4" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">';
const SVG_CLOSE = '</svg>';

// Engraving: a sphere cut with horizontal lines that follow its outline.
function engravingGlyph() {
  const out = ['<circle cx="16" cy="16" r="11"/>'];
  for (const y of [9, 12, 15, 18, 21, 24]) {
    const half = Math.sqrt(121 - (y - 16) * (y - 16)) - 1.2;
    out.push('<path d="M' + (16 - half).toFixed(2) + ' ' + y + 'H' + (16 + half).toFixed(2) + '"/>');
  }
  return out.join('');
}

// Stippling: hollow dots, gathered in the middle of the subject.
function stipplingGlyph() {
  const points = [[8, 10], [12, 7], [18, 8], [24, 10], [6, 16], [11, 14], [16, 12], [21, 15], [26, 17],
    [9, 21], [14, 19], [19, 22], [24, 23], [16, 26], [12, 25]];
  const radii = [0.7, 1.1, 0.9, 1.4, 0.8];
  return points.map((p, i) => '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="' + radii[i % radii.length] + '"/>').join('');
}

// Halftone: a 3 x 3 grid of rings that grow toward one corner.
function halftoneGlyph() {
  const out = [];
  const xs = [7, 16, 25];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const radius = (0.9 + 0.5 * (r + c)).toFixed(2);
      out.push('<circle cx="' + xs[c] + '" cy="' + xs[r] + '" r="' + radius + '"/>');
    }
  }
  return out.join('');
}

// Dither: a grid of cells, with a diagonal in every other cell (the checkerboard of dithering).
function ditherGlyph() {
  const out = [];
  const xs = [4, 12, 20];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const x = xs[c];
      const y = xs[r];
      out.push('<rect x="' + x + '" y="' + y + '" width="8" height="8"/>');
      if ((r + c) % 2 === 0) out.push('<path d="M' + x + ' ' + y + 'L' + (x + 8) + ' ' + (y + 8) + '"/>');
    }
  }
  return out.join('');
}

// Pixel sort: outlined bars arranged from short to tall.
function sortGlyph() {
  const out = [];
  const xs = [4, 9.5, 15, 20.5, 26];
  const heights = [6, 10, 15, 20, 25];
  for (let i = 0; i < xs.length; i++) {
    out.push('<rect x="' + xs[i] + '" y="' + (28 - heights[i]) + '" width="4" height="' + heights[i] + '"/>');
  }
  return out.join('');
}

const GLYPHS = {
  engraving: engravingGlyph(),
  stippling: stipplingGlyph(),
  // Contour: nested closed lines, one per tone level.
  contour: '<path d="M5 16C5 8 11 5 16 5S27 8 27 16S21 27 16 27S5 24 5 16Z"/>' +
    '<path d="M9 16C9 11 12 9 16 9S23 11 23 16S20 23 16 23S9 21 9 16Z"/>' +
    '<path d="M13 16C13 14 14 13 16 13S19 14 19 16S18 19 16 19S13 18 13 16Z"/>',
  // Contour drawing: a loose outline, a second pass beside it, and a few hatching strokes.
  'contour-drawing': '<path d="M7 18C5 12 9 7 15 8S27 9 26 16S24 26 17 25S9 25 7 18Z"/>' +
    '<path d="M9.5 19C8.5 14.5 11 10.5 16 10.5"/>' +
    '<path d="M11 23l3-3M15.5 24l4-4"/>',
  // Low poly: a faceted outline with its triangle edges meeting at one point.
  lowpoly: '<path d="M16 5L26 12L23 25L9 26L5 13Z"/>' +
    '<path d="M13 14L16 5M13 14L26 12M13 14L23 25M13 14L9 26M13 14L5 13"/>',
  halftone: halftoneGlyph(),
  // Pencil: a pencil with its point down and to the left, drawing a line.
  pencil: '<path d="M22 6L26 10L13 23L9 19Z"/><path d="M9 19L6 26L13 23"/><path d="M20 8L24 12"/>',
  // Wave lines: three rows lifted by the tone.
  waves: '<path d="M4 11C8 7 12 15 16 11S24 7 28 11"/>' +
    '<path d="M4 16C8 12 12 20 16 16S24 12 28 16"/>' +
    '<path d="M4 21C8 17 12 25 16 21S24 17 28 21"/>',
  dither: ditherGlyph(),
  // Oil paint: a broad brush stroke with its bristle lines.
  oil: '<path d="M5 22C9 14 14 10 22 9C25 8.5 27 10 26 12C22 13 16 16 13 22C11 25 7 25 5 22Z"/>' +
    '<path d="M8 21C12 16 16 14 21 13"/>',
  // Linocut: a carved block, with gouge marks cut into it.
  linocut: '<path d="M5 5H27V27H5Z"/>' +
    '<path d="M9 22l5-5M15 25l7-7M9 12l4-4M17 9l6 0M9 16l2-2"/>',
  // ASCII: a few characters of increasing density.
  ascii: '<text x="16" y="20" text-anchor="middle" fill="currentColor" stroke="none" ' +
    'font-family="ui-monospace, Menlo, monospace" font-size="11" font-weight="600">@#*</text>',
  sort: sortGlyph(),
};

export function algorithmIconSvg(algo) {
  const glyph = GLYPHS[algo];
  return glyph ? SVG_OPEN + glyph + SVG_CLOSE : '';
}

// Adds the icon to each algorithm button in #algorithm-selector, before its label. The label and subtitle
// stay as they are, and the button keeps its click handling.
export function initAlgorithmIcons() {
  for (const button of document.querySelectorAll('#algorithm-selector .seg[data-algo]')) {
    if (button.querySelector('.algo-icon')) continue;
    const tile = document.createElement('i');
    tile.className = 'algo-icon';
    tile.innerHTML = algorithmIconSvg(button.dataset.algo);
    button.insertBefore(tile, button.firstChild);
  }
}
