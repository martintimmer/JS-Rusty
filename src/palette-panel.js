// Palette library and custom palettes for the Dither engine, at the top of the Dither panel.
//
// The renderer reads the palette from two parameters: dtPalette (a preset id, 'paper-ink' or 'custom')
// and dtColours (the colour list, used with 'custom'). This panel reports each change through
// onChange(dtPalette, dtColours), so the renderer, the exports and the other controls all read the same
// settings. Nothing here draws artwork.
//
// Editing a preset makes a custom palette based on it. Restore original returns to the preset. Save to
// session keeps a copy in this panel; saved palettes are not kept across reloads. Restore presets clears
// the saved palettes and any edits.

import { DT_PALETTE_LIBRARY, DT_PALETTE_CATEGORIES, dtFindPreset, dtNormaliseHex } from './rendering/dither/palettes.js';

const MIN_COLOURS = 2;
const MAX_COLOURS = 16;
const NEW_COLOUR = '#808080';
const PAPER_INK = 'paper-ink';
const CUSTOM = 'custom';
const METHOD_LABELS = {
  atkinson: 'Atkinson',
  'floyd-steinberg': 'Floyd–Steinberg',
  jjn: 'Jarvis–Judice–Ninke',
  bayer: 'Bayer 8×8',
  bayer4: 'Bayer 4×4',
  random: 'Random threshold',
  'blue-noise': 'Blue noise',
  none: 'None (direct)',
};

// Mini line-art icons for the palette tiles, drawn on the same 32-unit grid as the algorithm icons.
const ICON_OPEN = '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.4" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">';
const PALETTE_ICONS = {
  'green-phosphor': '<rect x="4" y="6" width="24" height="17" rx="2"/><path d="M8 11h10M8 14h14M8 17h7M12 23v4M9 27h14"/>',
  'amber-crt': '<rect x="4" y="6" width="24" height="17" rx="2"/><rect x="8" y="9.5" width="16" height="10" rx="5"/><path d="M12 23v4M9 27h14"/>',
  'blue-phosphor': '<rect x="4" y="6" width="24" height="17" rx="2"/><path d="M9 11l4 3-4 3M15 18h7M12 23v4M9 27h14"/>',
  'game-boy-classic': '<rect x="9" y="4" width="14" height="24" rx="3"/><rect x="11.5" y="8" width="9" height="7" rx="0.5"/><path d="M11 21h4M13 19v4"/><circle cx="20" cy="20" r="1.2"/>',
  'ibm-cga-neon': '<rect x="5" y="5" width="22" height="22" rx="1"/><path d="M5 12.3h22M5 19.7h22M12.3 5v22M19.7 5v22"/>',
  'commodore-64': '<rect x="3" y="9" width="26" height="15" rx="2"/><path d="M6 13h2M10 13h2M14 13h2M18 13h2M22 13h2M7 17h18M9 20.5h14"/>',
  'pico-8': '<path d="M7 5h18v22H7z"/><rect x="11" y="10" width="10" height="8"/><path d="M11 27v-2h10v2"/>',
  'synthwave-sunset': '<path d="M9 19a7 7 0 0 1 14 0"/><path d="M4 19h24M7 23h18M11 27h10"/>',
  'thermal-imaging': '<path d="M14 6a2 2 0 0 1 4 0v14a4 4 0 1 1-4 0z"/><path d="M20 9h3M20 13h2M20 17h3"/>',
  cyanotype: '<path d="M8 24C8 14 14 8 24 8C24 18 18 24 8 24Z"/><path d="M8 24L18 14"/>',
  'vintage-newsprint': '<rect x="5" y="6" width="22" height="20" rx="1"/><path d="M9 11h6M9 15h6M9 19h6M18 11h5v6h-5z"/>',
  'vintage-sepia': '<rect x="5" y="6" width="22" height="20" rx="1"/><rect x="8" y="9" width="16" height="11"/><path d="M8 18l5-4 4 3 3-2 4 3"/>',
  'arctic-frost': '<path d="M16 5v22M5.5 10.5l21 11M5.5 21.5l21-11"/><path d="M13 7l3 2 3-2M13 25l3-2 3 2"/>',
  'paper-ink': '<circle cx="16" cy="16" r="11"/><path d="M16 5v22M11 9v14M21 9v14"/>',
  saved: '<path d="M10 5h12v22l-6-5-6 5z"/>',
};

