# JS Rusty

**Live app: https://martintimmer.github.io/JS-Rusty/**

**JS Rusty is a standalone GitHub application, and it is free to use.** Open the link in a modern browser: there is
nothing to install and no account to create. The source code is in this repository under the Apache License 2.0
(see [LICENSE](LICENSE)).

JS Rusty turns a photo or a short video into generative artwork drawn with JavaScript. Everything runs
locally in the browser: no AI models, no servers, no accounts, no network calls while you work.
The artwork can be shown live, exported as a still or an animation, or packaged as a standalone
JavaScript file or HTML page that draws the same artwork on its own.

This document explains how JS Rusty is built, the methodology behind each stage, and how the code is
organised.

---

## 1. Technology stack

| Need | Suggested in the brief | What JS Rusty uses | Why |
|---|---|---|---|
| Optical flow and motion detection | OpenCV.js | **Own block matching** in a Web Worker (`src/media/motion-analysis.js`) | No large WebAssembly library to download. A three-step search over 16×16 blocks gives the coarse motion the renderers need. **OpenCV.js is not used.** |
| Video decoding and frame extraction | FFmpeg | **The browser's `<video>` element** (`src/media/video-loader.js`, `frame-extractor.js`) | Browsers already decode MP4, WebM and (where supported) MOV. Frames are taken by seeking and drawing to a canvas. **FFmpeg is not used.** |
| Rendering and animation | Canvas / WebGL | **Canvas 2D**: pixel buffers (`ImageData`) for raster engines and `Path2D` for vector engines | Every engine runs on the CPU in plain JavaScript, and Canvas 2D is enough at 1080p. **WebGL is not used.** |
| Heavy work off the UI thread | Web Workers | **One module Worker** for motion estimation | Keeps the page responsive while a clip is analysed. |
| Frameworks and build tools | Avoid unnecessary frameworks | **None.** Plain HTML, CSS and ES modules. No bundler. | Runs from a static folder with a local HTTP server. |

Two other pieces are written from scratch because no dependency was needed: a GIF89a encoder with LZW
compression (`src/export/gif-encoder.js`), and the standalone exporter, which reuses the renderer source
(`src/export/javascript-exporter.js`).

---

## 2. Running it

```bash
cd javascript-art
python3 -m http.server 8001
# open http://localhost:8001
```

ES modules and Web Workers need HTTP, so do not open `index.html` from `file://`. Standalone exports
do work from `file://`.

Browsers: current Chrome, Edge, Firefox or Safari. WebM recording needs MediaRecorder with VP8 or VP9.
Standalone exports need `CompressionStream` and `DecompressionStream` (Chrome 80+, Firefox 113+,
Safari 16.4+).

### 2.1 On iPhone, iPad and iPadOS

Serve the folder from a computer on the same network (`python3 -m http.server 8001`), then open
`http://<computer's address>:8001` in Safari. Over plain HTTP on a local network, Safari loads the modules and the
workers, so the app runs there as it does on a computer. Tap **Add to Home Screen** to open it full screen (the page
head sets the web-app title, theme colour and icon).

- The default output is 1080p on every device. Every processed frame is held in memory, and iOS limits the memory a tab
  can use, so on a phone or tablet a long clip is shown at a smaller size when its frames would not fit about 400 MB.
  Both settings can be changed in the Output card.
- Choosing a file is by tapping the empty canvas area (drag and drop from Files is not available on iPhone).
  Photos and videos from the photo library open through the system picker. HEIC photos are decoded by Safari.
- On screens up to 900 px wide the canvas always has the top of the screen. The menus sit in a dock below it: **Algorithm** and **Settings** switch between them, and **Hide** gives the canvas the whole screen. Each menu scrolls inside the dock. Controls are at least 44 px high, and form fields use 16 px text, so Safari does not zoom in on them.
- WebM recording needs a MediaRecorder that writes WebM, which iOS does not provide. WebM is therefore not offered
  on iPhone or iPad. GIF, PNG, JPG and the standalone files are.
- A very large GIF or a long 1080p clip can exhaust the memory of an older iPhone. Lower the resolution or the
  frame rate first.

### 2.2 Viewing the artwork

On a phone the photo uses the whole screen, and the browser does not pinch-zoom or pull to refresh the page. Pinch to zoom
the photo, and drag to pan it when zoomed. Drag up on the photo or on the menu tabs to open the settings, and drag down to
close them. The zoom buttons are not shown on a phone, since pinch replaces them.

The top bar runs across the whole window. It holds the **Artwork**, **Original** and **Split** views, the zoom
level and the size of the rendered canvas in pixels. **Fit** scales the artwork to the window. Double-click it (or
double-tap on a touch screen) to zoom to 200% and double-click again to return to fit. The point you click stays
under the pointer while the view zooms. The + and − buttons step through the zoom levels.

### 2.3 Layout (desktop)

