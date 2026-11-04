// Global auto-levels for a frame sequence.
// The 0.5th and 99.5th percentiles of the whole sequence are mapped to 0 and 255.
// One mapping is shared by every frame, so tones do not flicker between frames.
// The same mapping is applied to every frame set passed in (display and analysis).

export function autoLevels(frameSets) {
  const hist = new Float64Array(256);
  let total = 0;
  const sample = frameSets[0];
  for (let f = 0; f < sample.length; f++) {
    const fr = sample[f];
    for (let i = 0; i < fr.length; i += 3) {
      hist[fr[i]]++;
      total++;
    }
  }
  if (total === 0) return;

  const lowTarget = total * 0.005;
  const highTarget = total * 0.995;
  let acc = 0;
  let lo = 0;
  let hi = 255;
  let foundLo = false;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (!foundLo && acc >= lowTarget) { lo = v; foundLo = true; }
    if (acc >= highTarget) { hi = v; break; }
  }
  if (hi - lo < 24) return; // nearly flat: leave the tones alone

  const lut = new Uint8Array(256);
  const scale = 255 / (hi - lo);
  for (let v = 0; v < 256; v++) {
    let m = Math.round((v - lo) * scale);
    lut[v] = m < 0 ? 0 : (m > 255 ? 255 : m);
  }

  for (const set of frameSets) {
    for (let f = 0; f < set.length; f++) {
      const fr = set[f];
      for (let i = 0; i < fr.length; i++) fr[i] = lut[fr[i]];
    }
  }
}
