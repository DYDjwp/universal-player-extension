Firefox standard-HLS support requires a local hls.js distribution file.

Required destination:
  player/libs/hls.min.js

Recommended setup:
  Run tools/download-hls.cmd from the project root.

Manual download source:
  hls.js 1.6.16 full minified distribution
  https://cdn.jsdelivr.net/npm/hls.js@1.6.16/dist/hls.min.js

Do not load hls.js remotely from player/index.html. Firefox extension pages should
execute the bundled local file so that extension CSP and AMO review requirements
are respected.
