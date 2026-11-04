# Live camera mode: plan

Nov 4, 2026 · Martin Timmer

Status: built in the code (src/live/). Not yet tested on a phone, so the phone check is the first gate. Decisions taken: HDR is not captured (standard range, in the page); 1080p is the short side; video only, no audio; clips are kept in IndexedDB with a download to Files; the preset is changed in the normal editor only. Not built: zoom, flash and focus controls, and clip thumbnails (the Clips button stands in for the thumbnail). The same plan is in a Claude Doc, which has the two drawings: https://claude.ai/artifact/TVtuF989A9nvn48yLmjpD6

## Goal and flow

Live mode turns the phone camera into a dithered viewfinder. Hold the record button, get a clip of up to 10 seconds, then edit that clip at full size with every setting.

1. Tap **Live** in the top bar. The camera opens full screen in portrait, with a dithered preview at 480p.
2. The preview uses the dither method and palette you chose, so the live look is a preset you can change first.
3. Press and hold the record button. A timer counts up. Recording stops when you let go, or at 10 seconds.
4. The clip is kept on the phone, in the website's own storage, and listed in a clip library.
5. Live mode closes. The clip opens as a normal video at 1080p, with every algorithm, palette and control.

The recording keeps the plain camera picture. The dither is applied afterwards, so one clip can be processed again with other settings.

## What the browser can and cannot do on iPhone

A web page can show the live camera and record a 10-second clip. HDR capture and the iPhone camera's own controls are not confirmed. Each row says whether the sources show it, or whether it still needs a test on your phone.

| Need | In a web page | What the sources show | Consequence |
| --- | --- | --- | --- |
| Live camera preview | Yes | Camera access is widely available, and Safari on iOS supports it from iOS 11 ([web features](https://web-platform-dx.github.io/web-features-explorer/features/media-capture)) | Built into the page |
| 1080p capture | Not tested | The camera is asked for 1920×1080; the browser delivers the closest mode the camera offers | Test on your phone; fall back to 720p if needed |
| HDR capture | Not confirmed | No source shows HDR through web capture. Apple's HDR capture material covers native apps ([WWDC24](https://developer.apple.com/la/videos/play/wwdc2024/10088/)) | Web capture is standard range, 8-bit |
| Hold to record, 10 s limit | Yes | Recording a camera stream to a file is standard. The file format on iOS is not tested | Build it, then check MP4 on iOS |
| iPhone camera controls (zoom, focus, flash) | Not reliable | No source shows these through the web camera API | Not promised in the first version |
| iPhone's own camera app | Through a file picker | An older test showed a video picker with "Take Video" ([David Walsh](https://davidwalsh.name/html5-camera-video-iphone)). The capture attribute was unsupported on iOS in older tests ([Addpipe](https://blog.addpipe.com/correct-syntax-html-media-capture)) | A fallback for HDR; it leaves the live screen |

The HDR gap matters less than it looks. The artwork is 8-bit, so HDR footage would be converted to standard range before dithering.

## Architecture

```
Camera stream ──► Frame grab (480p) ──► Dither preview
      │
      └──► Recorder (hold, 10 s) ──► Clip store (IndexedDB) ──► Clip library ──► Normal pipeline (1080p)
```

The preview and the recorder both start from the same camera stream. The preview is for framing; the clip keeps the plain camera picture.

Proposed modules:

- `live-camera.js`: opens the camera, switches between rear and front, and delivers the frames.
- `live-preview.js`: draws each frame at 480p and runs the dither engine on it.
- `live-recorder.js`: handles the hold-to-record state, records up to 10 seconds, and passes the clip on.
- `clip-store.js`: saves, lists, reads and deletes clips in IndexedDB.
- `live-screen.js`: the full-screen layout and its buttons.

Changes to existing code are small: a Live button in the top bar, and the finished clip handed to the normal video path in app.js. The renderer does not change.

## Live screen

The live screen is one full-screen portrait view with a few controls. Everything else stays in the normal editor.

- **Top left:** Close. Returns to the normal editor and keeps nothing.
- **Top centre:** The preset label, for example Atkinson with PICO-8.
- **Top right:** Switches between the rear and front camera.
- **Middle:** The dithered preview at 480p, with the frame rate shown.
- **Bottom centre:** The record button. Press and hold; a ring fills over 10 seconds.
- **Bottom right:** The clip library, with the last clip's thumbnail.

The preset is the current dither method and palette. Change it in the normal editor. A small preset picker on the live screen is one of the open choices in the risks section.

## Storage

Clips should go into IndexedDB, not localStorage. localStorage holds text only and is too small for a video.

| Storage | Holds a video file | Size limit | Risk |
| --- | --- | --- | --- |
| localStorage | No, text only | Roughly 5 MB in most browsers (not tested here) | Too small for one 10-second clip |
| IndexedDB | Yes, as a file (Blob) | Set by the browser; not tested on iOS here | Safari may delete data for a site not used for 7 days ([itnews](https://www.itnews.com.au/news/apple-cops-flak-for-deleting-local-browser-storage-after-7-days-539833)) |

- **Size per clip:** about 10 to 20 MB for 10 seconds at 1080p. This is an estimate from typical recording rates, not a measurement.
- **Library actions:** play, open in the normal editor, delete.
- **Limit:** a storage figure in the library, and a warning before a save is refused.
- **Backup:** a download button saves a clip to Files, so no clip depends only on the browser's storage.
- **Privacy:** clips never leave the phone. Deleting a clip removes it from storage.

## Phases

```
Phone check ──► [gate: 1080p, MP4 and storage work] ──► Live preview ──► [gate: preview holds about 15 fps]
  ──► Record ──► [gate: clip saves and reopens] ──► Clip editing ──► [gate: clip is 1080p like any video] ──► More live
```

- **Phone check:** camera at 1080p, MP4 and storage.
- **Live preview:** dithered at 480p, front and rear.
- **Record:** hold up to 10 seconds, save to the library.
- **Clip editing:** 1080p output, all settings.
- **More live:** more methods, speed control.

The gates are the checks from the test plan below. A phase that fails its gate is fixed before the next phase starts.

The first gate, the phone check, comes first on purpose. If 1080p, MP4 or storage fails on your phone, the plan changes before any screen is built.

## Risks and decisions

Five choices need an answer before the build starts. Each risk below has a fallback.

1. **HDR.** A) The live screen as described: standard range, 8-bit, fully custom. B) The iPhone camera app through a file picker: real HDR and the native controls, but no live preview and no hold-to-record. Recommendation: A, because the artwork is 8-bit anyway. Choose B only if HDR must stay in the file.
2. **Portrait 1080p.** Phone video is portrait. The current output rule fits a landscape 1920×1080 box, so a portrait clip comes out at about 608×1080. A) Treat 1080p as the short side: 1080×1920 for portrait. B) Keep the current rule. Recommendation: A.
3. **Audio.** A) Video only, with no microphone prompt. B) Video with sound, which the artwork does not use. Recommendation: A for the first version.
4. **Storage.** A) IndexedDB only. B) IndexedDB plus a download to Files, which survives Safari's 7-day cleanup. Recommendation: B.
5. **Preset on the live screen.** A) Change the preset only in the normal editor. B) A small preset picker on the live screen. Recommendation: A for the first version.

