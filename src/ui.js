import { controlsFor } from './algorithm-controls.js';

// DOM helpers and control bindings. Holds no application state of its own.

const $ = (id) => document.getElementById(id);

export const DOM = {
  get: $,
};

// Range sliders that map directly to rendering parameters.
export const RANGE_CONTROLS = [
  { id: 'r-detail', key: 'detail', out: 'detail-val', fmt: (v) => String(Math.round(v)) },
  { id: 'r-density', key: 'density', out: 'density-val', fmt: (v) => String(Math.round(v)) },
  { id: 'r-contrast', key: 'contrast', out: 'contrast-val', fmt: (v) => v.toFixed(2) },
  { id: 'r-brightness', key: 'brightness', out: 'brightness-val', fmt: (v) => (v > 0 ? '+' : '') + Math.round(v) },
  { id: 'r-edge', key: 'edge', out: 'edge-val', fmt: (v) => v.toFixed(2) },
  { id: 'r-particles', key: 'particles', out: 'particles-val', fmt: (v) => String(Math.round(v)) },
  { id: 'r-anim-count', key: 'animCount', out: 'anim-count-val', fmt: (v) => String(Math.round(v)) },
  { id: 'r-speed', key: 'speed', out: 'speed-val', fmt: (v) => v.toFixed(2) + '×' },
  { id: 'r-motion', key: 'motion', out: 'motion-val', fmt: (v) => v.toFixed(2) },
  { id: 'r-direction', key: 'direction', out: 'direction-val', fmt: (v) => Math.round(v) + '°' },
  { id: 'r-velocity', key: 'velocity', out: 'velocity-val', fmt: (v) => v.toFixed(2) },
  { id: 'r-thickness', key: 'thickness', out: 'thick-val', fmt: (v) => v.toFixed(1) + ' px' },
  { id: 'r-cd-levels', key: 'cdLevels', out: 'cd-levels-val', fmt: (v) => String(Math.round(v)) },
  { id: 'r-cd-smooth', key: 'cdSmooth', out: 'cd-smooth-val', fmt: (v) => String(Math.round(v)) },
  { id: 'r-cd-taper', key: 'cdTaper', out: 'cd-taper-val', fmt: (v) => String(Math.round(v)) },
  { id: 'r-cd-tone-weight', key: 'cdToneWeight', out: 'cd-tone-weight-val', fmt: (v) => String(Math.round(v)) },
  { id: 'r-cd-shade', key: 'cdShade', out: 'cd-shade-val', fmt: (v) => String(Math.round(v)) },
  { id: 'r-cd-jitter', key: 'cdJitter', out: 'cd-jitter-val', fmt: (v) => String(Math.round(v)) },
  { id: 'r-cd-min-len', key: 'cdMinLen', out: 'cd-min-len-val', fmt: (v) => Math.round(v) + ' px' },
  { id: 'r-cd-breaks', key: 'cdBreaks', out: 'cd-breaks-val', fmt: (v) => String(Math.round(v)) },
  { id: 'r-cd-hatch', key: 'cdHatch', out: 'cd-hatch-val', fmt: (v) => String(Math.round(v)) },
  { id: 'r-cd-hatch-angle', key: 'cdHatchAngle', out: 'cd-hatch-angle-val', fmt: (v) => Math.round(v) + '°' },
  { id: 'r-cd-hatch-spacing', key: 'cdHatchSpacing', out: 'cd-hatch-spacing-val', fmt: (v) => Math.round(v) + ' px' },
  { id: 'r-lp-jitter', key: 'lpJitter', out: 'lp-jitter-val', fmt: (v) => String(Math.round(v)) },
  { id: 'r-lp-shades', key: 'lpShades', out: 'lp-shades-val', fmt: (v) => String(Math.round(v)) },
  { id: 'r-lp-bias', key: 'lpBias', out: 'lp-bias-val', fmt: (v) => String(Math.round(v)) },
  { id: 'r-lp-gap', key: 'lpGap', out: 'lp-gap-val', fmt: (v) => Math.round(v) + '%' },
  { id: 'r-lp-outline', key: 'lpOutline', out: 'lp-outline-val', fmt: (v) => String(Math.round(v)) },
  { id: 'r-dt-threshold', key: 'dtThreshold', out: 'dt-threshold-val', fmt: (v) => String(Math.round(v)) },
  { id: 'r-dt-adaptive', key: 'dtAdaptive', out: 'dt-adaptive-val', fmt: (v) => String(Math.round(v)) },
  { id: 'r-dt-edge', key: 'dtEdge', out: 'dt-edge-val', fmt: (v) => String(Math.round(v)) },
  { id: 'r-dt-diffusion', key: 'dtDiffusion', out: 'dt-diffusion-val', fmt: (v) => Math.round(v) + '%' },
  { id: 'r-dt-gamma', key: 'dtGamma', out: 'dt-gamma-val', fmt: (v) => v.toFixed(2) },
  { id: 'r-dt-noise', key: 'dtNoise', out: 'dt-noise-val', fmt: (v) => String(Math.round(v)) },
  { id: 'r-dt-grid', key: 'dtGrid', out: 'dt-grid-val', fmt: (v) => Math.round(v) + ' px' },
  { id: 'r-dt-temporal', key: 'dtTemporal', out: 'dt-temporal-val', fmt: (v) => String(Math.round(v)) },
];