The left sidebar starts with the **Output** card: the resolution and the **Export…** button on one line. Below it
are **Algorithm** and **Palette**. The **Source** panel is pinned to the bottom of the left sidebar and stays in view
while the sections above it scroll. It shows the file and its size, has an **Open…** button and, for video, a one-line frame-rate row. The Output card offers Original, 1080p (the default), 720p and 480p. It holds
The right sidebar holds the settings. Saturation and Grayscale are in Tone, and the seed for random threshold dithering is in the Dither panel.

Drag the thin bar between a sidebar and the canvas to change that sidebar's width. The arrow keys move the bar when it
has focus (hold Shift for bigger steps), and double-clicking the bar restores the default width. Widths are kept in
this browser's local storage. On phones and tablets the menus sit in the dock instead, as described above. On phones and tablets, the A− and A+ buttons in the menu bar change the size of the text and controls. The Zoom buttons in the top bar zoom the picture only. The choice is kept in this browser.

---

### 2.4 Live camera

The **● Live** button in the top bar opens the phone camera full screen, in portrait. The preview is the
Dither engine at a 480-pixel short side, with the dither method and palette you have chosen. Press and hold the record
button to record the plain camera picture, up to 10 seconds; the timer stops the recording at 10 seconds.

- The camera needs an https page (the GitHub Pages address) and the browser's camera permission. Video only: no
  microphone is asked for.
- Each clip is kept on this device in IndexedDB, in the **Clips** library. It is not uploaded. If the browser refuses to keep
  a clip, the clip is downloaded instead, and the status line names the error. **Download** saves a copy
  to Files, which survives Safari's cleanup of unused site data. **Edit** opens the clip in the normal video path, where
  it is processed at the output size, 1080p by default, with every algorithm and setting. Recordings often cannot be
  seeked, so when a clip does not seek the frames are read by playing it through once, which takes about as long as the clip.
- 1080p means the short side is 1080 pixels, so a portrait clip is processed at 1080×1920.
- The strip under the top bar changes the palette and the algorithm, with the same settings as the editor. Live mode opens
  with the six-colour Apple II palette; Classic Mac OS is the next chip.
- The lens button cycles through every camera the browser lists: each rear lens, then the front camera. Chrome on Android
  usually lists the ultra-wide and telephoto lenses separately. Where the browser lists one rear camera but allows zoom,
  the button offers 0.5×, 1×, 2× and 3× on that camera. iPhone Safari does not list its ultra-wide and telephoto lenses
  as separate cameras, and often does not allow zoom, so there the button cycles the rear and front cameras only. This
  is not yet tested on an iPhone.
- **Settings** (top bar) opens the editor's controls in a band under the picture, the same Tone, Dither and other panels,
  so a change shows on the preview at once and the picture stays in view. **×** closes the band.
- The camera is asked for 720p at 60 frames a second. The line under the picture shows the rate the camera delivers (some
  phones give 30), the time each preview frame takes, and the preview size. The preview steps down from 480 to 256 pixels
  when a frame takes too long, and grows back when there is room.
- The picture fills the screen, and the buttons float over it, as in the camera app. Hold the record button and slide up
  to zoom, up to 5×. The zoom is also in the clip. It is a crop of the picture, so the higher the zoom, the less detail.
- Gestures on the picture, as in the camera app: pull down to hide the buttons (the shutter stays), tap to bring them back,
  and move up to open the settings. Pull down again, or press ×, to close the settings.
- A clip in the **Clips** library has a **Share** button where the browser can share files. On iPhone, the share sheet has
  **Save Video**, which puts the clip in Photos.
- **Vibration** (top bar) sets the feel while you hold the record button: Heartbeat, Tick, Countdown (the beat speeds up
  over the last seconds), Pulse, or Off. The cue starts with the press, repeats while you hold, and stops when the
  recording stops. Android vibrates with the Vibration API. iPhone Safari has no such API; its cues use the switch tick of
  iOS 18 and later. The first tick of each cue is made inside the tap; later ticks are timers, which may not reach the phone.
  When a recording is saved, the status line reports the mechanism and how many ticks were sent, so you can tell whether the
  code ran even if the phone feels nothing. Reports from the open-source iOS haptics libraries say Apple blocks ticks that a
  web page makes from script from iOS 26.5, so on current iPhones they are not expected to be felt. Haptics during a hold
  would need a native app.
- A tap on the picture shows a focus square. The camera is focused and exposed at that point only where the browser lets
  the page set it.
- Not available in this version: HDR capture, and flash. Zoom appears only as lenses, and only where the browser allows it.
- The plan and its checks are in `docs/live-camera-plan.md`. Nothing has been tested on a phone yet.

---

## 3. Methodology: the processing pipeline

Every artwork passes through the same pipeline. Stages 1 to 4 run once per source, automatically after
an upload, and again when the sampling rate or resolution changes. Stages 5 to 7 run every time a frame is drawn.

### 3.1 Sampling (`frame-extractor.js`, `image-loader.js`)

