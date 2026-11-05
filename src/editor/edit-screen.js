// The edit window: crop, rotate and (for video) trim. It opens over the app, full screen on a phone and as a dialog on a
// larger screen. Nothing is processed here: Done hands the edit back, and the app processes the clip again from the
// original file. Crop and turn are worked on in the turned picture's own coordinates; the model keeps the crop on the
// source (see edit-model.js).
import {
  ASPECTS, MIN_CROP, MIN_TRIM_SECONDS, displaySize, cropForRotation, cropFromRotation, rotateRectCW,
  trimRange, normalizedRatio, fitToRatio, snapToFrame, formatSeconds, normalizeEdit,
} from './edit-model.js';

const $ = (id) => document.getElementById(id);
const THUMB_HEIGHT = 40;

let ed = null; // the open editor, or null
let initialised = false;

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

// ---------- Opening and closing ----------

// options: media (the app's state.media), edit (the stored edit), fps (the clip's sampling rate), onDone(edit) when Done
// is pressed, onClose() when the window closes for any reason.
export function openEditor(options) {
  initEditor();
  if (ed) closeEditor();
  const media = options.media;
  const stored = normalizeEdit(options.edit, media);
  const range = trimRange(media, options.edit);
  const isVideo = media.kind === 'video';
  ed = {
    media: media,
    fps: options.fps || 30,
    onDone: options.onDone,
    onClose: options.onClose,
    element: isVideo ? $('edit-video') : $('edit-img'),
    rotation: stored.rotation,
    crop: cropForRotation(stored.crop, stored.rotation),
    aspectId: 'free',
    tab: 'crop',
    start: range.start,
    end: range.end,
    disp: null,
    drag: null,
    pointers: new Map(),
    token: 0,
  };

  $('edit-modal').hidden = false;
  $('edit-tabs').hidden = !isVideo;
  $('edit-trim').hidden = true;
  $('edit-title').textContent = 'Crop';
  setTab('crop');

  const img = $('edit-img');
  const video = $('edit-video');
  img.hidden = isVideo;
  video.hidden = !isVideo;
  if (isVideo) {
    video.src = media.url;
    video.muted = true;
    video.currentTime = ed.start;
    video.addEventListener('loadeddata', onPreviewReady, { once: true });
  } else {
    img.src = media.url;
  }
  buildAspects();
  requestAnimationFrame(layout);
  if (isVideo) {
    const token = ed.token;
    window.setTimeout(() => buildThumbs(token), 0);
  }
}

export function closeEditor() {
  if (!ed) return;
  ed.token++;
  const onClose = ed.onClose;
  const video = $('edit-video');
  video.pause();
  $('edit-thumbs').innerHTML = '';
  $('edit-modal').hidden = true;
  ed = null;
  if (onClose) onClose();
}

export function isEditorOpen() {
  return !!ed;
}

// ---------- Setting up once ----------

function initEditor() {
  if (initialised) return;
  initialised = true;
  $('edit-cancel').addEventListener('click', () => closeEditor());
  $('edit-done').addEventListener('click', onDone);
  $('edit-revert').addEventListener('click', onRevert);
  $('edit-rotate').addEventListener('click', onRotate);
  $('edit-aspect').addEventListener('click', () => {
    const list = $('edit-aspects');
    list.hidden = !list.hidden;
    $('edit-aspect').setAttribute('aria-expanded', list.hidden ? 'false' : 'true');
  });
  $('edit-tab-crop').addEventListener('click', () => setTab('crop'));
  $('edit-tab-trim').addEventListener('click', () => setTab('trim'));
  $('edit-play').addEventListener('click', onPlayToggle);
  $('edit-video').addEventListener('timeupdate', onPreviewTime);
  $('edit-video').addEventListener('loadedmetadata', () => layout());
  $('edit-img').addEventListener('load', () => layout());

  const crop = $('edit-crop');
  crop.addEventListener('pointerdown', onCropDown);
  crop.addEventListener('pointermove', onCropMove);
  crop.addEventListener('pointerup', onCropUp);
  crop.addEventListener('pointercancel', onCropUp);

  const strip = $('edit-strip');
  strip.addEventListener('pointerdown', onGripDown);
  strip.addEventListener('pointermove', onGripMove);
  strip.addEventListener('pointerup', onGripUp);
  strip.addEventListener('pointercancel', onGripUp);

  document.addEventListener('keydown', (e) => {
    if (ed && e.key === 'Escape') closeEditor();
  });
  window.addEventListener('resize', () => layout());
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => layout()).observe($('edit-stage'));
}

function onPreviewReady() {
  layout();
  updateStrip();
}

// ---------- Layout ----------

