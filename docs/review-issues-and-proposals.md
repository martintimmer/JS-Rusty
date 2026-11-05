# Review: open issues and proposed solutions

Date: 2026-11-05
Scope: the working tree on branch `animation-inside-algorithm` (commit `efabd7e` plus uncommitted changes), read from the source files.
Method: code reading, Node checks of the pure functions, and web research. **Nothing here has been run in a browser.** Each item lists what is confirmed by reading, what needs a browser test, and the sources used.

## Summary

| # | Severity | Area | Problem | Confirmed by | Status |
|---|---|---|---|---|---|
| 1 | High | Live preview | Tone stretch is recomputed from every camera frame, so brightness pumps | Reading | Implemented (Node-tested) |
| 2 | High | HDR preview | A slow seek silently drops the HDR conversion, but the Source panel still says it is converted | Reading | Implemented (playback queue; browser test pending) |
| 3 | High | Standalone export | No size check on the decoded frames; the viewer can run out of memory | Reading | Implemented (on-demand decoding; browser test pending) |
| 4 | High | Tone | Auto-levels maps the 99.5th percentile to pure white, which can blow highlights | Reading (cause of the reported blow-out not confirmed) | Implemented (Node-tested) |
| 5 | Medium | Memory | Dither export keeps two copies of all frames; the video fallback allocates one large array | Reading | Implemented (Node-tested) |
| 6 | Medium | HDR preview | A rotated clip may always fall back to the browser's conversion | Reasoning (not tested) | Implemented (180 degrees assumed from the browser's observed orientation) |
| 7 | Medium | Colour | Preview clips wide-gamut colour to sRGB, so P3 export can add no colour | Reading | Partly implemented (gamut mapping; P3 render chain open) |
| 8 | Low | Dither HTML | Halation and aberration are left out of the page | Reading | Implemented (syntax-checked) |
| 9 | Low | Coder | Fixed-size output buffer silently drops bytes if it overflows | Reading | Implemented (Node-tested) |
| 10 | Low | Sizes | Two different fallback widths in the dialog and the exporter | Reading | Implemented (Node-tested) |
| 11 | Low | Colour | DCI-P3 is treated as Display P3 | Reading | Implemented (Node-tested) |
| 12 | Low | Frame sampling | A stalled seek repeats the previous frame without any warning | Reading | Implemented (Node-tested logic; seek timing untested) |

## Implementation status

Batch 1 (items 1 to 6) and batch 2 (items 7 to 12) were implemented in the working tree. Nothing is committed, and nothing has been run in a browser. "Node-tested" means the pure functions were checked in Node against known values or round trips.

What was built, and what was left open:

