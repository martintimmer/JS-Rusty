// Loads still images and converts them into a single grayscale analysis frame.

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export async function loadImage(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch (err) {
    URL.revokeObjectURL(url);
    throw new Error('The image could not be decoded by this browser.');
  }
  return {
    element: img,
    url: url,
    width: img.naturalWidth,
    height: img.naturalHeight,
  };
}

// Draws the image at the display size (and at half size for analysis) and returns
// it as a one-frame sequence, in the same shape as extractFrames().
export function imageToFrames(img, width, height) {
  const aw = width / 2;
  const ah = height / 2;
  const full = drawGray(img, width, height);
  const small = drawGray(img, aw, ah);
  return {
    frames: [full],
    analysisFrames: [small],
    analysisWidth: aw,
    analysisHeight: ah,
    count: 1,
    fps: 1,
    duration: 0,
  };
}

function drawGray(source, w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  return rgbaToGray(ctx.getImageData(0, 0, w, h).data, w * h);
}

// Rec. 601 luma using integer arithmetic.
export function rgbaToGray(rgba, pixels) {
  const out = new Uint8Array(pixels);
  for (let i = 0, j = 0; i < pixels; i++, j += 4) {
    out[i] = (77 * rgba[j] + 150 * rgba[j + 1] + 29 * rgba[j + 2]) >> 8;
  }
  return out;
}