// Places the picture in the stage, turned, and the crop over it. The picture keeps its shape: the turned size is fitted
// to the stage with a margin.
function layout() {
  if (!ed) return;
  const stage = $('edit-stage');
  const sw = stage.clientWidth;
  const sh = stage.clientHeight;
  if (!sw || !sh) return;
  const media = ed.media;
  const shown = displaySize(media, ed.rotation);
  const pad = 20;
  const f = Math.max(0.01, Math.min((sw - 2 * pad) / shown.w, (sh - 2 * pad) / shown.h));
  const el = ed.element;
  const W = media.width * f;
  const H = media.height * f;
  el.style.width = W + 'px';
  el.style.height = H + 'px';
  el.style.left = (sw - W) / 2 + 'px';
  el.style.top = (sh - H) / 2 + 'px';
  el.style.transform = 'rotate(' + ed.rotation + 'deg)';
  ed.disp = { left: (sw - shown.w * f) / 2, top: (sh - shown.h * f) / 2, w: shown.w * f, h: shown.h * f };
  positionCrop();
  updateStrip();
}

function positionCrop() {
  if (!ed || !ed.disp) return;
  const box = $('edit-crop');
  const d = ed.disp;
  const c = ed.crop;
  box.style.left = d.left + c.x * d.w + 'px';
  box.style.top = d.top + c.y * d.h + 'px';
  box.style.width = c.w * d.w + 'px';
  box.style.height = c.h * d.h + 'px';
}

// ---------- Tabs and tools ----------

function setTab(tab) {
  if (!ed) return;
  ed.tab = tab;
  const isCrop = tab === 'crop';
  $('edit-crop').hidden = !isCrop;
  $('edit-trim').hidden = isCrop;
  $('edit-tools').hidden = !isCrop;
  $('edit-tab-crop').setAttribute('aria-selected', isCrop ? 'true' : 'false');
  $('edit-tab-trim').setAttribute('aria-selected', isCrop ? 'false' : 'true');
  $('edit-title').textContent = isCrop ? 'Crop' : 'Trim';
  if (!isCrop) {
    const video = $('edit-video');
    video.pause();
    video.currentTime = ed.start;
    updateStrip();
  }
  $('edit-aspects').hidden = true;
  layout();
}

function buildAspects() {
  const list = $('edit-aspects');
  list.innerHTML = '';
  for (const aspect of ASPECTS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'edit-aspect-option';
    b.dataset.aspect = aspect.id;
    b.textContent = aspect.label;
    b.addEventListener('click', () => chooseAspect(aspect.id));
    list.appendChild(b);
  }
}

function aspectById(id) {
  return ASPECTS.find((a) => a.id === id) || ASPECTS[0];
}

function chooseAspect(id) {
  if (!ed) return;
  ed.aspectId = id;
  const ratio = normalizedRatio(aspectById(id), ed.media, ed.rotation);
  if (ratio) ed.crop = fitToRatio(ed.crop, ratio);
  for (const b of $('edit-aspects').querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.aspect === id);
  }
  $('edit-aspects').hidden = true;
  $('edit-aspect').setAttribute('aria-expanded', 'false');
  positionCrop();
}

function onRotate() {
  if (!ed) return;
  ed.crop = rotateRectCW(ed.crop);
  ed.rotation = (ed.rotation + 90) % 360;
  layout();
}

function onRevert() {
  if (!ed) return;
  ed.rotation = 0;
  ed.crop = cropForRotation(null, 0);
  ed.aspectId = 'free';
  ed.start = 0;
  ed.end = ed.media.duration;
  ed.element.style.transform = '';
  $('edit-video').currentTime = 0;
  for (const b of $('edit-aspects').querySelectorAll('button')) b.classList.remove('active');
  layout();
  updateStrip();
}

function onDone() {
  if (!ed) return;
  const media = ed.media;
  const edit = normalizeEdit({
    crop: cropFromRotation(ed.crop, ed.rotation),
    rotation: ed.rotation,
    start: ed.start,
    end: media.kind === 'video' ? ed.end : null,
  }, media);
  const done = ed.onDone;
  // On Done the app decides what happens next (it may process the clip), so the close callback is not called.
  ed.onClose = null;
  closeEditor();
  if (done) done(edit);
}

// ---------- Crop: dragging the box and its handles ----------

function toNorm(e) {
  const r = $('edit-stage').getBoundingClientRect();
  const d = ed.disp;
  return { x: (e.clientX - r.left - d.left) / d.w, y: (e.clientY - r.top - d.top) / d.h };
}

