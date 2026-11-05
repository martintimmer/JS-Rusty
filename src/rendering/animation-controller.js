// Drives the artwork renderer from requestAnimationFrame, with one clock for every source.
// The clock advances while playing. For video it loops over the length of the clip. For a still it
// counts up, and the animation types use it. The source <video> element is not the clock: the
// artwork keeps moving even when that element is hidden or paused by the browser. app.js keeps the
// Original and Split views in step with this clock. For still images without animation the
// algorithm renders on demand.

// Render pacing. The next frame waits for RENDER_DUTY times the last frame's time, so a frame that takes 40 ms is
// followed by a wait of 40 ms: the work takes about half the processor. No more than 30 frames a second are drawn
// (MIN_RENDER_GAP_MS), so a light frame does not run faster than the eye needs.
const RENDER_DUTY = 1;
const MIN_RENDER_GAP_MS = 1000 / 30;

export class AnimationController {
  constructor(options) {
    this.artwork = options.artwork;
    this.isVideo = !!options.isVideo;
    // Length of the clip in seconds. The clock loops at this length for video (0 = no loop).
    this.duration = this.isVideo ? Math.max(0, options.duration || 0) : 0;
    // The clock wraps at the loop length: the clip for video, and 0 (no wrap) for a still unless it is being recorded.
    this.loopSeconds = this.duration;
    this.onTick = options.onTick || null;
    this.onStats = options.onStats || null;
    this.playing = false;
    this.dirty = true;
    this.forceReset = true;
    this.lastNow = null;
    this.clock = 0;
    this.frameTimes = [];
    this.rafId = null;
    this.pendingDt = 0; // motion time since the last render, handed to the next one
    this.nextRenderAt = 0; // performance.now() time before which no render is started
    this.loop = this.loop.bind(this);
  }

  start() {
    if (this.rafId == null) this.rafId = requestAnimationFrame(this.loop);
  }

  stop() {
    if (this.rafId != null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  // Back to the beginning: a video starts again at 0, and a still's animation clock goes back to zero.
  restartClock() {
    this.clock = 0;
    this.markDirty(true);
  }

  // Sets the loop length in seconds (0 = none). A still records exactly one loop, so its clock wraps at that length
  // while the recording runs. The motion starts again, so the loop begins at its first frame.
  setLoopSeconds(seconds) {
    this.loopSeconds = Math.max(0, seconds || 0);
    if (this.loopSeconds > 0) this.clock = this.clock % this.loopSeconds;
    this.markDirty(true);
  }

  // Moves the clock to t seconds (the timeline). Video wraps at the clip length.
  seek(t) {
    let v = Math.max(0, t);
    if (this.loopSeconds > 0) v = v % this.loopSeconds;
    this.clock = v;
    this.markDirty(false);
  }

  markDirty(reset) {
    this.dirty = true;
    if (reset) this.forceReset = true;
  }

  currentTime() {
    return this.clock;
  }

  setPlaying(on) {
    this.playing = !!on;
    this.lastNow = null;
    this.pendingDt = 0;
    this.markDirty(false);
  }

  loop(now) {
    this.rafId = requestAnimationFrame(this.loop);
    const dt = this.lastNow == null ? 0 : Math.min(0.1, (now - this.lastNow) / 1000);
    this.lastNow = now;

    if (this.playing) {
      this.clock += dt;
      if (this.loopSeconds > 0) this.clock = this.clock % this.loopSeconds;
      this.pendingDt += dt;
    }

    // Video is always continuous while playing. A still renders continuously only when an animation
    // type is on.
    const params = this.artwork.params;
    const animated = params.animation !== 'off';
    const continuous = this.playing && (this.isVideo || animated);
    // Renders are paced, for continuous motion and for changes alike, so the processor is not kept busy and the device
    // does not overheat. A frame that takes long makes the next one wait longer (see RENDER_DUTY). A change of settings is
    // drawn as soon as the wait is over, and the last change is the one drawn.
    if ((this.dirty || continuous) && now >= this.nextRenderAt) {
      // A video's motion runs on accumulated time, like a still's, so changing the speed or scrubbing never jumps it.
      // Only a still's loop, while it is recorded, is closed (see stillLoopSeconds).
      const renderDt = continuous ? this.pendingDt : 0;
      this.pendingDt = 0;
      const result = this.artwork.render(this.clock, renderDt,
        { reset: this.forceReset, loop: this.isVideo ? 0 : this.loopSeconds });
      this.dirty = false;
      this.forceReset = false;
      this.trackStats(now, result);
      this.nextRenderAt = performance.now() + Math.max(MIN_RENDER_GAP_MS, result.ms * RENDER_DUTY);
    }

    if (this.onTick) this.onTick(this.clock, this.playing);
  }

  trackStats(now, result) {
    this.frameTimes.push(now);
    while (this.frameTimes.length > 30) this.frameTimes.shift();
    let fps = 0;
    if (this.frameTimes.length > 1) {
      const span = this.frameTimes[this.frameTimes.length - 1] - this.frameTimes[0];
      fps = span > 0 ? ((this.frameTimes.length - 1) * 1000) / span : 0;
    }
    if (this.onStats) this.onStats({ ms: result.ms, elements: result.elements, fps: fps });
  }
}
