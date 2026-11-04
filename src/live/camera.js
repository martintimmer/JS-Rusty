// The phone camera for live mode. Opens the rear or the front camera for video only, so no microphone permission is
// asked for, and stops it again. Errors are turned into plain messages for the live screen.

export function cameraSupported() {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function';
}

// The size and rate asked for. The browser gives the closest mode the camera offers.
const WANTED = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };

// facing is 'environment' (rear) or 'user' (front).
export async function openCamera(facing) {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: Object.assign({ facingMode: { ideal: facing } }, WANTED),
    });
  } catch (err) {
    // Some cameras refuse the size request. Retry with the camera direction only.
    if (err && err.name === 'OverconstrainedError') {
      return navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: facing } } });
    }
    throw err;
  }
}

export function stopCamera(stream) {
  if (stream) stream.getTracks().forEach((track) => track.stop());
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