function onCropDown(e) {
  if (!ed || ed.tab !== 'crop' || !ed.disp) return;
  const handle = e.target.closest ? e.target.closest('[data-h]') : null;
  const mode = handle ? handle.dataset.h : 'move';
  $('edit-crop').setPointerCapture(e.pointerId);
  ed.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ed.pointers.size === 1) {
    ed.drag = { type: mode, start: Object.assign({}, ed.crop), p0: toNorm(e) };
  } else if (ed.pointers.size === 2) {
    const [a, b] = Array.from(ed.pointers.values());
    ed.drag = {
      type: 'pinch',
      start: Object.assign({}, ed.crop),
      dist0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
    };
  }
  e.preventDefault();
}

function onCropMove(e) {
  if (!ed || !ed.drag || !ed.pointers.has(e.pointerId)) return;
  ed.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const ratio = normalizedRatio(aspectById(ed.aspectId), ed.media, ed.rotation);
  if (ed.drag.type === 'pinch' && ed.pointers.size >= 2) {
    const [a, b] = Array.from(ed.pointers.values());
    const scale = (Math.hypot(a.x - b.x, a.y - b.y) || 1) / ed.drag.dist0;
    ed.crop = pinchRect(ed.drag.start, scale);
  } else if (ed.drag.type !== 'pinch') {
    const p = toNorm(e);
    ed.crop = dragRect(ed.drag.start, ed.drag.type, p.x - ed.drag.p0.x, p.y - ed.drag.p0.y, ratio);
  }
  positionCrop();
  e.preventDefault();
}

function onCropUp(e) {
  if (!ed) return;
  ed.pointers.delete(e.pointerId);
  if (ed.pointers.size === 0) ed.drag = null;
  else if (ed.drag && ed.drag.type === 'pinch') ed.drag = null;
}

// The box after a drag. mode is 'move' or the handle: any of n, s, e, w (edges) and their pairs (corners). A ratio
// keeps the box in that shape: a corner keeps the opposite corner fixed, and an edge keeps its centre.
function dragRect(s, mode, dx, dy, ratio) {
  if (mode === 'move') {
    return { x: clamp(s.x + dx, 0, 1 - s.w), y: clamp(s.y + dy, 0, 1 - s.h), w: s.w, h: s.h };
  }
  let L = s.x;
  let R = s.x + s.w;
  let T = s.y;
  let B = s.y + s.h;
  const left = mode.indexOf('w') >= 0;
  const right = mode.indexOf('e') >= 0;
  const top = mode.indexOf('n') >= 0;
  const bottom = mode.indexOf('s') >= 0;
  if (left) L = clamp(L + dx, 0, R - MIN_CROP);
  if (right) R = clamp(R + dx, L + MIN_CROP, 1);
  if (top) T = clamp(T + dy, 0, B - MIN_CROP);
  if (bottom) B = clamp(B + dy, T + MIN_CROP, 1);
  if (ratio) {
    const corner = (left || right) && (top || bottom);
    if (corner) {
      const ax = left ? R : L;
      const ay = top ? B : T;
      let w = Math.max(R - L, (B - T) * ratio);
      w = Math.min(w, left ? ax : 1 - ax, (top ? ay : 1 - ay) * ratio);
      const h = w / ratio;
      L = left ? ax - w : ax;
      R = left ? ax : ax + w;
      T = top ? ay - h : ay;
      B = top ? ay : ay + h;
    } else if (left || right) {
      const cy = (T + B) / 2;
      let w = R - L;
      let h = w / ratio;
      const maxH = 2 * Math.min(cy, 1 - cy);
      if (h > maxH) {
        h = maxH;
        w = h * ratio;
      }
      const ax = left ? R : L;
      L = left ? ax - w : ax;
      R = left ? ax : ax + w;
      T = cy - h / 2;
      B = cy + h / 2;
    } else {
      const cx = (L + R) / 2;
      let h = B - T;
      let w = h * ratio;
      const maxW = 2 * Math.min(cx, 1 - cx);
      if (w > maxW) {
        w = maxW;
        h = w / ratio;
      }
      const ay = top ? B : T;
      T = top ? ay - h : ay;
      B = top ? ay : ay + h;
      L = cx - w / 2;
      R = cx + w / 2;
    }
  }
  return { x: L, y: T, w: R - L, h: B - T };
}

// The box scaled about its centre by a pinch, kept inside the picture.
function pinchRect(s, scale) {
  const cx = s.x + s.w / 2;
  const cy = s.y + s.h / 2;
  const w = clamp(s.w * scale, MIN_CROP, 1);
  const h = clamp(s.h * scale, MIN_CROP, 1);
  return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w: w, h: h };
}

// ---------- Trim: the filmstrip ----------

function timeAt(clientX) {
  const r = $('edit-strip').getBoundingClientRect();
  const f = clamp((clientX - r.left) / r.width, 0, 1);
  return f * ed.media.duration;
}