- **Video.** The source `<video>` is seeked to `k / fps` for each sample `k` (by default the source frame rate, or a custom rate, up to 120 fps;
  a clip may have up to 5000 frames). The source rate is measured by playing the clip muted for about a second and reading the presented frame times; where the browser cannot report frames, 30 fps is assumed. The frame rate is never lowered, so the artwork plays at the clip's own speed. A clip over 5000 frames is refused.
  When its frames would not fit the memory budget (about 2 GB on a desktop, 400 MB on a phone), the picture is made
  smaller, keeping its shape, and the status line says so. Each sample is drawn twice: at display size for rendering, and at half
  size for motion analysis. Both are converted to 8-bit luminance with Rec. 601 weights,
  `(77R + 150G + 29B) >> 8`.
- **Still image.** The same path with one frame.
- **Size.** The source is fitted inside the chosen resolution box (1080p = 1920×1080 by default), keeping
  its aspect ratio. Small sources are scaled up to the box.

### 3.2 Tone mapping (`media/tone.js`)

One auto-levels stretch is computed from the 0.5th and 99.5th percentiles of **all** frames together, and
applied to every frame. One mapping for the whole clip keeps tones from flickering between frames.

### 3.3 Analysis grid (`rendering/core.js`, `buildGrid`)

Every engine reads the same analysis grid, whose cells are 2 display pixels across:

1. **Contrast and brightness** go through a 256-entry lookup table.
2. **Denoising.** A separable Gaussian blur removes JPEG noise. Its sigma falls from 2.2 to 0.45 cells as
   *Detail* rises, so high detail keeps fine structure.
3. **Darkness** is `1 − luminance`.
4. **Edge halo** is a local-contrast term: `ink = darkness + halo × (darkness − local average)`, where the
   local average is a box blur of radius 5 cells. Dark subjects get a heavier outline and a lighter margin
   on the paper, the white-outline look of classic engravings.

Engines sample the grid bilinearly (`sampleInk`), so there are no visible cell steps.

### 3.4 Motion estimation (`media/motion-analysis.js`, in a Web Worker)

For each pair of consecutive samples `k → k+1`:

- The half-size frames are cut into 16×16 analysis blocks. At 1080p each block covers 32×32 display pixels.
- A **three-step search** (step sizes 4, 2, 1, within ±8 analysis pixels) finds the integer displacement that
  minimises the **sum of absolute differences** between a block in frame `k` and the displaced block in
  frame `k+1`. The sum uses every second pixel, which halves the work.
- The **frame-difference energy** of each block is the mean absolute difference at zero motion.
- Vectors are scaled back to display pixels and stored as Int8 quarter-pixels. Energies are stored as Uint8.

On a 10 s clip at 10 fps this takes about half a second in the worker.

### 3.5 Flow field (`rendering/flow.js`)

A structure tensor (`Jxx`, `Jyy`, `Jxy` from the gradients of the analysis grid, smoothed) gives a direction
field. The dominant orientation is perpendicular to the gradient, so it runs along contours. Where the
structure is not coherent, the direction falls back to horizontal. Pencil and linocut use it.

---

## 4. The animation model

The animation types change the algorithm's inputs over time, and the algorithm draws each frame again. Nothing is
laid over the finished picture. The types live in `src/rendering/motion-field.js`, and the engines that draw their own
marks read them through `rc.motion`.

The motion works in three layers, cheapest first:

- **L0, the grid.** Every engine reads the same analysis grid (the tone). Pulse, Hover and Ripple displace that grid
  smoothly before the engine runs, so the engine redraws its own marks from the moved tone. Lines stay crisp, and no
  pixel is resampled. Snake, on an engine without strokes of its own, is a darkness bead that runs along each row of
  the grid.
- **L1, the engine's own marks.** Some engines move the marks they draw (`MF_NATIVE` in `motion-field.js`):

  | Engine | Pulse | Hover | Snake | Ripple |
  |---|---|---|---|---|
  | Engraving (horizontal lines) | — | each line bobs on its own phase | a bead of extra ink runs along each line | — |
  | Contour | levels sweep up and down the tone range | — | a bead runs along each chain | — |
  | Stippling | — | each dot floats on a small circle | — | — |
  | Halftone | dot radius swells in rings from the darkest mass | each dot floats | — | — |
  | Wave lines | — | — | a bead runs along each ridge | a wave travels along the ridges |
  | Pixel sort | the sort band slides up and down | — | — | — |
  | Dither | the tone is offset in rings from the darkest mass, so the threshold waves | — | — | — |
  | Pencil | — | — | a bead of graphite runs along each streamline of the flow | — |

  Engraving's diagonal and crosshatched patterns, and every other engine, take the type through the grid (L0).
- **L2, the still decides.** The outline of the darkest subject (ink above one half) gives a distance field. Ripple's
  wave fronts start there and travel outward, and they drift in the Wave direction. The ink centroid, the darkest
  mass, is the centre of Pulse's rings, and dark areas move more than paper.

Rules:

- **Rest.** Off gives the still. With Depth (Velocity) at 0, the picture is the still too, for stills and for video (on
  video, Motion influence is scaled by Depth as well). Speed 0 freezes
  the motion where it is, so the picture stays in that pose rather than returning to the still.
