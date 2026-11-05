// Drives the artwork renderer from requestAnimationFrame, with one clock for every source.
// The clock advances while playing. For video it loops over the length of the clip. For a still it
// counts up, and the animation types use it. The source <video> element is not the clock: the
// artwork keeps moving even when that element is hidden or paused by the browser. app.js keeps the
// Original and Split views in step with this clock. For still images without animation the
// algorithm renders on demand.

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
    this.markDirty(false);
  }

  loop(now) {
    this.rafId = requestAnimationFrame(this.loop);
    const dt = this.lastNow == null ? 0 : Math.min(0.1, (now - this.lastNow) / 1000);
    this.lastNow = now;

    if (this.playing) {
      this.clock += dt;
      if (this.loopSeconds > 0) this.clock = this.clock % this.loopSeconds;
    }

    // Video is always continuous while playing. A still renders continuously only when an animation
    // type is on.
    const params = this.artwork.params;
    const animated = params.animation !== 'off';
    const continuous = this.playing && (this.isVideo || animated);
    if (continuous || this.dirty) {
      const result = this.artwork.render(this.clock, continuous ? dt : 0,
        { reset: this.forceReset, loop: this.loopSeconds });
      this.dirty = false;
      this.forceReset = false;
      this.trackStats(now, result);
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