function onGripDown(e) {
  const grip = e.target.closest ? e.target.closest('[data-grip]') : null;
  if (!ed || !grip) return;
  ed.drag = { type: 'grip', grip: grip.dataset.grip };
  $('edit-strip').setPointerCapture(e.pointerId);
  e.preventDefault();
}

function onGripMove(e) {
  if (!ed || !ed.drag || ed.drag.type !== 'grip') return;
  const dur = ed.media.duration;
  const t = snapToFrame(clamp(timeAt(e.clientX), 0, dur), ed.fps);
  if (ed.drag.grip === 'start') {
    ed.start = clamp(t, 0, ed.end - MIN_TRIM_SECONDS);
    $('edit-video').currentTime = ed.start;
  } else {
    ed.end = clamp(t, ed.start + MIN_TRIM_SECONDS, dur);
    $('edit-video').currentTime = ed.end;
  }
  updateStrip();
  e.preventDefault();
}

function onGripUp() {
  if (!ed) return;
  ed.drag = null;
}

// Positions the trim: the range, the dimmed parts, the grips, the labels and the playhead.
function updateStrip() {
  if (!ed || ed.media.kind !== 'video') return;
  const dur = ed.media.duration || 0;
  if (!dur) return;
  const at = (t) => (clamp(t, 0, dur) / dur) * 100;
  $('edit-range').style.left = at(ed.start) + '%';
  $('edit-range').style.width = at(ed.end) - at(ed.start) + '%';
  $('edit-dim-left').style.width = at(ed.start) + '%';
  $('edit-dim-right').style.left = at(ed.end) + '%';
  $('edit-grip-start').style.left = at(ed.start) + '%';
  $('edit-grip-end').style.left = at(ed.end) + '%';
  $('edit-time-start').textContent = formatSeconds(ed.start);
  $('edit-time-end').textContent = formatSeconds(ed.end);
  $('edit-time-length').textContent = formatSeconds(ed.end - ed.start) + ' selected';
  $('edit-playhead').style.left = at($('edit-video').currentTime || 0) + '%';
}

function onPreviewTime() {
  if (!ed || ed.media.kind !== 'video') return;
  const video = $('edit-video');
  // The range plays in a loop, so the picture returns to the first frame at the last.
  if (!video.paused && video.currentTime >= ed.end - 0.03) video.currentTime = ed.start;
  $('edit-play').textContent = video.paused ? '▶' : '❚❚';
  updateStrip();
}

function onPlayToggle() {
  if (!ed) return;
  const video = $('edit-video');
  if (!video.paused) {
    video.pause();
  } else {
    if (video.currentTime < ed.start || video.currentTime >= ed.end - 0.03) video.currentTime = ed.start;
    video.play().catch(() => {});
  }
  $('edit-play').textContent = video.paused ? '▶' : '❚❚';
}

// Fills the filmstrip with frames of the clip, read by seeking a second copy of it, so the preview is not disturbed.
// Frames that cannot be read (a clip the browser cannot seek) leave the strip plain; the grips still work.
async function buildThumbs(token) {
  if (!ed || token !== ed.token) return;
  const strip = $('edit-thumbs');
  strip.innerHTML = '';
  const media = ed.media;
  const count = clamp(Math.round(($('edit-stage').clientWidth || 360) / 44), 6, 18);
  const reader = document.createElement('video');
  reader.muted = true;
  reader.playsInline = true;
  reader.preload = 'auto';
  reader.src = media.url;
  const ready = await waitEvent(reader, 'loadeddata', 8000);
  if (ready && token === ed.token) {
    const aspect = media.width / media.height;
    const cw = Math.max(8, Math.round(THUMB_HEIGHT * aspect));
    for (let i = 0; i < count; i++) {
      if (token !== ed.token) break;
      const t = ((i + 0.5) * media.duration) / count;
      const ok = await seekTo(reader, t, 2000);
      if (!ok || token !== ed.token) continue;
      const c = document.createElement('canvas');
      c.width = cw;
      c.height = THUMB_HEIGHT;
      c.getContext('2d').drawImage(reader, 0, 0, cw, THUMB_HEIGHT);
      strip.appendChild(c);
    }
  }
  reader.removeAttribute('src');
  reader.load();
}

function seekTo(el, t, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      el.removeEventListener('seeked', onSeeked);
      resolve(ok);
    };
    const onSeeked = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    el.addEventListener('seeked', onSeeked);
    el.currentTime = t;
  });
}

function waitEvent(el, name, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      el.removeEventListener(name, onEvent);
      resolve(false);
    }, timeoutMs);
    function onEvent() {
      clearTimeout(timer);
      resolve(true);
    }
    el.addEventListener(name, onEvent, { once: true });
  });
}
