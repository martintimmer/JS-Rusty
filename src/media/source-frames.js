// Reads the frames of an HDR or wide-gamut clip as sRGB for the preview. The browser decodes the clip. Where it hands over
// the raw planes of a decoded frame (WebCodecs VideoFrame), this module converts them with the colour the clip declares,
// so HLG or PQ highlights are compressed to sRGB rather than clipped. Where the browser cannot give raw planes, the reader
// reports that, and the caller draws the video element as before (the browser then converts the clip itself).

import { createConverter, yuvToRgba, tagsFromColorSpace } from './colour.js';

// The VideoFrame formats the reader understands: the planar layout and the bit depth of each.
const FORMATS = {
  I420: { layout: 'I420', bitDepth: 8 },
  I420P10: { layout: 'I420', bitDepth: 10 },
  NV12: { layout: 'NV12', bitDepth: 8 },
};

export function canReadPlanes() {
  return typeof VideoFrame !== 'undefined' && typeof VideoFrame.prototype.copyTo === 'function';
}

// fileTags: the colour the file declares (probeVideoColour). The tags the browser reports on the frame are used where
// they are given; the file's are used for anything the frame leaves unknown.
export function createSourceReader(fileTags) {
  const converters = new Map();
  let broken = false;
  let scratch = null; // holds a turned frame until it is drawn in the element's orientation

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

  return {
    // Draws the frame that shows at the video's current time into canvas, as sRGB. Resolves to false when the frame
    // cannot be read this way; after the first failure the reader stops trying, and the caller uses the video element.
    async draw(video, canvas) {
      if (broken || !canReadPlanes()) return false;
      let frame;
      try {
        frame = new VideoFrame(video, { timestamp: Math.round(video.currentTime * 1e6) });
      } catch (err) {
        broken = true;
        return false;
      }
      try {
        const spec = FORMATS[frame.format];
        const w = frame.visibleRect ? frame.visibleRect.width : frame.codedWidth;
        const h = frame.visibleRect ? frame.visibleRect.height : frame.codedHeight;
        // The frame is either in the element's orientation (same width and height), or in its coded orientation, turned
        // a quarter (width and height swapped). The track's rotation says which way to turn it. Anything else is not read.
        const sameShape = w === video.videoWidth && h === video.videoHeight;
        const turned = !sameShape && w === video.videoHeight && h === video.videoWidth;
        const quarter = (fileTags && fileTags.rotation) === 90 || (fileTags && fileTags.rotation) === 270;
        if (!spec || (!sameShape && !(turned && quarter)) || (w & 1) || (h & 1)) {
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
        if (sameShape) {
          canvas.width = w;
          canvas.height = h;
          canvas.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
          return true;
        }
        // Turn the coded frame into the element's orientation: 90 degrees clockwise, or 270 (90 counter-clockwise).
        if (!scratch) scratch = document.createElement('canvas');
        scratch.width = w;
        scratch.height = h;
        scratch.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        ctx.save();
        if (fileTags.rotation === 90) {
          ctx.translate(canvas.width, 0);
          ctx.rotate(Math.PI / 2);
        } else {
          ctx.translate(0, canvas.height);
          ctx.rotate(-Math.PI / 2);
        }
        ctx.drawImage(scratch, 0, 0);
        ctx.restore();
        return true;
      } catch (err) {
        broken = true;
        return false;
      } finally {
        frame.close();
      }
    },
    // Whether this browser gives the reader raw planes for this video. Converts one frame to find out.
    async supports(video) {
      const probe = document.createElement('canvas');
      return this.draw(video, probe);
    },
  };
}