const $ = (id) => document.getElementById(id);

// active: the palette in use, a preset id, PAPER_INK or CUSTOM. editor: the palette being edited
// ({ basedOn, name, hex }), or null for paper and ink. saved: palettes saved in this session.
const session = { active: PAPER_INK, editor: null, saved: [], savedCount: 0 };
let handlers = { onChange: () => {}, onMethod: () => {} };

// Wires the library and the editor. onChange(dtPalette, dtColours) and onMethod(method) are called when the
// user chooses a palette, edits colours, or applies a palette's suggested method.
export function initPalettePanel(options) {
  handlers = options;
  $('pl-new').addEventListener('click', newPalette);
  $('pe-add').addEventListener('click', addColour);
  $('pe-save').addEventListener('click', saveToSession);
  $('pe-restore').addEventListener('click', restoreOriginal);
  $('pe-restore-presets').addEventListener('click', restorePresets);
  $('pe-use-method').addEventListener('click', () => {
    const method = editorSuggestedMethod();
    if (method) handlers.onMethod(method);
  });
  $('pe-name').addEventListener('input', () => {
    if (session.editor) session.editor.name = $('pe-name').value;
  });
  const rows = $('pe-colours');
  rows.addEventListener('input', onPickerInput);
  rows.addEventListener('change', onRowChange);
  rows.addEventListener('click', onRowButton);
  renderAll();
}

// Shows the palette that the parameters name. Used at start-up and after a reset.
export function setActivePalette(dtPalette, dtColours) {
  if (dtPalette === CUSTOM) {
    const hex = parseHexText(dtColours);
    session.active = CUSTOM;
    session.editor = { basedOn: null, name: 'Custom palette', hex: hex.length >= MIN_COLOURS ? hex : ['#000000', '#ffffff'] };
  } else {
    const preset = dtFindPreset(dtPalette);
    if (preset) {
      session.active = preset.id;
      session.editor = { basedOn: preset.id, name: preset.name, hex: lower(preset.hex) };
    } else {
      session.active = PAPER_INK;
      session.editor = null;
    }
  }
  renderAll();
}

// ---------- Choosing and committing ----------

function selectPreset(id) {
  const preset = dtFindPreset(id);
  if (!preset) return;
  session.editor = { basedOn: preset.id, name: preset.name, hex: lower(preset.hex) };
  setNote('');
  commit(true);
}

function selectPaperInk() {
  session.editor = null;
  setNote('');
  commit(true);
}

function selectSaved(index) {
  const saved = session.saved[index];
  if (!saved) return;
  session.editor = { basedOn: saved.basedOn, name: saved.name, hex: saved.hex.slice() };
  setNote('');
  commit(true);
}

// Sends the editor to the renderer. A preset whose colours are unchanged is sent by id. Any other colours
// are sent as a custom palette.
function commit(rerender) {
  const ed = session.editor;
  if (!ed) {
    session.active = PAPER_INK;
    handlers.onChange(PAPER_INK, '');
  } else {
    const preset = ed.basedOn ? dtFindPreset(ed.basedOn) : null;
    if (preset && sameHex(ed.hex, preset.hex)) {
      session.active = preset.id;
      handlers.onChange(preset.id, '');
    } else {
      session.active = CUSTOM;
      handlers.onChange(CUSTOM, ed.hex.join(','));
    }
  }
  if (rerender) renderAll();
}

function newPalette() {
  session.editor = { basedOn: null, name: 'Custom palette', hex: ['#000000', '#ffffff'] };
  setNote('');
  commit(true);
}

function addColour() {
  const ed = session.editor;
  if (!ed) return;
  if (ed.hex.length >= MAX_COLOURS) {
    setNote('Sixteen colours is the maximum.');
    return;
  }
  ed.hex.push(NEW_COLOUR);
  setNote('');
  commit(true);
}

function saveToSession() {
  const ed = session.editor;
  if (!ed) return;
  session.savedCount += 1;
  session.saved.push({
    id: 'session-' + session.savedCount,
    name: (ed.name || '').trim() || 'Custom palette',
    hex: ed.hex.slice(),
    basedOn: ed.basedOn,
  });
  setNote('Saved to this session.');
  renderAll();
}

