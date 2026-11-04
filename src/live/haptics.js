// Haptic feedback for live recording. Android browsers vibrate with the Vibration API. iPhone Safari has no vibration
// API, but from iOS 18 a checkbox with the switch attribute gives a tick when it is toggled, and a tick is made by
// clicking that switch instead. Each scheme has a cue when the button is pressed, a cue that repeats while it is held,
// and no cue at all once the recording stops. A cue made by a timer, rather than by the press itself, may not reach an
// iPhone; the press cue always runs inside the tap.

export const HAPTIC_SCHEMES = [
  { id: 'heartbeat', label: 'Heartbeat', start: [60, 90, 60], every: 900, loop: [45, 70, 45] },
  { id: 'tick', label: 'Tick', start: [30], every: 500, loop: [12] },
  // The beat speeds up over the last seconds of a full recording.
  { id: 'countdown', label: 'Countdown', start: [60], every: 1000, loop: [18], lastSeconds: 3, fastEvery: 250, fastLoop: [30] },
  { id: 'pulse', label: 'Pulse', start: [120], every: 1000, loop: [120] },
  { id: 'off', label: 'Off', start: null, every: 0, loop: null },
];

let iosSwitch = null;
// The timers of iPhone ticks still to come, so that stopping a recording can drop the ticks that are queued.
let iosTimers = [];
// Ticks sent since the page loaded (a vibration pulse, or an iPhone switch click). A recording reports its own count.
let tickCount = 0;

// One vibration: a pattern of pulses and pauses, in milliseconds. On iPhone each pulse is one tick.
export function vibrate(pattern) {
  if (!pattern) return;
  const list = Array.isArray(pattern) ? pattern : [pattern];
  const pulses = Math.max(1, Math.ceil(list.length / 2));
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    navigator.vibrate(list);
    tickCount += pulses;
    return;
  }
  if (hapticMechanism() !== 'iOS switch') return;
  // The first tick runs at once, inside the tap that asked for it. Later ticks are timers, which may not reach the phone.
  iosTick();
  for (let i = 1; i < pulses; i++) {
    const timer = setTimeout(() => {
      iosTimers = iosTimers.filter((t) => t !== timer);
      iosTick();
    }, i * 130);
    iosTimers.push(timer);
  }
}

// Cancels every vibration still to come. Android stops a pattern in progress; on iPhone, ticks still queued are dropped.
export function cancelVibration() {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(0);
  for (const timer of iosTimers) clearTimeout(timer);
  iosTimers = [];
}

// The way this browser makes a tick: the Vibration API (Android), the iPhone switch (iPhone and iPad Safari), or none.
export function hapticMechanism() {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') return 'Vibration API';
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  // iPadOS 13 and later reports itself as a Mac, so a Mac with touch points is treated as an iPad.
  const ipadOnDesktopMode = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  return /iPhone|iPad|iPod/.test(ua) || ipadOnDesktopMode ? 'iOS switch' : 'none';
}

// A tick on iPhone: a click on a label whose checkbox has the switch attribute toggles the switch, and iOS 18 gives a
// tick for that. Both elements sit on screen (1 px, transparent, in the top left corner), because Safari may skip a
// control it does not show. Nothing is drawn for the user.
function iosTick() {
  if (!iosSwitch) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = 'js-rusty-haptic-switch';
    input.setAttribute('switch', '');
    input.setAttribute('aria-hidden', 'true');
    input.tabIndex = -1;
    input.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;margin:0;opacity:0;pointer-events:none;';
    const label = document.createElement('label');
    label.htmlFor = input.id;
    label.setAttribute('aria-hidden', 'true');
    label.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;';
    document.body.appendChild(input);
    document.body.appendChild(label);
    iosSwitch = label;
  }
  iosSwitch.click();
  tickCount++;
}

// Starts the feedback of a scheme for one recording. The press cue runs at once; the repeating cue follows while the
// recording lasts. stop() ends it, and nothing is felt after that. limitSeconds is the length of a full recording.
export function startRecordingHaptics(schemeId, limitSeconds) {
  const scheme = HAPTIC_SCHEMES.find((s) => s.id === schemeId);
  const startTicks = tickCount;
  if (!scheme || scheme.id === 'off') return { stop: () => 0 };
  vibrate(scheme.start);
  const started = performance.now();
  let timer = 0;
  let stopped = false;
  const beat = () => {
    if (stopped) return;
    const elapsed = (performance.now() - started) / 1000;
    const fast = !!scheme.lastSeconds && elapsed >= limitSeconds - scheme.lastSeconds;
    vibrate(fast ? scheme.fastLoop : scheme.loop);
    timer = setTimeout(beat, fast ? scheme.fastEvery : scheme.every);
  };
  timer = setTimeout(beat, scheme.every);
  return {
    // Ends the feedback and returns how many ticks were sent during this recording.
    stop() {
      stopped = true;
      clearTimeout(timer);
      cancelVibration();
      return tickCount - startTicks;
    },
  };
}