1. **Live levels.** `tone.js` has a `LevelsTracker`: the levels are blended in with weight 0.08, reset at a scene cut (histogram change above 0.35), and kept on a flat frame. The camera uses it (`live.js`). Tests: steady drift stays under 2 levels, a cut resets at once, a flat frame keeps the levels.
2. **HDR preview.** The seek path is used with a 5 s timeout when a colour reader exists. A seek that is more than half a frame out is repeated once. Sampling reports `converted`, `browser` or `mixed`, and the Source panel shows that result. *Done later:* the reader on the playback path. Each frame is captured in the playback callback (capture is synchronous), converted in order after it, and playback pauses while four frames wait, so the queue stays short.
3. **Standalone export.** The export refuses a page that would need more than 1 GB in memory, before encoding, and says what would fit. The export window shows the size in memory. The viewer's out-of-memory error now says what to change. *Done later:* decoding on demand in the viewer. A video whose decoded frames would exceed 256 MB is kept as its container, and the page decodes only the frames around the playhead (`src/export/window-decoder.js`). The renderer reads only the current and next frame, so the page waits for those before it renders. Such a clip is no longer refused by its decoded size, when the video encoder is available.
4. **Highlights.** The 99.5th percentile maps to 235, and brighter values roll off toward 255 instead of clipping. An **Auto levels** switch is in the Source panel, and turning it re-samples the clip. The HLG shoulder starts at 0.9, so HLG 75% (SDR white) lands at 251, not 246. The sources support placing SDR white at 75%. That shoulder is a judgement, and it can be moved back.
5. **Memory.** Dither frames are written straight into one index array, which removes the second copy. The no-encoder fallback now deflates frames as they are produced. Node check: a streamed round trip is exact.
6. **Rotation.** The track's rotation is read from its `tkhd` matrix (0, 90, 180, 270). A portrait frame in coded orientation is turned by 90 or 270 degrees before it is drawn. *Done later:* 180 degrees. A 180 turn does not change the shape, so the rule uses the browser's orientation learned from the quarter-turn clips of the session. Until one has been seen, a flipped clip is assumed to be coded, like a quarter-turned one. Browser test needed on a portrait and on a flipped iPhone clip.
7. **Gamut.** The export window warns when a P3 export is chosen for a wide-gamut clip, and says the preview has already clipped the colours. *Done later:* gamut mapping. A colour outside sRGB is now desaturated toward its own luminance until it fits, instead of being clipped per channel, so a saturated blue keeps its hue. *Still open:* the P3 render chain. P3 can only add colour if the analysis colours stay wide, the engines that paint photo colour use `color(display-p3 …)` fills on a `display-p3` canvas, and the palettes gain wide-gamut entries. The Dither palette matching is palette-bound, so Dither output gains nothing from that chain alone.
8. **Dither optics.** The page applies halation and aberration to each painted frame, using the payload's own settings and the app's scale. Syntax-checked only.
9. **Coder buffer.** The buffer doubles when full, so output is never truncated. Node test: round trip with a 16-byte start.
10. **Sizes.** The dialog and the exporter use one width rule, `exportWidth`. Node check: both give 960 for a 1920-wide clip with no width given.
11. **DCI-P3.** `dci-p3` has its own primaries and DCI white, adapted to D65 by Bradford. The unadapted matrix matches the published DCI-P3 values to four decimals. The COLR code 11 and the SMPTE 431 tag now map to it.
12. **Stalled seeks.** A seek is checked and repeated once. Samples that still did not land are counted, and the ready message reports the count.

---

## 1. Live tone stretch is recomputed on every camera frame

**Severity:** High.
**Where:** `src/live/live.js:480` calls `autoLevels([live.data.frames], [live.data.colour])` in `processFrame`. `src/media/tone.js` builds a new 0.5 to 99.5 percentile map from that single frame each time.

**What happens.** Each camera frame gets its own stretch. A frame with a wide spread is stretched hard, and a dark or flat frame (spread under 24 levels, `tone.js:43`) is left alone. The tones therefore change between frames, which shows as brightness pumping and flicker. The code comment says the preview matches "an editor render", but the editor maps one clip-wide table (`src/app.js:415`), so the two do not match.