function restoreOriginal() {
  const ed = session.editor;
  if (ed && ed.basedOn) selectPreset(ed.basedOn);
}

// Clears the saved palettes and any edits. If the palette in use is based on a preset, it returns to
// that preset's original colours; otherwise paper and ink becomes active.
function restorePresets() {
  const based = session.editor && session.editor.basedOn ? session.editor.basedOn : null;
  session.saved = [];
  if (based) {
    selectPreset(based);
  } else {
    session.editor = null;
    commit(true);
  }
  setNote('Saved palettes cleared. Presets restored.');
}

function editorSuggestedMethod() {
  const ed = session.editor;
  const preset = ed && ed.basedOn ? dtFindPreset(ed.basedOn) : null;
  return preset && preset.method ? preset.method : null;
}

// ---------- Editing colours ----------

function rowIndex(node) {
  const row = node.closest('.palette-row');
  return row ? Number(row.dataset.index) : -1;
}

// While a colour picker is dragged, update the colour without rebuilding the rows, so the picker stays open.
function onPickerInput(e) {
  const target = e.target;
  if (!session.editor || !target.classList.contains('pe-picker')) return;
  const i = rowIndex(target);
  const hex = dtNormaliseHex(target.value);
  if (i < 0 || !hex) return;
  session.editor.hex[i] = hex;
  target.closest('.palette-row').querySelector('.pe-hex').value = hex.toUpperCase();
  commit(false);
}

function onRowChange(e) {
  const target = e.target;
  if (!session.editor) return;
  const i = rowIndex(target);
  if (i < 0) return;
  if (target.classList.contains('pe-picker')) {
    const hex = dtNormaliseHex(target.value);
    if (!hex) return;
    session.editor.hex[i] = hex;
    setNote('');
    commit(true);
    return;
  }
  if (target.classList.contains('pe-hex')) {
    const hex = dtNormaliseHex(target.value);
    if (!hex) {
      setNote('Enter a HEX colour such as #1A2B3C.');
      renderEditor();
      return;
    }
    session.editor.hex[i] = hex;
    setNote('');
    commit(true);
  }
}

function onRowButton(e) {
  const button = e.target.closest('button[data-act]');
  if (!button || !session.editor) return;
  const i = rowIndex(button);
  const hex = session.editor.hex;
  if (button.dataset.act === 'remove') {
    if (hex.length <= MIN_COLOURS) {
      setNote('Two colours is the minimum.');
      return;
    }
    hex.splice(i, 1);
  } else {
    const j = button.dataset.act === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= hex.length) return;
    const moved = hex[i];
    hex[i] = hex[j];
    hex[j] = moved;
  }
  setNote('');
  commit(true);
}

// ---------- Rendering ----------

function renderAll() {
  renderGroups();
  renderEditor();
}

function renderGroups() {
  const box = $('palette-groups');
  box.textContent = '';
  box.appendChild(groupTitle('Standard'));
  box.appendChild(paperInkCard());
  for (const category of DT_PALETTE_CATEGORIES) {
    const members = DT_PALETTE_LIBRARY.filter((p) => p.category === category.id);
    if (!members.length) continue;
    box.appendChild(groupTitle(category.label));
    const grid = el('div', 'palette-grid');
    for (const preset of members) grid.appendChild(presetCard(preset));
    box.appendChild(grid);
  }
  if (session.saved.length) {
    box.appendChild(groupTitle('Saved this session'));
    const grid = el('div', 'palette-grid');
    session.saved.forEach((saved, i) => grid.appendChild(savedCard(saved, i)));
    box.appendChild(grid);
  }
}

function paperInkCard() {
  // The default paper and ink (the sepia palette), shown as its two colours.
  return tile(session.active === PAPER_INK, selectPaperInk, 'Paper and ink', ['#efe7cf', '#3a352a'], 'paper-ink');
}

function presetCard(preset) {
  return tile(session.active === preset.id, () => selectPreset(preset.id), preset.name, preset.hex, preset.id);
}

