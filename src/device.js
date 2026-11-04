// Device checks for the one question the app needs: is the main pointer a touch screen (phones and tablets,
// including iPhone, iPad and iPadOS)? Touch devices get a smaller default processing size and a shorter
// frame budget, because every processed frame is held in memory and mobile browsers have much less of it.

export function isTouchDevice() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches;
}

// Most frames kept for one clip. A longer clip is sampled at a lower rate to stay within this.
export function frameLimit() {
  return isTouchDevice() ? 60 : 150;
}