Risks:

- Preview and recording together may drop preview frames on older phones. Fallback: a lower preview resolution, or the preview paused while recording.
- iOS stops the camera when Safari goes to the background. Fallback: a recording stopped this way is still saved, and the screen says so.
- The rear camera may not deliver 1080p in web capture. Fallback: 720p capture, with the output still at 1080p.
- Dither at 480p may be too slow on some phones. Fallback: a frame-time readout, and a lower preview resolution.

## Test plan on your iPhone

Nothing here has been run yet. Work through these in Safari on an iPhone, over HTTPS (the GitHub Pages address). Note the phone model with each result.

- [ ] Tap Live and allow the camera. The preview should show a dithered picture.
- [ ] Read the frame rate on the live screen. Note it.
- [ ] Hold record for 3 seconds, then let go. The clip should appear in the library.
- [ ] Hold record for 15 seconds. Recording should stop at 10 seconds.
- [ ] Open the clip. Its output should be 1080p, and a different algorithm and palette should change it.
- [ ] Export a PNG and an MP4 from the clip.
- [ ] Switch to the front camera and back again.
- [ ] Deny the camera permission. The screen should explain how to allow it.
- [ ] Close Safari and reopen the site. The clip should still be in the library.
- [ ] Check the clip again after a week without using the site.

## Sources

These came from search results. The pages were not opened, so check each one before relying on it.

- [Web features: media capture](https://web-platform-dx.github.io/web-features-explorer/features/media-capture)
- [WWDC24 session 10088: capturing HDR with ScreenCaptureKit](https://developer.apple.com/la/videos/play/wwdc2024/10088/)
- [David Walsh: HTML5 camera and video on iPhone](https://davidwalsh.name/html5-camera-video-iphone)
- [Addpipe: correct syntax for HTML media capture](https://blog.addpipe.com/correct-syntax-html-media-capture)
- [itnews: Apple and the 7-day deletion of local browser storage](https://www.itnews.com.au/news/apple-cops-flak-for-deleting-local-browser-storage-after-7-days-539833)
- [Didomi: Apple's 7-day cap on script-writable storage](https://docs.didomi.io/releases-and-announcements/announcements/apple-implements-7-day-cap-on-script-writable-storage)
