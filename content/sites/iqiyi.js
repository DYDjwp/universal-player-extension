(() => {
  "use strict";

  const api = globalThis.VideoPlayerReplacer;

  if (!api) {
    throw new Error("VideoPlayerReplacer 核心未加载");
  }

  const ADAPTER_ID = "iqiyi";

  if (api.hasAdapter(ADAPTER_ID)) {
    return;
  }

  function matchesIqiyiUrl() {
    try {
      const url = new URL(location.href);

      /*
       * 查询参数不参与判断，因此以下形式都受支持：
       *
       * https://www.iqiyi.com/v_1w7an6undxg.html
       * https://www.iqiyi.com/v_1w7an6undxg.html?a=image&qyTrace=...
       */
      return (
        url.protocol === "https:" &&
        url.hostname === "www.iqiyi.com" &&
        /^\/v_[A-Za-z0-9]+\.html$/.test(url.pathname)
      );
    } catch {
      return false;
    }
  }

  function findIqiyiStructure() {
    /*
     * 爱奇艺当前播放页结构：
     *
     * #container1MainContent
     * └─ #areaContainer
     *    └─ #areaLeftContainer
     *       └─ ...
     *          └─ [data-player-hook="container"]
     *             └─ video.inner-video
     *
     * 覆盖 #areaLeftContainer 可以保留右侧 #areaRight 的 TVG、选集等区域。
     */
    const leftArea = document.querySelector("#areaLeftContainer");

    if (leftArea instanceof HTMLElement) {
      const nativePlayer = leftArea.querySelector(
        [
          '[data-player-hook="container"]',
          'video.inner-video',
          '#mainContent',
          '#videoContent',
          '[class*="XPlayer_root"]'
        ].join(", ")
      );

      if (nativePlayer) {
        return {
          target: leftArea,
          sizeHost: leftArea,
          nativePlayer
        };
      }
    }

    /*
     * 页面结构调整时的降级路径：直接寻找播放器 hook，
     * 优先使用它所在的左侧播放区域作为覆盖目标。
     */
    const playerContainer = document.querySelector(
      '[data-player-hook="container"]'
    );

    if (playerContainer instanceof HTMLElement) {
      const fallbackTarget =
        playerContainer.closest("#areaLeftContainer") ||
        playerContainer;

      return {
        target: fallbackTarget,
        sizeHost: fallbackTarget,
        nativePlayer: playerContainer
      };
    }

    return null;
  }

  function waitForIqiyiStructure(timeoutMs = 15000) {
    const immediate = findIqiyiStructure();

    if (immediate) {
      return Promise.resolve(immediate);
    }

    return new Promise(resolve => {
      let finished = false;

      const finish = result => {
        if (finished) {
          return;
        }

        finished = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve(result);
      };

      const observer = new MutationObserver(() => {
        const structure = findIqiyiStructure();

        if (structure) {
          finish(structure);
        }
      });

      observer.observe(document.documentElement, {
        childList: true,
        subtree: true
      });

      const timer = setTimeout(() => {
        finish(null);
      }, timeoutMs);
    });
  }

  api.register({
    id: ADAPTER_ID,
    name: "爱奇艺",

    async detect() {
      if (!matchesIqiyiUrl()) {
        return {
          supported: false,
          code: "UNSUPPORTED_URL",
          message:
            "仅支持 https://www.iqiyi.com/v_<视频ID>.html 格式的爱奇艺播放页"
        };
      }

      const structure = await waitForIqiyiStructure();

      if (!structure) {
        return {
          supported: false,
          code: "UNSUPPORTED_STRUCTURE",
          message:
            "URL 符合爱奇艺播放页格式，但没有找到 #areaLeftContainer 内的播放器节点"
        };
      }

      return {
        supported: true,
        message: "已找到爱奇艺左侧播放器区域",
        context: {
          target: structure.target,
          sizeHost: structure.sizeHost,
          sourceUrl: location.href,

          /*
           * 爱奇艺会周期性重建播放器 DOM。覆盖层挂到 body，
           * 再用此解析器持续追踪新的 #areaLeftContainer，避免 iframe
           * 被 React/播放器状态刷新一起删除。
           */
          mountStrategy: "viewport-overlay",
          resolveStructure: findIqiyiStructure
        }
      };
    }
  });
})();