export const SELECT_CONTROLS = [
  { id: 'r-pattern', key: 'pattern' },
  { id: 'r-palette', key: 'palette' },
  { id: 'r-background', key: 'background' },
  { id: 'r-dt-method', key: 'dtMethod' },
  { id: 'r-dt-levels', key: 'dtLevels' },
];

export const CHECK_CONTROLS = [
  { id: 'r-dt-serpentine', key: 'dtSerpentine' },
  { id: 'r-dt-invert', key: 'dtInvert' },
];

// Text controls: none at present (the palette editor is in palette-panel.js).
export const TEXT_CONTROLS = [];

// Binds every rendering control; onChange(key, value) fires on each input event.
export function bindRenderControls(onChange) {
  for (const c of RANGE_CONTROLS) {
    const el = $(c.id);
    el.addEventListener('input', () => {
      const v = parseFloat(el.value);
      $(c.out).textContent = c.fmt(v);
      onChange(c.key, v);
    });
  }
  for (const c of SELECT_CONTROLS) {
    $(c.id).addEventListener('change', () => onChange(c.key, $(c.id).value));
  }
  for (const c of CHECK_CONTROLS) {
    $(c.id).addEventListener('change', () => onChange(c.key, $(c.id).checked));
  }
  for (const c of TEXT_CONTROLS) {
    $(c.id).addEventListener('change', () => onChange(c.key, $(c.id).value));
  }
}

// Writes params back into the controls (used after reset).
export function syncRenderControls(params) {
  for (const c of RANGE_CONTROLS) {
    const el = $(c.id);
    el.value = params[c.key];
    $(c.out).textContent = c.fmt(Number(params[c.key]));
  }
  for (const c of SELECT_CONTROLS) {
    $(c.id).value = params[c.key];
  }
  for (const c of CHECK_CONTROLS) {
    $(c.id).checked = !!params[c.key];
  }
  for (const c of TEXT_CONTROLS) {
    $(c.id).value = params[c.key] == null ? '' : String(params[c.key]);
  }
}

export function setAlgorithm(algo) {
  document.querySelectorAll('#algorithm-selector .seg').forEach((btn) => {
    const on = btn.dataset.algo === algo;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
  });
}

