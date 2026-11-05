// A view of a source picture: the crop (in source pixels) and the quarter turns applied after it. Every sampler
// draws through drawView, so a photo and a video are cropped and turned the same way.
//   view = { sx, sy, sw, sh, rotation }   rotation is 0, 90, 180 or 270 (clockwise)

// Draws the view of source (an image or a video element) to fill a w x h canvas context.
export function drawView(ctx, source, view, w, h) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  // A quarter turn swaps the picture's width and height, so the crop is drawn at h x w and then turned into w x h.
  const turned = view.rotation % 180 !== 0;
  const dw = turned ? h : w;
  const dh = turned ? w : h;
  ctx.translate(w / 2, h / 2);
  ctx.rotate((view.rotation * Math.PI) / 180);
  ctx.drawImage(source, view.sx, view.sy, view.sw, view.sh, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}

// The size of the picture after the view: the crop, turned.
export function viewSize(view) {
  const turned = view.rotation % 180 !== 0;
  return turned ? { w: view.sh, h: view.sw } : { w: view.sw, h: view.sh };
}

// The whole source as a view (no crop, no turn).
export function fullView(srcW, srcH) {
  return { sx: 0, sy: 0, sw: srcW, sh: srcH, rotation: 0 };
}