- **The algorithm stays available** with any motion type. Changing the algorithm keeps the motion on.
- **Time.** Each term runs a whole number of cycles per loop. A still's loop is 6 s ÷ Speed (2 to 12 s, so 6 s at
  Speed 1, see `stillLoopSeconds` in `core.js`), and video loops at its clip length. A GIF of a still covers exactly one
  loop at the live rate, so its last frame leads into its first and moves as fast as the picture on screen. A recording
  of a still is one loop too. Live, the clock runs continuously at Speed, and changing Speed does not jump the picture.
- **Stills start moving when a motion type is chosen**, and stop when Off is chosen. Play and Pause hold the clock,
  and Restart resets it to zero.
- **Video** can be animated as well. The motion runs over the clip's own clock, and it loops with the clip. Motion
  influence adds the block motion vectors to the displacement of Pulse, Hover and Ripple. Stippling and Contour also use
  the vectors directly, as before. The source `<video>` is not the clock. It is shown only in the Original and Split
  views, where it is kept in step with the artwork clock.
- **Trail** (stills, with Pulse, Hover or Ripple). The picture a moment ago (0.4 s of motion time earlier) is blended
  into the tone, darker wins, and the Trail percentage fades it. The engine draws that tone, so the marks of the moment
  before stay behind as the algorithm's own strokes. Loops still close, because the earlier moment is part of the same
  periodic motion.
- **Packed Dither exports** are a fixed picture, so they carry no motion. The other algorithms export their motion in
  the standalone file.

How each type works:

- **Snake.** Each stroke carries a snake on a share of the strokes (the Snakes control, in percent). The snake is a
  bead that runs along the stroke from a tail up to its head, and it leaves the end and reappears at the start. Each
  snake runs one or two laps per loop. On Pencil, the streamlines of the flow are traced from dark seeds, and the bead
  is extra graphite on one of them. On video, Motion influence makes a bead thicker where the picture moves at its head.
- **Pulse.** On contours, each level moves up and down the tone range, staggered across the levels, so the lines
  breathe. On halftone, dots swell in rings from the darkest mass. On Dither, the tone is offset in the same rings, which
  moves the threshold. Elsewhere, the grid is displaced in rings from
  that centre (170 px wavelength at 1080p).
- **Hover.** Each line, dot or region floats on its own phase, from smooth value noise on a 96 px lattice, so
  neighbours move out of step. On the grid the float is 1.6 px at 1080p, with a 1.2 px floor so small exports still
  move.
- **Ripple.** Wave fronts (240 px wavelength at 1080p) leave the subject's outline and travel outward. They drift in the
  Wave direction. Ridges in Wave lines travel as well.
- **Displacement, in general.** The grid is displaced on an 8 px node field, interpolated bilinearly, and sampled
  bilinearly at each cell. A displaced mark is smooth, not stepped.

The analysis grid of a still is built once for each setting that changes it. The motion moves a copy of it, so a
still with motion does not rebuild the grid on every frame.

The point set and triangulation of the low poly engine are cached while their settings hold still, so on
video the mesh stays fixed while the shading follows the picture.

---

## 5. The rendering engines

Each engine reads a subset of the controls (section 9). Pixel engines write an `ImageData` buffer; shape
engines draw with `Path2D`.

| Engine | File | Method |
|---|---|---|
| Horizontal engraving | `engraving.js` | One pass per line. Weight follows tone, and each line has its own jitter and wobble, so it looks hand-drawn. Diagonal and crosshatched patterns use a per-pixel pass. |
| Stippling | `stippling.js` | Dots placed by inverse-CDF sampling of darkness (low-discrepancy ranks) and sized by darkness. |
| Contour | `contour.js` | Marching squares on the ink field, with crossings stitched into continuous polylines. |
| Contour drawing | `contour-drawing.js` | Marching squares on a smoothed field, stitched into chains. Each chain is a tapered ribbon whose width follows its level (Tone weight), broken and jittered like a hand, with optional hatching in the darkest areas. |
| Low poly | `lowpoly.js` | Points are drawn from a jittered lattice plus points weighted by the tone gradient (Feature detail), then triangulated by Bowyer–Watson Delaunay. Each triangle is one flat shade of the darkness under its centre. Paper gaps and an optional outline separate the facets. |
| Halftone | `halftone.js` | Hexagonal dot lattice, rotated 15° and jittered, sized by darkness. |
| Pencil sketch | `pencil.js` | Line integral convolution of a noise texture along the flow field, thresholded against darkness, plus contour outlines and paper grain. |
| Wave lines | `waves.js` | Rows lifted by darkness, drawn top to bottom with occlusion. |
| Dither | `dither.js`, `rendering/dither/` | Eight methods: Atkinson (default), Floyd–Steinberg and Jarvis–Judice–Ninke error diffusion; Bayer 8 × 8 and 4 × 4, random threshold and blue-noise ordered dithering; and none (direct quantisation). Two to sixteen tonal levels, or a palette from the library of 18 presets (eight-bit machines, retro displays and artistic photography), or your own palette of 2–16 colours. Optional colour from the photo (Grayscale off, with a palette), saturation, dither strength, dither cells from 1 to 16 px, adaptive threshold, edge-preserving diffusion, serpentine scan, gamma, grain, invert and temporal stabilisation. See section 5.1. |
| Oil paint | `oil.js` | Kuwahara filter with summed-area tables: the mean of the lowest-variance quadrant. |
| Linocut | `linocut.js` | Two-tone: solid where dark, flow-aligned gouge streaks in the middle tones, outlines on edges. |
| ASCII | `ascii.js` | A glyph per cell, chosen by darkness from a light-to-dark ramp. |
| Pixel sort | `sort.js` | Runs of pixels within a luminance band are sorted along rows or columns. |
| Motion | `rendering/motion-field.js` | Snake, pulse, hover and ripple: they move the analysis grid and the marks of the engines that draw them (section 4). |