**Research.**
- A patent on automatic contrast enhancement reports that small frame-to-frame changes in contrast processing make moving video flicker. Recursive temporal filtering reduces the flicker, but it has to reset at scene cuts. ([USPTO 7953286](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/7953286))
- FFmpeg's `normalize` filter stretches each frame's min and max, which flickers when small bright or dark objects enter or leave. Its `smoothing` option averages the min and max over the current and previous frames, and it is off by default. ([FFmpeg vf_normalize.c](https://fuchsia.googlesource.com/third_party/ffmpeg/+/refs/tags/n6.0/libavfilter/vf_normalize.c))
- The Intelligent Brightness plugin smooths its gain over time, resets on scene changes, and can use the median of a frame rather than its extremes. ([infognition.com/brightness](https://infognition.com/brightness))
- A time-lapse exposure patent slows the smoothing when the scene is still, to avoid flicker from random luminance changes. ([USPTO 10771712](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/10771712))

The research agrees on the pattern: estimate the levels per frame, smooth them over time, and reset on scene cuts. It did not turn up a source for exponential smoothing with percentiles specifically.

**Proposed solution.**
1. Move the histogram and percentile code into one shared helper (`levelsFromHistogram(hist)`).
2. For the live path, keep `lo` and `hi` as exponential moving averages of the frame percentiles, with a weight of about 0.05 to 0.1 at 30 fps.
3. Reset the averages when the frame's histogram changes sharply from the previous one (for example, L1 distance above a threshold), which covers scene cuts.
4. When a frame is too flat to stretch, keep the previous `lo` and `hi` rather than switching the stretch off.
5. Apply the same helper in the editor, so both paths use the same rule.

**How to test.** Point the camera at a steady scene and at a moving one, and log `lo` and `hi` per frame. Before the change they should jump around; after it they should move slowly and reset on cuts.

---

## 2. A slow seek silently drops the HDR conversion

**Severity:** High. This breaks the HDR fix from the last change.
**Where:** `src/media/frame-extractor.js:59-63` (`extractVideoFrames`) chooses the path with `canSeek`, which gives up after 500 ms (`:67`). The playback path (`extractFramesByPlayback`, `:90`) never uses the colour reader. `src/app.js:285-286` (`previewLine`) reports "sRGB, converted" whenever a reader exists, whatever path ran.

**What happens.** If the seek is slow, the clip is sampled by playback, the reader is skipped, the browser converts the colour, and the Source panel still says the preview is converted. Slow seeks are more likely on phones and on long files.

**Research.**
- `requestVideoFrameCallback` has known timing problems. A November 2024 WebKit bug reports a callback that delivered a frame stamped 5.976 s after the seek target was set to 6.009 s ([WebKit bug 283448](https://bugs.webkit.org/show_bug.cgi?id=283448)). A 2023 bug reports inexact `mediaTime` on iOS Safari ([WebKit list, Aug 2023](https://lists.webkit.org/pipermail/webkit-unassigned/2023-August/1119080.html)).
- One developer found `mediaTime` and the WebCodecs timestamps disagree when the first frame's timestamp is above zero, and another answer calls the callback "not frame-precise" ([Stack Overflow 66154604, mirror](https://kaweah.freedombox.rocks/kiwix/stackoverflow.com_en_all_2023-11/questions/66154604/most-accurate-video-pause-on-earth-currenttime-vs-mediatime-and-requestvideofr)).
- The research did not find figures on `seeked` latency. Treat these as anecdotal.

**Proposed solution.**
1. Make the reader usable on the playback path. Create the `VideoFrame` synchronously inside the callback (creation does not need an await), then convert it asynchronously. Keep the frames in order.
2. Alternatively, when a reader exists, use the seek path with a longer timeout (about 5 s) and do not fall back silently.
3. Record which path ran (`previewPath: 'converted' | 'browser'`) in `state.media`, and update the Source panel from that value after sampling, not from the reader's existence.
4. After each seek, compare the `VideoFrame.timestamp` with the target and retry once if it is more than half a frame off, which guards against the `mediaTime` problems above.

**How to test.** Open the iPhone clip in Safari and in Chrome, and log the path used and the timestamps. Force a slow seek (throttle the network or use a long-GOP file) and check that the Source panel matches the path that actually ran.

---

## 3. No size check for standalone exports

**Severity:** High.
**Where:** `src/export/javascript-exporter.js` (the video path of `encodeVideoContainer`) writes every frame. The viewer, `decodeVideoFrames` (`:551`, `:568`), allocates `count × width × height` bytes of grey frames in memory. `src/device.js:9` allows up to 5000 frames, and `device.js:23` assumes a 2 GB frame budget on desktop.

**What happens.** A clip near the 5000-frame limit at 960 × 540 decodes to about 2.6 GB in the viewer. The export succeeds, and the failure appears only when the file is opened, as an allocation error or a crashed tab. GIF export has a memory budget (`GIF_FRAME_BYTES`), but standalone export does not.

**Research.**
- MDN says the maximum `ArrayBuffer` size depends on the platform, the browser and its version. Firefox allows about 8 GiB on 64-bit systems from version 89, and V8 and Firefox report the same "invalid array length" RangeError ([MDN Invalid_array_length](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Errors/Invalid_array_length)).
- No current numeric limit for Chrome or Safari turned up. The 2 GB figure in `device.js` is therefore an assumption, not a measured limit.

**Proposed solution.**
1. At export time, estimate the decoded size as `count × width × height × channels`, plus the colour frames. Show it in the export window the same way GIF shows its size, and refuse or warn above a conservative budget (for example 1 GB, lower on iOS).
2. Keep the encoded container in the viewer and decode frames on demand. Playback is sequential, so a window of about one second of decoded frames is enough. Decode forward from the nearest key frame when the playhead jumps. This removes the in-memory ceiling and costs some re-decoding after seeks.
3. Wrap the allocations in try and catch, and show a clear message instead of a crash.

**How to test.** Export a 5000-frame clip at 960 × 540 and open it in Chrome and in Safari. Watch the memory use and check whether the page loads.

---

## 4. Auto-levels pushes the top of the picture to pure white

**Severity:** High. This is the likeliest cause of the blown highlights reported earlier, but I have not confirmed it.
**Where:** `src/media/tone.js:32-47`. The 99.5th percentile maps to 255 with `scale = 255 / (hi - lo)`. Everything above it clips. The same map is applied to the display frames and the analysis frames.

**What happens.** A clip with a low top percentile (a bright sky, or a flat log grade) is stretched so that its midtones rise and its highlights clip to white. None of the controls changes this, which matches "reset does nothing".

**Research.**
- ITU-R BT.2408 places diffuse white at 75% HLG signal, about 203 nits on a 1000-nit display ([ITU-R BT.2408 report](https://www.itu.int/dms_pub/itu-r/opb/rep/R-REP-BT.2408-2017-MSW-E.docx)). libplacebo anchors HLG at the 75% point in the same way ([libplacebo commit](https://code.videolan.org/videolan/libplacebo/-/commit/9d9164773)). The research notes that the 203-nit figure is an approximation and that broadcasters disagree on where SDR white sits ([pixls forum](https://discuss.pixls.us/t/experimenting-with-hlg-and-hdr10-for-still-images/23361?page=3); [VideoQ blog](https://blog.videoq.com/?p=45)).
- Neither source covers percentile stretching for SDR, so the fix below follows general tone-mapping practice rather than a cited method.

**Proposed solution.**
1. Keep the percentile estimate, but stop mapping the top to 255. Map the 99.5th percentile to about 235, and roll off above it with a soft shoulder, as `shoulder()` already does in `src/media/colour.js`.
2. Add an "Auto levels" toggle in the source or edit panel, so the picture can be compared with the stretch off. Default it off for HDR sources, which are already converted.
3. Note that the HLG preview currently puts 75% signal at about 246 (`SHOULDER_KNEE = 0.8`, `colour.js:20`). The research suggests 75% should sit at SDR white. Decide whether to keep the headroom or move the knee up.

**How to test.** Export one frame of the iPhone clip with the stretch on and off, and compare the highlights and the sky.

---

## 5. Memory copies in the Dither export and the video fallback

**Severity:** Medium.
**Where:** `src/export/javascript-exporter.js:456-469` (`encodePacked`) keeps a `frames` array and then copies every frame into `indices`, so it holds two copies. `:396` (`encodeData`, no-encoder fallback) allocates `n × count` bytes in one array.

**What happens.** A long Dither clip uses twice the memory it needs. Browsers without `VideoEncoder` fall back to the single large array and can fail on long clips.

**Proposed solution.**
1. Write each frame straight into `indices` once its size is known (allocate after the first frame), or make the encoder incremental: a `push(frame)` method on `RangeEncoder` plus a model state object, so the frames are never held together.
2. For the fallback, stream the frames into a `CompressionStream` writer as they are produced, instead of building the full array first.

**How to test.** Export a long Dither clip and compare the peak memory before and after.

---

## 6. A rotated HDR clip may always fall back

**Severity:** Medium. This is my reasoning and has not been tested.
**Where:** `src/media/source-frames.js:59` rejects a frame whose size differs from `video.videoWidth` and `video.videoHeight`.

**What happens.** A portrait iPhone clip can carry a rotation in its metadata. If the element reports the rotated size but the frame reports the coded size (or the reverse), the reader returns false and the browser's conversion is used. Nothing tells the user.

**Research.** The `VideoFrame` interface exposes `visibleRect` and `colorSpace`, but the sources did not say how rotation metadata is handled ([MDN VideoFrame](https://developer.mozilla.org/en-US/docs/Web/API/VideoFrame/VideoFrame)). Treat rotation handling as unknown until tested.

**Proposed solution.**
1. Read the rotation from the file's `tkhd` matrix, which `source-colour.js` can parse, and apply it when the canvas is drawn. `drawView` already supports quarter turns.
2. Replace the exact size check with a check on orientation and aspect ratio, and log a clear message when the reader falls back.

**How to test.** Load a portrait iPhone clip and a landscape one, and check which path each takes.

---

## 7. Preview clips wide-gamut colour, so P3 export can add no colour

**Severity:** Medium. This is a design limit, and it explains why the P3 export looked unchanged.
**Where:** the preview converts everything to sRGB (`src/media/source-frames.js`, `createConverter(tags, 'srgb')`). The palettes in `src/rendering/dither/palettes.js` are sRGB.

**What happens.** Colours outside sRGB are lost before export, so a P3 export contains nothing sRGB cannot show. Even with the preview kept wide-gamut, the palettes are sRGB values, so the artwork gains no colour unless wide-gamut palette values are added.

**Research.** MDN documents `getContext('2d', { colorSpace: 'display-p3' })` and reading pixels in another colour space with `getImageData(..., { colorSpace: 'srgb' })`, and a `float16` pixel format for values above 1 ([MDN getImageData](https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/getImageData); [MDN ImageData](https://developer.mozilla.org/en-US/docs/Web/API/ImageData/ImageData)). The sources did not give browser support for these options, so check them before relying on them.

**Proposed solution.**
1. Draw the artwork on a `display-p3` canvas when the export is P3, and read it back with the matching colour space.
2. Keep the source in its own gamut through the preview, and convert only at the output.
3. Add wide-gamut palette values if you want the palettes themselves to use P3 colours.
4. Be clear in the export window that P3 only adds colour when the source or the palette has colour outside sRGB.

**How to test.** Use a P3 test image with saturated greens, export it as P3 and as sRGB, and compare the greens in a colour-managed viewer.

---

## 8. Dither HTML and JS leave out halation and aberration

**Severity:** Low. This is documented in the code.
**Where:** `src/export/javascript-exporter.js`, `encodePacked`, sets `halation: 0, aberration: 0` for the packed frames.

**Proposed solution.** `optics.js` is already in the runtime (`RUNTIME_MODULES`). Store the optics parameters in the payload and apply `applyHalation` and `applyAberration` to the painted canvas in the page. This keeps the page close to the app.

**How to test.** Export a Dither still with halation on, and compare the page with the app.

---

## 9. The context coder's output buffer has a fixed size

**Severity:** Low. No failure found.
**Where:** `src/export/ctx-coder.js:18` allocates `capacity` bytes. Line 27 writes `this.buf[this.n++]`. A typed-array write past the end is silently ignored, so the output would be truncated.

**What the tests showed.** Random 4-bit data coded to about 0.5 bytes per cell against a capacity of one byte per cell, and the round trip matched exactly. Extreme inputs that mispredict every cell might exceed the capacity, but I did not find one.

**Proposed solution.** Grow the buffer (double it and copy) when `n` nears the capacity, or throw an error when `n` exceeds it. Either is a few lines.

---

## 10. Two different fallback widths

**Severity:** Low.
**Where:** `src/export/image-exporter.js:36` (`standaloneSize`) falls back to `data.width`. `src/export/javascript-exporter.js` (`exportWidth`) falls back to `EXPORT_MAX_WIDTH` (960).

**Proposed solution.** Use one shared function for both, so the size shown in the export window always matches the file written.

---

## 11. DCI-P3 is treated as Display P3

**Severity:** Low.
**Where:** `src/media/colour.js:277` maps primaries code 11 (SMPTE 431, DCI white) to `'p3'`, which uses the D65 white.

**Proposed solution.** Add a separate `dci-p3` primaries entry with the DCI white, adapted to D65 with Bradford (the ICC code in `src/export/icc.js` already does this for D50). Or document the mapping as an approximation.

---

## 12. A stalled seek repeats the previous frame silently

**Severity:** Low.
**Where:** `src/media/frame-extractor.js:193`: `seekTo` resolves after 2 s with no error, so the sampler reads the old frame.

**Proposed solution.** Count the timeouts, and show a status message such as "3 samples repeated a frame" when the sampling ends. Confirm the seek with `requestVideoFrameCallback` where the browser supports it.

---

## What the research could not answer

- Browser memory limits for typed arrays and `ArrayBuffer` on current Chrome and Safari (item 3).
- Seek latency and a recommended seek-then-capture pattern (items 2 and 12).
- Whether `VideoFrame` can be created from a video element in every target browser. MDN's current page and an older mirror disagree on availability ([MDN VideoFrame](https://developer.mozilla.org/en-US/docs/Web/API/VideoFrame/VideoFrame)).
- Browser support for `colorSpace` and `float16` on canvases (item 7).
- Whether the iPhone clip's rotation survives into the `VideoFrame` (item 6).

## Sources

- USPTO 7953286, automatic contrast enhancement: https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/7953286
- USPTO 10771712, optimised exposure temporal smoothing: https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/10771712
- FFmpeg `vf_normalize.c`: https://fuchsia.googlesource.com/third_party/ffmpeg/+/refs/tags/n6.0/libavfilter/vf_normalize.c
- Intelligent Brightness: https://infognition.com/brightness
- ITU-R BT.2408 report: https://www.itu.int/dms_pub/itu-r/opb/rep/R-REP-BT.2408-2017-MSW-E.docx
- libplacebo commit: https://code.videolan.org/videolan/libplacebo/-/commit/9d9164773
- pixls forum, HLG and HDR10: https://discuss.pixls.us/t/experimenting-with-hlg-and-hdr10-for-still-images/23361?page=3
- VideoQ blog, unified HDR reference white: https://blog.videoq.com/?p=45
- WebKit bug 283448, requestVideoFrameCallback: https://bugs.webkit.org/show_bug.cgi?id=283448
- WebKit list, iOS mediaTime, August 2023: https://lists.webkit.org/pipermail/webkit-unassigned/2023-August/1119080.html
- Stack Overflow 66154604, mirror: https://kaweah.freedombox.rocks/kiwix/stackoverflow.com_en_all_2023-11/questions/66154604/most-accurate-video-pause-on-earth-currenttime-vs-mediatime-and-requestvideofr
- MDN, Invalid array length: https://developer.mozilla.org/docs/Web/JavaScript/Reference/Errors/Invalid_array_length
- MDN, VideoFrame: https://developer.mozilla.org/en-US/docs/Web/API/VideoFrame/VideoFrame
- MDN, CanvasRenderingContext2D.getImageData: https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/getImageData
- MDN, ImageData: https://developer.mozilla.org/en-US/docs/Web/API/ImageData/ImageData
- MDN, Secure contexts (for WebCodecs on `file://`, from the earlier review): https://developer.mozilla.org/en-US/docs/Web/Security/Secure_contexts
