// Resizable sidebars on desktop. Drag the bar between a sidebar and the canvas to change that sidebar's width.
// The bar can also be focused and moved with the arrow keys (Shift for bigger steps), and double-clicking it
// restores the default width. Widths are kept in this browser's local storage. On phones and tablets the menus
// are a dock instead, and nothing here applies.

const STORAGE_KEY = 'js-rusty-layout';
const SPLIT_PX = 8;      // width of one splitter bar; keep in step with --split in styles.css
const MAIN_MIN = 420;    // the canvas never shrinks below this width
const SIDES = {
  left: { min: 240, max: 520, cssVar: '--left-w', sidebarId: 'sidebar-left' },
  right: { min: 200, max: 460, cssVar: '--right-w', sidebarId: 'sidebar-right' },
};
const desktop = window.matchMedia('(min-width: 901px)');

// Connects the two splitter bars. Widths the user has set are stored; a side the user has not touched keeps the
// width from the stylesheet.
export function initLayout() {
  const app = document.getElementById('app');
  const widths = readSaved();

  const sidebar = (side) => document.getElementById(SIDES[side].sidebarId);
  const splitter = (side) => document.getElementById('splitter-' + side);

  // Keeps a width inside the side's own limits and leaves room for the canvas, using the other sidebar's real width.
  const clamp = (side, px) => {
    const other = side === 'left' ? 'right' : 'left';
    const otherWidth = sidebar(other).getBoundingClientRect().width;
    const room = window.innerWidth - 2 * SPLIT_PX - otherWidth - MAIN_MIN;
    return Math.round(Math.max(SIDES[side].min, Math.min(px, SIDES[side].max, room)));
  };

  // Writes the stored widths (clamped to the window) into the layout, and keeps the splitters' ARIA values current.
  const apply = () => {
    for (const side of Object.keys(SIDES)) {
      if (widths[side] == null) {
        app.style.removeProperty(SIDES[side].cssVar);
      } else {
        app.style.setProperty(SIDES[side].cssVar, clamp(side, widths[side]) + 'px');
      }
      splitter(side).setAttribute('aria-valuenow', String(Math.round(sidebar(side).getBoundingClientRect().width)));
    }
  };

  for (const side of Object.keys(SIDES)) {
    const bar = splitter(side);
    // The left bar moves right to widen its sidebar; the right bar moves left to widen its sidebar.
    const direction = side === 'left' ? 1 : -1;
    bar.setAttribute('aria-valuemin', String(SIDES[side].min));
    bar.setAttribute('aria-valuemax', String(SIDES[side].max));

    bar.addEventListener('pointerdown', (e) => {
      if (!desktop.matches || e.button !== 0) return;
      e.preventDefault();
      bar.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startWidth = sidebar(side).getBoundingClientRect().width;
      document.body.classList.add('is-resizing');

      const move = (ev) => {
        widths[side] = clamp(side, startWidth + direction * (ev.clientX - startX));
        apply();
      };
      const end = () => {
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', end);
        bar.removeEventListener('pointercancel', end);
        document.body.classList.remove('is-resizing');
        save(widths);
      };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', end);
      bar.addEventListener('pointercancel', end);
    });

    bar.addEventListener('keydown', (e) => {
      if (!desktop.matches) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const step = e.shiftKey ? 48 : 16;
      const sign = e.key === 'ArrowRight' ? 1 : -1;
      widths[side] = clamp(side, sidebar(side).getBoundingClientRect().width + sign * step * direction);
      apply();
      save(widths);
    });

    bar.addEventListener('dblclick', () => {
      delete widths[side];
      apply();
      save(widths);
    });
  }

  apply();
  // The stored widths are kept, so a window that is made wide again gets them back.
  window.addEventListener('resize', apply);
}

function readSaved() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    const out = {};
    for (const side of Object.keys(SIDES)) {
      if (Number.isFinite(raw[side])) out[side] = raw[side];
    }
    return out;
  } catch (err) {
    return {};
  }
}

function save(widths) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(widths));
  } catch (err) {
    // Storage can be unavailable (private browsing). The widths then last only for this visit.
  }
}