`src/rendering/artwork.js` builds the analysis grid, moves a copy of it when a motion type is on, and draws the selected
algorithm on that grid.

### 5.1 Dither

The Dither engine (`src/engines/dither.js`) runs this pipeline on the analysis grid, once per frame:

1. **Source.** The darkness of each analysis cell. **Grid size** sets the dither cell in canvas pixels, from 1 to 16.
   Even sizes average blocks of analysis cells. Odd sizes, including 1 px, sample the analysis grid bilinearly at each
   cell centre, and at 1 px the lattice is the full canvas. That is the slowest setting.
2. **Temporal stability** (off by default). The source is blended with its previous value, but only where the
   change is small, so sensor noise is smoothed and moving edges pass through without ghosting. Levels also keep
   their previous value inside a hysteresis band, which stops cells near a threshold flickering.
3. **Tone.** Invert, then gamma (image gamma on luminance), then **Grain** (a random value added to each cell's tone),
   then **Density** (the original tone gain). The grain seed changes on every rendered frame, so the grain moves. During
   playback each frame has new grain. A still with animation off re-rolls the grain only when it is re-rendered, for
   example after a parameter change.
4. **Threshold.** A global threshold (default 50, the original midpoint). With **Adaptive threshold** above zero,
   each cell's threshold moves toward its local mean tone, but only where the local contrast is high enough. Flat
   areas keep the global threshold, so noise is not amplified.
5. **Quantise** with the chosen method. Every method produces a palette index per cell, which the painter maps to
   a colour.
6. **Paint.** The indices are written to a cell-resolution canvas and scaled up once with `drawImage`, with
   smoothing off. That is a nearest-neighbour upscale, so no per-pixel loop runs in JavaScript.

**Methods.** Atkinson (default; the original look) passes 6/8 of the error to six neighbours. Floyd–Steinberg
passes all of it to four neighbours. Jarvis–Judice–Ninke passes all of it to twelve neighbours over three rows.
Bayer uses an 8 × 8 or a 4 × 4 threshold matrix. Random threshold compares each cell with a fixed pseudo-random
threshold from a 128 × 128 seeded tile, so the dots are scattered with no regular pattern. None (direct quantisation)
uses no threshold pattern: each cell takes the nearest level or palette colour, which posterises the picture. Blue noise uses a 64 × 64 void-and-cluster tile, built once from a fixed
seed, so it is the same in every session and export. Serpentine scan, **Diffusion strength**, and **Edge
preservation** apply to the three error-diffusion methods only. **Dither strength** is the same slider for the ordered
methods (Bayer, random threshold and blue noise). It scales the threshold pattern about mid grey, so 0% is plain
rounding and 100% is the full pattern.

**Colour from the photo.** With **Grayscale** on, a palette chooses its colours by tone, as before. Grayscale is off by
default, with PICO-8 (an 8 bit palette), and choosing any 8 bit palette turns it off.
Turn Grayscale off and, with a palette chosen, each cell takes the palette colour nearest to the photograph's own
colour. The photo's colour passes through Contrast, Brightness and **Saturation** first (100% is as photographed,
0% is grey, 200% doubles the colour). Error diffusion carries the colour error from cell to cell, so mixtures average
back to the photograph's colours. The colour frames are kept at analysis size, which adds about three quarters of
the memory the grey frames use.

**Levels and colour.** Tonal levels (2, 3, 4, 8 or 16) interpolate between paper and ink. A palette replaces them.
The **Palette** panel, in the left sidebar below Algorithm, applies to every algorithm. It lists 18 presets in three
groups, 8 bit (shown first), Retro Displays and Artistic Photography, plus paper and ink. PICO-8 is the default palette, and the 8 bit group holds Commodore 64, ZX Spectrum, NES, Apple II hi-res, MSX, Classic Mac OS, Game Boy and CGA. The 8 bit colours are exact palette values from the sources named in the commit; the NES set is 16 of its 55 colours, and the MSX values follow the CLK emulator, which differs from real hardware, as compact tiles with a mini line
icon and a strip of their colours. For the two-colour algorithms, a palette supplies its lightest colour as paper and
its darkest as ink. The Dither algorithm uses the whole palette. Each card shows its swatches, colour count, description, use and suggested
method. Choosing a palette never changes the method. Custom palettes take 2 to 16 colours, entered as HEX or with a
colour picker. Colours can be removed and reordered. **Save to session** keeps a copy in the panel, **Restore original**
returns an edited preset to its colours, and **Restore presets** clears the saved palettes and any edits. Saved palettes
are not kept across reloads.

