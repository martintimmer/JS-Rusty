// Reads the frames of an HDR or wide-gamut clip as sRGB for the preview. The browser decodes the clip. Where it hands over
// the raw planes of a decoded frame (WebCodecs VideoFrame), this module converts them with the colour the clip declares,
// so HLG or PQ highlights are compressed to sRGB rather than clipped, and wide colour is gamut-mapped rather than clipped
// per channel. Where the browser cannot give raw planes, the reader reports that, and the caller draws the video element
// as before (the browser then converts the clip itself).
//
// A frame is captured synchronously (capture) and converted later (convert). The seek path captures and converts at once.
// The playback path captures in its callback, which cannot wait, and converts the captured frames in order.

import { createConverter, yuvToRgba, tagsFromColorSpace } from './colour.js';

// The VideoFrame formats the reader understands: the planar layout and the bit depth of each.
const FORMATS = {
  I420: { layout: 'I420', bitDepth: 8 },
  I420P10: { layout: 'I420', bitDepth: 10 },
  NV12: { layout: 'NV12', bitDepth: 8 },
};

// What the browser's frames look like, learned from the first clip with a quarter turn: 'coded' when the frames come in
// the coded orientation and must be turned, 'applied' when they arrive already turned. null until a clip shows which.
// It is kept for the page, because it is a property of the browser.
let frameOrientation = null;

export function canReadPlanes() {
  return typeof VideoFrame !== 'undefined' && typeof VideoFrame.prototype.copyTo === 'function';
}

// The turn that shows a decoded frame the way the element does: 0, 90, 180 or 270 degrees clockwise, or null when the
// frame cannot be shown this way.
//   rotation: the track's rotation (0, 90, 180 or 270).
//   sameShape: the frame has the element's width and height. turned: its width and height are swapped.
//   orientation: 'coded' or 'applied' (see frameOrientation), or null when not known.
// A 180 turn does not change the shape, so it can only be told from the orientation the browser has been seen to give.
// Until that is known, a flipped clip is assumed to be coded, like a quarter-turned one.
export function turnFor(rotation, sameShape, turned, orientation) {
  if (rotation === 0) return sameShape ? 0 : null;
  if (rotation === 180) {
    if (!sameShape) return null;
    return orientation === 'applied' ? 0 : 180;
  }
  if (turned) return rotation;
  if (sameShape) return 0;
  return null;
}

// fileTags: the colour the file declares (probeVideoColour). The tags the browser reports on the frame are used where
// they are given; the file's are used for anything the frame leaves unknown.
export function createSourceReader(fileTags) {
  const converters = new Map();
  const rotation = fileTags && fileTags.rotation ? fileTags.rotation : 0;
  let broken = false;
  let scratch = null; // holds a frame in its coded orientation until it is turned

  const converterFor = (tags) => {
    const key = JSON.stringify(tags);
    if (!converters.has(key)) converters.set(key, createConverter(tags, 'srgb'));
    return converters.get(key);
  };

  const mergeTags = (frameSpace) => {
    const fromFrame = frameSpace ? tagsFromColorSpace(frameSpace) : null;
    const pick = (name) => {
      if (fromFrame && fromFrame[name] !== 'unknown') return fromFrame[name];
      return (fileTags && fileTags[name]) || 'unknown';
    };
    const fullRange = frameSpace && typeof frameSpace.fullRange === 'boolean'
      ? frameSpace.fullRange
      : !!(fileTags && fileTags.fullRange);
    return { primaries: pick('primaries'), transfer: pick('transfer'), matrix: pick('matrix'), fullRange: fullRange };
  };

  // Turns a coded frame into canvas (scratch holds it until it is drawn turned).
  const drawTurned = (canvas, rgba, w, h, turn) => {
    if (!scratch) scratch = document.createElement('canvas');
    scratch.width = w;
    scratch.height = h;
    scratch.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
    canvas.width = turn === 90 || turn === 270 ? h : w;
    canvas.height = turn === 90 || turn === 270 ? w : h;
    const ctx = canvas.getContext('2d');
    ctx.save();
    if (turn === 90) {
      ctx.translate(canvas.width, 0);
      ctx.rotate(Math.PI / 2);
    } else if (turn === 270) {
      ctx.translate(0, canvas.height);
      ctx.rotate(-Math.PI / 2);
    } else if (turn === 180) {
      ctx.translate(canvas.width, canvas.height);
      ctx.rotate(Math.PI);
    }
    ctx.drawImage(scratch, 0, 0);
    ctx.restore();
  };

  return {
    // Captures the frame that shows at the video's current time. This is synchronous, so it can be called from the
    // playback callback. Returns null when the browser cannot give the frame. The caller must pass the frame to convert
    // or to discard.
    capture(video) {
      if (broken || !canReadPlanes()) return null;
      try {
        return new VideoFrame(video, { timestamp: Math.round(video.currentTime * 1e6) });
      } catch (err) {
        broken = true;
        return null;
      }
    },
    // Closes a captured frame that will not be converted.
    discard(frame) {
      if (frame) frame.close();
    },
    // Converts a captured frame into canvas, as sRGB, and closes it. Resolves to false when it cannot be converted. After
    // the first failure the reader stops trying, and the caller uses the video element.
    async convert(video, frame, canvas) {
      if (!frame) return false;
      try {
        const spec = FORMATS[frame.format];
        const w = frame.visibleRect ? frame.visibleRect.width : frame.codedWidth;
        const h = frame.visibleRect ? frame.visibleRect.height : frame.codedHeight;
        const sameShape = w === video.videoWidth && h === video.videoHeight;
        const turned = !sameShape && w === video.videoHeight && h === video.videoWidth;
        // Learn what the browser gives from the clips that have a quarter turn.
        if ((rotation === 90 || rotation === 270) && (sameShape || turned)) {
          frameOrientation = turned ? 'coded' : 'applied';
        }
        const turn = turnFor(rotation, sameShape, turned, frameOrientation);
        if (!spec || turn === null || (w & 1) || (h & 1)) {
          broken = true;
          return false;
        }
        const buf = new Uint8Array(frame.allocationSize());
        const layouts = await frame.copyTo(buf);
        const tags = mergeTags(frame.colorSpace);
        const rgba = yuvToRgba({
          width: w,
          height: h,
          bitDepth: spec.bitDepth,
          layout: spec.layout,
          fullRange: tags.fullRange,
          matrix: tags.matrix,
          planes: layouts.map((l) => ({ data: buf, offset: l.offset, stride: l.stride })),
        }, converterFor(tags));
        if (turn === 0) {
          canvas.width = w;
          canvas.height = h;
          canvas.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
        } else {
          drawTurned(canvas, rgba, w, h, turn);
        }
        return true;
      } catch (err) {
        broken = true;
        return false;
      } finally {
        frame.close();
      }
    },
    // Draws the frame that shows at the video's current time into canvas, as sRGB (capture, then convert).
    async draw(video, canvas) {
      const frame = this.capture(video);
      return this.convert(video, frame, canvas);
    },
    // Whether this browser gives the reader raw planes for this video. Converts one frame to find out.
    async supports(video) {
      const probe = document.createElement('canvas');
      return this.draw(video, probe);
    },
  };
}
