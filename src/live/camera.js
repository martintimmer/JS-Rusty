// The phone camera for live mode. Opens one camera lens for video only, so no microphone permission is asked for. It
// lists the lenses the browser exposes and turns errors into plain messages for the live screen.

export function cameraSupported() {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function';
}

// The size and rate asked for: 720p at 60 frames a second. 720p at 60 is a mode the phone camera offers, and it is much
// lighter to draw than 1080p, which is what kept the preview near 20 frames a second. The browser gives the closest mode
// the camera offers; live.js shows the rate the camera actually delivers.
const WANTED = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } };

// The cameras the browser exposes. Their labels are empty until the camera permission has been granted.
export async function listCameras() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'videoinput')
      .map((d) => ({ deviceId: d.deviceId, label: d.label || '' }));
  } catch (err) {
    return [];
  }
}

// Opens one lens. lens is { deviceId } for one camera, or { facing } where facing is 'environment' (rear) or 'user'
// (front).
export async function openLens(lens) {
  const direction = lens.deviceId
    ? { deviceId: { exact: lens.deviceId } }
    : { facingMode: { ideal: lens.facing } };
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: Object.assign({}, direction, WANTED),
    });
  } catch (err) {
    // Some cameras refuse the size request. Retry with the lens alone.
    if (err && err.name === 'OverconstrainedError') {
      return navigator.mediaDevices.getUserMedia({ audio: false, video: direction });
    }
    throw err;
  }
}

export function stopCamera(stream) {
  if (stream) stream.getTracks().forEach((track) => track.stop());
}

// The zoom range the camera allows, when the browser reports one. Otherwise null.
export function zoomRange(stream) {
  const track = stream && stream.getVideoTracks()[0];
  const caps = track && track.getCapabilities ? track.getCapabilities() : {};
  return caps.zoom ? { min: caps.zoom.min, max: caps.zoom.max } : null;
}

// Sets the zoom of the open camera. Resolves to false when the browser does not allow it.
export function setZoom(stream, zoom) {
  const track = stream && stream.getVideoTracks()[0];
  if (!track || !track.applyConstraints) return Promise.resolve(false);
  return track.applyConstraints({ advanced: [{ zoom: zoom }] }).then(() => true, () => false);
}

export function isFrontLabel(label) {
  return /front|user|face|selfie/i.test(label || '');
}

// The short name of a rear lens, from its label. Ultra-wide and telephoto lenses show their zoom.
export function lensName(label) {
  if (/ultra|0\.5/i.test(label || '')) return '0.5×';
  if (/tele/i.test(label || '')) return '3×';
  return '1×';
}

export function cameraError(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Camera permission was refused. Allow the camera for this site in the browser settings, then tap Live again.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'No camera was found on this device.';
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'The camera is in use by another app. Close that app and try again.';
  }
  return 'The camera could not be opened' + (err && err.message ? ': ' + err.message : '.');
}