export function setViewMode(mode) {
  document.querySelectorAll('#view-mode .seg').forEach((btn) => {
    const on = btn.dataset.view === mode;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  $('canvas-pair').dataset.view = mode;
  $('split-handle').hidden = mode !== 'split';
}

export function setProgress(fraction, label) {
  const bar = $('progress');
  if (fraction == null) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const pct = Math.round(fraction * 100);
  $('progress-bar').style.width = pct + '%';
  $('progress-text').textContent = label || (pct + '%');
}

export function setText(id, text) {
  $(id).textContent = text;
}

export function setDisabled(id, disabled) {
  $(id).disabled = !!disabled;
}

export function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(2) + ' MB';
}

export function formatTime(seconds) {
  const s = Math.max(0, seconds || 0);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return m + ':' + (rest < 10 ? '0' : '') + rest.toFixed(2).padStart(5, '0');
}

// Sizes the preview so the artwork fits the stage at the chosen zoom.
// zoom is a multiplier on the fit scale (1 = fit).
export function layoutPreview(naturalW, naturalH, zoom) {
  const stage = $('stage');
  const availW = Math.max(120, stage.clientWidth - 56);
  const availH = Math.max(120, stage.clientHeight - 56);
  const fit = Math.min(availW / naturalW, availH / naturalH);
  const scale = fit * zoom;
  const pair = $('canvas-pair');
  pair.style.width = Math.round(naturalW * scale) + 'px';
  pair.style.height = Math.round(naturalH * scale) + 'px';
}

// Shows only the sidebar controls that the current algorithm uses, labelled for it.
// dither ({ dtMethod, dtPalette }) decides the dither-only controls: diffusion-only ones, and the custom colour list.
export function applyControlVisibility(algorithm, mediaKind, pattern, animation, dither) {
  const map = controlsFor(algorithm, Object.assign(
    { mediaKind: mediaKind, pattern: pattern, animation: animation }, dither || {}));
  document.querySelectorAll('[data-ctrl]').forEach((el) => {
    const c = map[el.dataset.ctrl];
    el.hidden = !(c && c.visible);
    const label = el.querySelector('.lbl');
    if (c && label) label.textContent = c.label;
    if (c) el.title = c.hint;
  });
  document.querySelectorAll('[data-panel]').forEach((panel) => {
    // Panels marked data-always are for every algorithm (the palette), so they stay visible.
    if (panel.hasAttribute('data-always')) {
      panel.hidden = false;
      return;
    }
    const anyVisible = Array.from(panel.querySelectorAll('[data-ctrl]')).some((el) => !el.hidden);
    panel.hidden = !anyVisible;
  });
}

// Shows elements that belong to a media type:
//   'video'    only for video sources
//   'still'    only for still images
//   'animated' video sources, or still images with an animation type on
export function applyMediaVisibility(mediaKind, animated) {
  document.querySelectorAll('[data-media]').forEach((el) => {
    const need = el.dataset.media;
    let show = true;
    if (need === 'video') show = mediaKind === 'video';
    else if (need === 'still') show = mediaKind === 'image';
    else if (need === 'animated') show = mediaKind === 'video' || !!animated;
    const target = el.closest('.field') || el;
    target.hidden = !show;
  });
}

// Highlights the chosen animation type.
export function setAnimationChoice(type) {
  document.querySelectorAll('#animation-selector .seg').forEach((btn) => {
    const on = btn.dataset.anim === type;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
  });
}

// The algorithm list is inactive while an animation type is on, or always for video.
export function setAlgorithmEnabled(enabled, note) {
  document.querySelectorAll('#algorithm-selector .seg').forEach((btn) => {
    btn.disabled = !enabled;
  });
  const el = document.getElementById('algo-note');
  el.hidden = enabled;
  el.textContent = note || '';
}

// Animation applies to still images only, so its choices are disabled for video.
export function setAnimationEnabled(enabled) {
  document.querySelectorAll('#animation-selector .seg').forEach((btn) => {
    btn.disabled = !enabled;
  });
}

export function setAnimationNote(text) {
  document.getElementById('anim-note').textContent = text || '';
}
