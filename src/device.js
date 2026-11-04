// Device checks and limits. isTouchDevice tells phones and tablets (iPhone, iPad and iPadOS) from desktops:
// touch devices get a smaller default processing size, because every processed frame is held in memory and
// mobile browsers allow much less of it.
//
// Limits for one clip: up to MAX_FRAMES frames at the chosen rate. The frame rate is never lowered. When the frames
// would not fit the memory budget, the picture is made smaller instead (see processMedia in app.js).

// Most frames one clip may have at its chosen rate.
export const MAX_FRAMES = 5000;

// Bytes kept per display pixel for each frame: the display-size luminance, plus the analysis-size colour (three
// bytes at a quarter of the pixels). The analysis luminance is also held while a clip is processed, so the budget
// uses 2 bytes per pixel to leave room for it.
export const FRAME_BYTES_PER_PIXEL = 2;

export function isTouchDevice() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches;
}

// Memory the processed frames of one clip may use, in bytes. Phones and tablets have much less per tab.
export function frameBudgetBytes() {
  return isTouchDevice() ? 400 * 1024 * 1024 : 2048 * 1024 * 1024;
}