function savedCard(saved, index) {
  const selected = session.active === CUSTOM && session.editor && sameHex(session.editor.hex, saved.hex);
  return tile(selected, () => selectSaved(index), saved.name, saved.hex, 'saved');
}

// One compact tile: a mini line-art icon, the name, and a thin strip of the palette's colours.
function tile(selected, onClick, name, colours, iconId) {
  const button = el('button', 'palette-tile');
  button.type = 'button';
  button.setAttribute('role', 'radio');
  button.setAttribute('aria-checked', selected ? 'true' : 'false');
  button.title = name;
  if (selected) button.classList.add('selected');
  button.addEventListener('click', onClick);
  const icon = el('i', 'palette-icon');
  icon.innerHTML = ICON_OPEN + (PALETTE_ICONS[iconId] || PALETTE_ICONS['paper-ink']) + '</svg>';
  button.appendChild(icon);
  button.appendChild(el('span', 'palette-tile-name', name));
  button.appendChild(swatchStrip(colours));
  return button;
}

function swatchStrip(hex) {
  const strip = el('span', 'palette-strip');
  for (const colour of hex) {
    const swatch = el('span');
    swatch.style.backgroundColor = colour;
    strip.appendChild(swatch);
  }
  return strip;
}

function groupTitle(text) {
  return el('div', 'palette-group-title', text);
}

function renderEditor() {
  const ed = session.editor;
  $('palette-editor').hidden = !ed;
  if (!ed) return;
  const preset = ed.basedOn ? dtFindPreset(ed.basedOn) : null;
  const edited = preset ? !sameHex(ed.hex, preset.hex) : false;
  $('pe-title').textContent = preset ? (edited ? 'Edited: ' + preset.name : preset.name) : 'Custom palette';
  $('pe-name').value = ed.name;
  $('pe-count').textContent = ed.hex.length + ' of ' + MAX_COLOURS + ' · ' + MIN_COLOURS + ' minimum';
  $('pe-restore').hidden = !edited;
  const method = preset && preset.method ? preset.method : null;
  $('pe-method').hidden = !method;
  if (method) $('pe-method-text').textContent = 'Suggested method: ' + METHOD_LABELS[method];
  $('pe-add').disabled = ed.hex.length >= MAX_COLOURS;
  renderRows(ed.hex);
}

function renderRows(hex) {
  const box = $('pe-colours');
  box.textContent = '';
  hex.forEach((colour, i) => {
    const row = el('div', 'palette-row');
    row.dataset.index = String(i);
    const picker = document.createElement('input');
    picker.type = 'color';
    picker.className = 'pe-picker';
    picker.value = colour.toLowerCase();
    picker.setAttribute('aria-label', 'Colour ' + (i + 1));
    const text = document.createElement('input');
    text.type = 'text';
    text.className = 'pe-hex';
    text.value = colour.toUpperCase();
    text.maxLength = 7;
    text.spellcheck = false;
    text.setAttribute('aria-label', 'Colour ' + (i + 1) + ' HEX');
    row.appendChild(picker);
    row.appendChild(text);
    row.appendChild(rowButton('up', '↑', 'Move up', i === 0));
    row.appendChild(rowButton('down', '↓', 'Move down', i === hex.length - 1));
    row.appendChild(rowButton('remove', '×', 'Remove colour', hex.length <= MIN_COLOURS));
    box.appendChild(row);
  });
}

function rowButton(act, label, title, disabled) {
  const button = el('button', 'btn small icon', label);
  button.type = 'button';
  button.dataset.act = act;
  button.title = title;
  button.setAttribute('aria-label', title);
  button.disabled = disabled;
  return button;
}

function setNote(text) {
  $('pe-note').textContent = text || '';
}

// ---------- Helpers ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function lower(list) {
  return list.map((hex) => hex.toLowerCase());
}

function sameHex(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].toLowerCase() !== b[i].toLowerCase()) return false;
  }
  return true;
}

// Parses "#ff0000, 00ff00 #00f" into normalised hex values, skipping invalid tokens, at most 16.
function parseHexText(text) {
  return String(text || '')
    .split(/[\s,;]+/)
    .map((token) => dtNormaliseHex(token))
    .filter((hex) => hex !== null)
    .slice(0, MAX_COLOURS);
}
