// Standalone HTML export: the artwork script and its embedded media data inlined
// into one page that runs from file:// with no network access.

import { createStandaloneScript, downloadBlob } from './javascript-exporter.js';

export async function exportStandaloneHtml(data, params, filename, maxWidth) {
  const title = 'JS Rusty artwork';
  const script = await createStandaloneScript(data, params, { title: title, maxWidth: maxWidth });
  // Prevent the inlined code from closing the script tag early.
  const safeScript = script.replace(/<\/script/gi, '<\\/script');
  const html = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    '<title>' + title + '</title>',
    '<style>',
    '  html, body { margin: 0; height: 100%; background: #1c1b19; }',
    '  body { display: grid; place-items: center; overflow: hidden; }',
    '  canvas { max-width: 100vw; max-height: 100vh; width: auto; height: auto; cursor: pointer; }',
    '  .hint { position: fixed; bottom: 10px; left: 0; right: 0; text-align: center; color: #6f6a5f; font: 12px -apple-system, Segoe UI, sans-serif; pointer-events: none; }',
    '</style>',
    '</head>',
    '<body>',
    '<canvas id="artwork"></canvas>',
    '<div class="hint">Click to play / pause</div>',
    '<script>',
    safeScript,
    '</script>',
    '<script>',
    "  RasterArt.mount(document.getElementById('artwork'), { autoplay: true, loop: true });",
    '</script>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
  downloadBlob(filename, new Blob([html], { type: 'text/html' }));
  return html.length;
}
