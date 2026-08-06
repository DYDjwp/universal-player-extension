<div align="center">

# Universal Player

**Universal Player — a custom player extension for multiple online video platforms (Please check the Firefox branch for the Firefox version.)**

[![Version](https://img.shields.io/badge/version-1.0.0-2ea44f.svg)](#)
[![Manifest](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4.svg)](#)
[![License](https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg)](LICENSE)

**English** | [中文](README.zh.md)

Replaces the native player on supported sites with a unified custom playback UI, integrating danmaku, watch history, playback speed, picture-in-picture, fullscreen controls, and HLS segment detection with streaming unpacking.

</div>

> [!IMPORTANT]
> This project is an unofficial third-party browser extension. It is not affiliated with, authorized by, or in partnership with Tencent Video, iQIYI, Mango TV, Youku, Bilibili, or any related API service providers.
>
> This project does not provide, store, or host any video content, and does not guarantee playback of membership, paid, DRM, geo-restricted, or otherwise access-controlled content. Use it only with lawful authorization, and comply with local laws, site terms of service, and content copyright requirements.

## Features

### Multi-platform player replacement

The current version can detect and replace playback pages on:


| Platform      | Supported scope                 | URL example or pattern                                             |
| ------------- | ------------------------------- | ------------------------------------------------------------------ |
| Tencent Video | Standard episode playback pages | `https://v.qq.com/x/cover/<cover-id>/<video-id>.html`              |
| iQIYI         | Standard video playback pages   | `https://www.iqiyi.com/v_<video-id>.html`                          |
| Mango TV      | Program playback pages          | `https://www.mgtv.com/b/<program-id>/<video-id>.html`              |
| Youku         | Standard video playback pages   | `https://v.youku.com/v_show/id_<video-id>.html`                    |
| Bilibili      | Anime season and episode pages  | `https://www.bilibili.com/bangumi/play/ss<number>` or `ep<number>` |

The extension selects the matching site adapter from the current URL, then mounts the shared `player/index.html` player into the original player area. On sites that frequently rebuild player DOM, it uses a dedicated overlay and continuously tracks player size and position.

### Custom playback controls

* Play and pause.
* Seek backward 10 seconds and forward 10 seconds.
* Current time, duration, and a draggable progress bar.
* Mute and volume control.
* Picture-in-picture.
* Fullscreen playback.
* Auto-hide controls in fullscreen; show again on mouse move, click, or pause.
* Collapse secondary controls on small player sizes to reduce clutter.
* Automatically save the last used playback rate.

Supported rates:

`0.5×`, `0.75×`, `1.0×`, `1.25×`, `1.5×`, `1.75×`, `2.0×`, `3.0×`

### Danmaku system

The player tries to load two kinds of danmaku:

1. Platform danmaku fetched from the current video page URL.
2. Independent public danmaku library content fetched by danmaku ID.

Main capabilities:

* Scrolling, top-fixed, and bottom-fixed danmaku.
* Pause danmaku animation when the video is paused, buffering, or the page is hidden.
* Resync to the current video time after playback resumes.
* Clear old danmaku and requeue from the new time after seeking.
* Sync danmaku animation speed when playback rate changes.
* Toggle platform danmaku and independent danmaku separately.
* Adjust opacity, font size, move speed, display area, and on-screen limit.
* Customize color and font size when sending independent danmaku.
* Danmaku request failures do not block video playback.
* Danmaku settings are stored in `chrome.storage.local`.

### Watch history and resume

* Save records by normalized video URL.
* Store progress, duration, completion percentage, title, episode, cover, and platform info.
* Create a valid history record after more than 2 seconds of playback.
* Show the last watched position when reopening the same video.
* Click the prompt to jump to the last playback time.
* Mark as completed when playback ends.
* Group episodes by title on a dedicated history page.
* Click a history item to return to the original video page.
* Delete a single record or clear all history.
* Export all watch history records as a JSON backup file.
* Import a compatible JSON backup file to restore watch history records.
* Monitor local extension storage usage and warn near capacity limits.

### HLS detection and streaming unpack

The player analyzes media URLs returned by resolve APIs and chooses a playback mode by content type:

* Normal media URLs: played by the browser native media element.
* Standard HLS: handled by the browser; compatibility depends on the browser and media format.
* PNG-wrapped HLS: detects MPEG-TS media appended after PNG data, then downloads, unpacks, and plays via Media Source Extensions.

The streaming unpack module includes:

* Playlist parsing and high-bandwidth variant selection.
* Segment content preflight checks.
* PNG, MPEG-TS, and fMP4 signature detection.
* Up to 4 attempts per request round.
* Background concurrent prefetch and buffer control.
* Prefetch after seeks.
* Multi-round recovery for failed segments.
* CDN redirect URL learning and caching.
* Refresh of expired direct URLs.
* Retry handling for 502, 503, 504, 429, and similar responses.
* Queue rebuild and recovery after playback position changes.

Known limits of the current PNG unpack mode:

* Only supports append playback of MPEG-TS segments.
* Does not yet support PNG-wrapped fMP4 segments.
* Does not yet support encrypted HLS.
* Does not yet support `EXT-X-MAP`.
* Does not yet support `EXT-X-BYTERANGE`.
* Depends on browser support for MediaSource MPEG-TS MIME types.

### Settings and UI

The settings page currently provides:

* Auto-replace player.
* Auto remount when switching videos or episodes in the same tab.
* Enable or disable watch history.
* Chinese / English UI language switch.
* Pure black / pure white theme switch.
* View local storage usage.
* Open the watch history page.
* Reset all extension data.

## Installation

This project currently needs no npm, build tools, or extra install steps. The HTML, CSS, JavaScript, and third-party browser files required at runtime are already included in the extension directory.

### Install from source

1. Download and extract this repository.
2. Open Chrome, Edge, or another Chromium-based browser.
3. Go to:

   * Chrome: `chrome://extensions/`
   * Edge: `edge://extensions/`
4. Enable **Developer mode** in the top-right corner.
5. Click **Load unpacked**.
6. Select the project root that contains `manifest.json`.
7. Pin **Universal Player** to the toolbar for easy access.

> [!NOTE]
> Do not select a zip archive, and do not select a subdirectory outside the project root. The chosen directory must contain `manifest.json` directly.

### Update

1. Overwrite the old project directory with the new files, or download and extract again.
2. Open the extensions management page.
3. Click the reload button on the Universal Player card.
4. Refresh any already open video pages.

Before updating, keep a copy of the old directory so you do not accidentally lose watch history that has not been exported. Extension updates usually do not delete `chrome.storage.local` data, but removing the extension itself may cause local data loss.

## Usage

### Manual replace

1. Open a supported video playback page.
2. Click the Universal Player icon in the browser toolbar.
3. Wait for the extension to detect the current site and page structure.
4. Click **Start replace**.
5. Click the action button again to restore the site’s original player.

### Auto replace

1. Open the extension popup.
2. Click **Open settings**.
3. Enable **Auto-replace player**.
4. To remount automatically after switching episodes, also enable **Auto-switch videos**.

### View watch history

1. Open the settings page.
2. Click **View watch history**.
3. Click any record to return to the corresponding video page.
4. Use the delete button on a record to remove one item, or use the top button to clear all history.
5. Click **Export history** to download all records as a JSON backup file.
6. Click **Import history** and select a compatible JSON backup file to restore records.

## How it works

```text
Current tab URL
       │
       ▼
shared/site-registry.js
Match site and adapter by URL
       │
       ▼
initial.js + content/core.js
Inject site adapter and detect player DOM
       │
       ▼
content/sites/<site>.js
Return mount target, size host, and mount strategy
       │
       ▼
player/index.html iframe
Load the shared player UI
       │
       ├── player/player.js
       │   Resolve media URL, control playback, save history
       │
       ├── player/hls-decoder.js
       │   Analyze HLS, prefetch segments, stream-unpack
       │
       └── player/danmaku.js
           Load, render, and send danmaku
```

The background service worker is responsible for:

* Registering Declarative Net Request dynamic rules.
* Tracking replaced tab state.
* Listening for tab update, activation, and close events.
* Running auto-replace or auto-remount according to settings.
* Centralized watch history read/write.
* Measuring local storage usage.

## Permissions


| Permission                      | Purpose                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| `activeTab`                     | Access the current tab in response to user actions in the extension popup.                   |
| `scripting`                     | Inject core logic and site adapters into matching playback pages.                            |
| `declarativeNetRequest`         | Modify request headers required by specific resolve APIs and HLS requests.                   |
| `declarativeNetRequestFeedback` | Observe dynamic network rule matches during development. Consider removing for production.   |
| `storage`                       | Save settings, theme, language, playback rate, danmaku settings, replace state, and history. |
| `tabs`                          | Query the current tab, listen for navigation, and open settings/history pages.               |
| `https://*/*`                   | Detect supported video pages and request resolve, danmaku, metadata, and media resources.    |

`https://*/*` is a broad host permission. Although current site routing only starts player replacement on explicitly supported URLs, review the source and confirm you accept these permissions before installing.

## Data and privacy

### Data stored locally

The following data may be stored in the browser’s `chrome.storage.local`:

* Auto-replace setting.
* Auto-switch setting.
* Whether watch history is enabled.
* Chinese or English language setting.
* Black or white theme setting.
* Last used playback rate.
* Danmaku display settings.
* Replaced tab state.
* Video URL, title, episode, cover, progress, duration, and completion ratio.

### External requests

To support media resolve, danmaku, and history metadata features, the extension sends requests to third-party services, including but not limited to:


| Service                | Data sent or requested                                                     | Purpose                                                                                  |
| ---------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `data.video.iqiyi.com` | Time request                                                               | Obtain the time value needed to build resolve requests.                                  |
| `cache.0567890.xyz`    | Encoded current video page URL and signature parameters                    | Obtain media URLs and video info.                                                        |
| `dmku.hls.one`         | Normalized video URL, danmaku ID, danmaku text, time, color, and font size | Fetch platform/independent danmaku, title or episode info, and send independent danmaku. |

Some requests set `credentials: "omit"` and do not intentionally send third-party cookies, but service providers may still log IP addresses, request times, User-Agent, or other ordinary server logs according to their own policies.

The current source does not integrate a standalone analytics SDK, but that does not mean external APIs will not log requests. Read the privacy policies and terms of those services before use.

## Add a new site adapter

### 1. Create the adapter file

Copy `content/sites/_template.js`, for example:

```text
content/sites/example.js
```

An adapter needs at least:

* A unique `id`.
* A display name for the site.
* URL matching logic.
* Player DOM lookup logic.
* A `detect()` method.
* Mount target `target`.
* Size reference element `sizeHost`.
* Original page URL `sourceUrl`.

Simplified example:

```js
(() => {
  "use strict";

  const api = globalThis.VideoPlayerReplacer;
  const ADAPTER_ID = "example";

  if (!api || api.hasAdapter(ADAPTER_ID)) return;

  api.register({
    id: ADAPTER_ID,
    name: "Example Video",

    async detect() {
      const target = document.querySelector(".video-player");

      if (!(target instanceof HTMLElement)) {
        return {
          supported: false,
          code: "UNSUPPORTED_STRUCTURE",
          message: "Player container not found"
        };
      }

      return {
        supported: true,
        message: "Player container found",
        context: {
          target,
          sizeHost: target,
          sourceUrl: location.href
        }
      };
    }
  });
})();
```

### 2. Register the site route

Add an entry in `shared/site-registry.js`:

```js
Object.freeze({
  id: "example",
  name: "Example Video",
  adapterScript: "content/sites/example.js",

  getPageKey(urlString) {
    const url = new URL(urlString);
    return `${url.origin}${url.pathname}`;
  },

  matches(urlString) {
    const url = new URL(urlString);
    return url.hostname === "video.example.com";
  }
})
```

### 3. Test

Focus on:

* Whether the page is recognized on first open.
* Whether delayed player DOM loads are waited for correctly.
* Whether the original player is actually paused and hidden.
* Whether the overlay stays aligned after scroll and window resize.
* Whether remount works after episode switches or SPA route changes.
* Whether page structure and styles are normal after restoring the original player.
* Whether fullscreen, picture-in-picture, history saving, and danmaku work.

## Debugging

### Extension background logs

1. Open `chrome://extensions/`.
2. Find **Universal Player**.
3. Open the service worker **Inspect views**.
4. Check logs for network rule registration, auto-replace, and history storage.

### Page adapter logs

1. Press `F12` on the target video page.
2. Open Console.
3. Search for `Universal Player`, `VideoPlayerReplacer`, or site adapter messages.

### Player iframe logs

The player runs inside an extension iframe. In DevTools, switch the JavaScript context to `player/index.html`, then inspect:

* Media resolve results.
* HLS detection mode.
* Segment requests and retries.
* MediaSource state.
* Danmaku load and send status.
* Watch history save errors.

After player initialization, a read-only debug object is also exposed:

```js
UniversalPlayer
UniversalPlayer.getLogs()
UniversalPlayer.playbackState
UniversalPlayer.playbackState.prepared?.getStats?.()
```

## FAQ

### Current page is not supported

Possible causes:

* The current URL does not match a supported rule.
* The site changed its player DOM structure.
* The page is still loading and the player container is not ready yet.
* The current page is not a formal playback page.

Refresh and retry. When filing an issue, include the full URL, browser version, and console errors.

### Media Chrome is not loaded

Confirm this file exists:

```text
player/libs/media-chrome.js
```

The source package already includes it; no separate install script is required. If the file is missing, re-download the full repository instead of copying only some files.

### API returns 403

This usually means the third-party resolve service rejected the request, network, or IP. The extension itself cannot guarantee external service availability. Retry later, switch networks, or contact the corresponding API provider.

### API returns 502, 503, or 504

The player automatically retries a limited number of times. Persistent failures usually mean the resolve service, CDN, or target segment is temporarily unavailable. Try:

* Waiting, then refreshing the page.
* Restoring the original player and replacing again.
* Checking failed URLs in the browser Network panel.
* Confirming it is not a single HLS segment that stays broken.

### Audio plays but there is no video, or MediaError 4 appears

Possible causes:

* The browser does not support the codec.
* MediaSource does not support the current MPEG-TS MIME type.
* The segment is actually fMP4, encrypted HLS, or another unsupported format.
* No valid media data was found inside the PNG wrapper.

When filing an issue, include `UniversalPlayer.playbackState` and unpack stats, but do not publicly share full private URLs that contain personal tokens, cookies, or authorization parameters.

### Cannot autoplay

The browser may block unmuted autoplay due to autoplay policy. Click play manually. The extension does not attempt to bypass browser user-gesture restrictions.

### Watch history is not saved

Check:

* Whether **Keep watch history** is enabled in settings.
* Whether the video actually played for more than 2 seconds.
* Whether local extension storage is near its limit.
* Whether the service worker shows communication errors.
* Whether the extension was deleted or reinstalled.

## Known limitations

* Site DOM changes may break adapters.
* Playback depends on third-party resolve APIs, danmaku APIs, and CDNs.
* Not all video pages, live pages, short-video pages, or user-upload pages are supported.
* Standard HLS is not guaranteed to play natively in every Chromium browser.
* PNG unpack currently targets MPEG-TS segments primarily.
* DRM decryption is not handled, and this project must not be used to bypass paid access controls.
* External API domains, parameters, or signature algorithms may change and require code updates.
* A broad HTTPS host permission is currently used.
* There is currently no automated test suite or CI pipeline.

## Contributing

Issues and pull requests are welcome.

### Before filing an issue

Please provide as much of the following as possible:

* Browser name and full version.
* Extension version.
* Operating system.
* Platform and page type where the issue occurred.
* Publicly shareable reproduction steps.
* Console errors.
* Service worker errors.
* Related Network request status codes.
* Whether the issue is reproducible consistently.

Please remove or redact:

* Cookies.
* Login tokens.
* Personal account information.
* Signed private media URLs.
* Any authorization parameters that can access protected content.

### Submitting a pull request

1. Fork this repository.
2. Create a feature branch from the latest main branch.
3. Keep the coding style consistent with the existing project.
4. Change only files related to the current feature.
5. Test all affected platforms.
6. In the pull request, describe motivation, implementation, and test results.

Suggested branch names:

```text
feature/add-example-adapter
fix/hls-segment-retry
refactor/history-storage
```

Suggested commit messages:

```text
feat: add example video adapter
fix: recover from expired HLS redirect
docs: update installation guide
```

## Third-party components

This project includes or uses the following third-party open-source components:

* [Media Chrome](https://github.com/muxinc/media-chrome), currently pinned to `4.19.2`, MIT License.
* [CryptoJS](https://github.com/brix/crypto-js), MIT License.

Third-party components remain under their original licenses. See `THIRD_PARTY_NOTICES.md` and each upstream project’s own license files for details.

## Disclaimer

This software is provided “as is”, without any express or implied warranty. Project maintainers are not responsible for:

* External APIs going offline, rate-limiting, blocking, or changing behavior.
* Site updates that break the extension.
* Playback failures, data loss, or corrupted watch history.
* Account restrictions, terms-of-service disputes, or legal risks arising from use of this project.
* Users accessing, distributing, or using unauthorized content through this project.
* Accuracy, legality, or safety of third-party APIs, media resources, or danmaku content.

Users must judge whether their use is lawful and accept the corresponding responsibility.

## License

This project is intended to use **GNU General Public License v3.0 or later**:

```text
GPL-3.0-or-later
```

You may freely use, study, modify, and redistribute this project; when you distribute this project or a modified version to others, you must provide the corresponding source code under GPL requirements and continue under a compatible license.

See [LICENSE](LICENSE) for the full terms.