**Palette maths.** Colours are stored as sRGB, which is how the presets are written and painted. Blending happens in
linear light, and "nearest" is measured in OKLab, which is close to perceptually uniform. Error diffusion works on the
grey target in RGB: the error is the difference between the target and the chosen colour, and it is diffused through
the kernel. Accumulated targets are bounded to a small margin, so the error does not drift. Ordered methods use a mix
table, built once per palette: for each of the 256 grey levels it stores the pair of palette colours and the fraction
that best mixes to that grey. Each cell is then one lookup, and the output is always an exact palette colour. Palette
order does not affect the result.

The defaults (Atkinson, PICO-8 palette, every option at zero or off) reproduce the original renderer's output, and a
check against it was run on several parameter sets.

---

## 6. Project structure

```
index.html                     page layout; every control has data-ctrl (per algorithm) or data-media (per media)
styles.css                     dark theme
icon/                          logo and favicon (SVG and PNG)
src/
  app.js                       application state; upload, processing, playback, exports, control visibility
  ui.js                        DOM helpers; applies per-algorithm and per-media visibility
  layout.js                    resizable sidebars: the splitter bars, their widths kept in local storage
  empty-state-art.js           the line drawing on the empty canvas, coloured from the palette presets
  algorithm-controls.js        which sliders each algorithm and animation type uses (no DOM, testable)
  algorithm-icons.js           the monochrome line-art icons of the algorithm grid
  palette-panel.js             the palette library, its cards and the custom palette editor
  device.js                    touch detection; the frame limit and the default resolution for phones and tablets
  export/export-dialog.js      the export window: format, size, options and the blurred preview
  export/blur.js               the blur applied to exported pixels
  media/
    image-loader.js            still images -> a one-frame sequence
    video-loader.js            <video> loading and the 30-second limit
    frame-extractor.js         seeks the video; samples frames at display and half size
    motion-analysis.js         block matching and frame differences (runs in the worker)
    tone.js                    global auto-levels
  workers/
    processing-worker.js       runs motion-analysis.js off the main thread
  rendering/
    core.js                    parameters, lookup table, analysis grid, blur, sampling, CDF helpers
    flow.js                    structure-tensor flow field
    dither/                    dither methods, tone, adaptive threshold, edges, temporal state, colour sets, palettes
    colour.js, palettes.js     sRGB, linear light and OKLab; the palette library and its mix tables
    artwork.js                 owns the canvas and the analysis grid; dispatches the engines
    motion-field.js            motion types: the grid displacement, the time model and the engines' own marks
    animation-controller.js    requestAnimationFrame loop; playback clock; render-on-change
  engines/                     one file per renderer (section 5)
  export/
    javascript-exporter.js     standalone JS: packs the data and embeds the renderer source
    html-exporter.js           standalone HTML page around the same script
    image-exporter.js          PNG, JPG and GIF (animations are rendered offscreen)
    gif-encoder.js             GIF89a encoder with LZW compression (no dependencies)
    video-exporter.js          WebM through MediaRecorder
```

Design rules:

- **Engines are functions of a render context** (`rc`): the canvas context, the analysis grid, the parameters,
  the motion data, the frame index, the clock and an engine-private state object. An engine never touches
  the page.
- **Engine files are self-contained**, so the same files can be concatenated into the standalone export.
- **Top-level names are unique across the renderer.** Helpers are prefixed per engine (`oil…`, `lin…`, `cdr…`,
  `lp…`, `mot…`). A check compares top-level names across all renderer files before a release.

---

## 7. Build, packaging and the standalone export

There is no build step. The browser loads the ES modules directly.

The standalone exports reuse the **same renderer source**, so the exported artwork is the artwork you see:

1. `javascript-exporter.js` fetches the renderer files in dependency order: `core.js`, `flow.js`, the engines
   (with the dither modules before the dither engine), then `artwork.js`.
2. It strips the `import` and `export` lines and concatenates the files inside one IIFE.
3. For every algorithm except Dither, it packs the frames. Each frame is resampled to the chosen width and stored as 8-bit grayscale. The first
   frame is stored whole, and each later frame is stored as a byte-wise **delta** from the one before, which
   is mostly zeros for video. The block is compressed with `CompressionStream('deflate')` and base64-encoded.
   Motion vectors and energies are embedded the same way.
4. The output exposes `window.RasterArt.mount(target, options)`. It decodes the data and runs the same renderer
   with the same animation clock. It handles play, pause, seek and parameter changes.

