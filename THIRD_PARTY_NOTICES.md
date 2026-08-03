# Third-party notices

This project includes third-party open-source software. Each component remains subject to its original license terms.

## Media Chrome

Media Chrome is developed by Mux, Inc. and contributors.

- Project: https://github.com/muxinc/media-chrome
- Bundled version: 4.19.2
- License: MIT License

Copyright (c) 2020 Mux, Inc.

The bundled browser-ready build is located at `player/libs/media-chrome.js`.

## CryptoJS

CryptoJS is developed by Evan Vosberg and contributors.

- Project: https://github.com/brix/crypto-js
- License: MIT License

The bundled browser build is located at `player/libs/crypto-js.js`.

## hls.js

hls.js is developed by the video-dev community and contributors.

- Project: https://github.com/video-dev/hls.js
- Expected version: 1.6.16
- License: Apache License 2.0

The Firefox player expects the browser-ready build at `player/libs/hls.min.js`.
The helper script `tools/download-hls.cmd` downloads that official distribution
locally; remote code is not executed by the extension.

## Project license

Except for third-party components and any content explicitly identified as being under another license, the Universal Player project is licensed under the GNU General Public License version 3 or, at your option, any later version (`GPL-3.0-or-later`).

See `LICENSE` for the complete project license text.