**Dither artwork is packed differently.** The Dither engine runs on every frame at export time, and the palette index of
each cell is packed at the smallest bit depth that holds the palette: 1 bit for two colours, 2 bits for three or four,
3 bits for five to eight, and 4 bits for nine to sixteen. The bit stream is compressed with zlib
(`CompressionStream('deflate')`) and base64-encoded. The page paints the indices with the palette table, so it shows the
picture the app showed, without dithering again. Dither exports are at the processed size, so the width setting does
not apply to them. Packed Dither exports are a fixed picture, so they carry no motion (section 4).

The HTML export wraps the same script in a page that opens from `file://`.

---

## 8. Export formats

Every export is made from the export window, opened by the Export button in the Output card at the top of the left sidebar. It holds the format, the output width, JPG quality, the GIF frame rate and Output blur. The output size and length are shown before you export, and a preview beside them shows the centre of the output at its real size, with the blur applied. Blur applies to the saved PNG, JPG and GIF files, so they match the preview. WebM, MP4, HTML and JS are not blurred.

| Format | Content | Notes |
|---|---|---|
| Standalone HTML | Animated or still artwork that runs on its own | Width 1920, 960, 640 or 320 px (Dither: processed size, packed indices) |
| Standalone JS | `js-rusty-art.js`, for `<script src>` | Same data; `RasterArt.mount()` |
| MP4 | Live recording of the canvas as H.264 (MPEG-4 AVC) or HEVC in an MP4 file | Animated or video artwork only. Compression is High quality, Balanced or Small file; the bit rate scales with the frame size. Only the codecs the browser can record are enabled. MPEG-4 Part 2 cannot be recorded by any browser, so it is not offered. |
| PNG | The current frame | Stills only |
| JPG | The current frame, quality 50–100 | Stills only |
| GIF | One frame for a still, or an animation when animation is on. A still's animation is one loop of 6 s ÷ Speed (2 to 12 s), which closes | Palette is a 256-step ramp from paper to ink, which every engine uses. For a palette from the Dither library, the GIF keeps the palette's own colours (up to 16). Other algorithms use the ramp from the palette's paper to its ink. Frames are stored in full, with no inter-frame optimisation, so files are large. Up to 150 frames, looping forever. A clip that needs more than 150 frames at the chosen rate is sampled at a lower rate, so the GIF covers the whole clip. |
| WebM | A recording of the live canvas | MediaRecorder. MP4 is not offered: no reliable in-browser encoder without extra dependencies. |

The GIF encoder was checked against two independent decoders, on random data (which forces dictionary
resets) and on a dithered frame. Every pixel matched.

---

## 9. Controls per algorithm and per animation type

The sidebar shows only the controls an algorithm or animation type reads, relabelled for it. Palette and Background are hidden while a palette is chosen, because the palette replaces them. Tonal levels are hidden with a palette too. Temporal stability appears for video only, since it smooths change between frames. Detail and Edge halo are offered to every algorithm the shared analysis grid affects. Oil paint and pixel sort do not offer Edge halo, because they read only the luminance grid, which the halo does not change. The mapping lives
in `src/algorithm-controls.js` and was derived from the engine code.

| Algorithm | Detail | Density | Edge halo | Thickness | Other |
|---|---|---|---|---|---|
| Engraving (horizontal) | Line wobble | Line density | yes | Line weight | Pattern |
| Engraving (diagonal / crosshatched) | — | Line density | yes | Line weight | Pattern |
| Stippling | Dot concentration | — | yes | Dot size | Dots; motion (video) |
| Contour | Contour detail | Contour levels | yes | Line weight | motion (video) |
| Contour drawing | Grid detail | — | yes | Line weight | Levels, smoothing, taper, tone weight, level shading, hand jitter, minimum length, breaks, hatch fill, hatch angle, hatch spacing |
| Low poly | — | Facet size | yes | — | Vertex jitter, Shades, Feature detail, Facet gap, Outline |
| Halftone | — | Screen pitch | yes | Dot size | — |
| Pencil sketch | Stroke length | Pressure | yes | — | — |
| Wave lines | Ridge height | Row pitch | yes | Line weight | — |
| Dither | — | Tone gain | yes | — | Method, tonal levels, palette (presets, edits, saved), threshold, adaptive threshold, edge preservation, diffusion strength, serpentine scan, gamma, grain, invert, grid size (1–16 px), temporal stability |
| Oil paint | Brush size | — | — | — | — |
| Linocut | Gouge length | Cut amount | yes | — | — |
| ASCII | Tone levels | Cell size | yes | — | — |
| Pixel sort | Sort threshold | Sort range | — | — | Sort angle |

| Motion type | Algorithm controls | Motion controls | Other |
|---|---|---|---|
| Snake | all of the algorithm's | Motion influence (video) | Snake speed, Snakes (share of the strokes, %), Snake width |
| Pulse | all of the algorithm's | Motion influence (video), Trail (stills) | Pulse rate, Pulse depth |
| Hover | all of the algorithm's | Motion influence (video), Trail (stills) | Hover speed, Hover amount |
| Ripple | all of the algorithm's | Motion influence (video), Trail (stills) | Wave speed, Wave height, Wave direction |

Where a motion type and the algorithm use the same control, the motion's label is shown while that motion is on.

Global controls for every algorithm and animation: contrast, brightness, palette and background.

Media rules: the motion influence slider (Stippling, Contour, and the Pulse, Hover, Ripple and Snake types) appears only for
video, because it needs motion data. Animation types are offered for stills and video. Video-only items
(sampling rate, timeline, WebM) appear only for video. Still-image exports (PNG and JPG) are offered in the export window for stills only, and appear only
for stills.

---

## 10. Testing that was done

- **Syntax** of every module, and a **name check** across the renderer bundle.
- **Control rules.** Which controls each algorithm and animation type shows, for video or still, and for each
  engraving pattern.
- **DOM test.** `index.html` is loaded in jsdom, and the visibility functions are checked: relabelling,
  media-only items, the algorithm lock and the animation selector.
- **Round trip.** Each algorithm and animation type is exported to a standalone bundle, run in a sandbox, and
  rendered. Animated exports are checked to change over time.
- **GIF.** Every frame of exported animations is decoded independently and checked for completeness and change.
- **Real Chrome** (headless, through puppeteer-core). Drop and file-picker loading of PNG, JPG and MP4 files,
  the drop → process → drop → process sequence, and the animation selector on a still and on a video.
  These predate the later changes: the animation selector is disabled for video, processing starts automatically,
  the progress bar is drawn over the canvas, files can be dropped anywhere, and the artwork has its own clock. None
  of these has been re-run in Chrome.

Not yet tested: long videos on real footage in several browsers, and the visual result in Safari and Firefox. Not yet tested either: the line-art empty state, the two-column algorithm grid, and the layout, touch and loading behaviour on iPhone, iPad and iPadOS (Safari), including memory use on a long 30 s clip.

---

## 11. Performance

Measured in Node with `@napi-rs/canvas` on a 1920×1080 test sequence. These are rough guides; browsers differ.

| Engine | Frame time (approx.) | Notes |
|---|---|---|
| Horizontal engraving | ~32 ms | Pixel cost |
| Motion (pulse, hover, ripple) | Not measured yet | One displacement pass over the analysis grid, with no read-back of the frame |
| Snake | Not measured yet | Beads are drawn inside the engine's own loop, and the grid snake is one pass over the grid |
| Halftone | ~50–150 ms | Dot path |
| Pencil sketch | ~60–100 ms | Line integral convolution |
| Low poly | ~15–30 ms | Mesh cached; about 1 500 triangles by default |
| Dither, oil paint, linocut, ASCII, pixel sort | ~17–43 ms | |

Motion analysis for a 10 s clip at 10 fps takes about 0.5 s in the worker.

---

## 12. Limitations

- **Motion is coarse.** Block matching on 16×16 analysis blocks does not capture fine or fast motion.
- **Video is limited to 5000 frames** at its chosen rate (a 60 fps clip can be about 83 s). The picture is made smaller,
  not the rate, when the memory budget needs it: 5000 frames at 1080p would need about 18 GB.
- **Video decoding depends on the browser.** Some MOV (HEVC) files cannot be decoded everywhere; the loader says so.
- **Palettes map tone unless Grayscale is off.** With Grayscale on, a palette chooses colours by tone,
  and hues in the photograph are not carried through. With Grayscale off, only the Dither algorithm follows the
  photograph's colour; the other algorithms still use tone.
- **Oil paint and pixel sort are grayscale**, because they work on luminance only.
- **Low poly** places points by tone gradient. On textured photos the facets follow texture as well as edges, so
  Feature detail and Facet size matter more than on portraits.
- **The anisotropic Kuwahara variant** is not implemented.
- **GIF files are large**, because frames are not compressed between frames.
- **Standalone exports** need `CompressionStream` and `DecompressionStream` in the viewing browser.
- **Phones and tablets** keep about 400 MB of processed frames, so long clips are shown smaller, and iOS may stop a tab that uses too much
  memory. WebM recording is not available on iOS.

---

## 13. References

Research behind the newer engines:

- Adrian Bowyer, *Computing Dirichlet Tessellations*, Computer Journal 1981, and David Watson, *Computing the
  n-dimensional Delaunay tessellation*, Computer Journal 1981: the incremental (Bowyer–Watson) construction used by
  the low poly engine.
- Atkinson dithering, kernel and error fraction: https://en.wikipedia.org/wiki/Atkinson_dithering
- Kuwahara filter, quadrant and selection definitions: https://en.wikipedia.org/wiki/Kuwahara_filter
  (the anisotropic variant by Kyprianidis, Kang and Döllner, 2009, is cited there and is not implemented).
- Pixel sorting, the threshold and sort-key approach: https://github.com/satyarth/pixelsort
- ASCII conversion, the luminance-to-ramp mapping: https://marmelab.com/blog/2018/02/20/convert-image-to-ascii-art-masterpiece
- Linocut and woodcut: no canonical algorithm was found, so the linocut engine is an original design (line
  integral convolution and thresholding). Shader line-width modulation, for context:
  https://clicktorelease.com/code/codevember-2016/22
