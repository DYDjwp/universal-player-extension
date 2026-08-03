(() => {
  "use strict";

  const api = globalThis.VideoPlayerReplacer;

  if (!api) {
    throw new Error("VideoPlayerReplacer 核心未加载");
  }

  const ADAPTER_ID = "bilibili";

  if (api.hasAdapter(ADAPTER_ID)) {
    return;
  }

  function matchesBilibiliUrl() {
    try {
      const url = new URL(location.href);

      /*
       * 支持番剧季度页和单集页：
       *
       * https://www.bilibili.com/bangumi/play/ss39433
       * https://www.bilibili.com/bangumi/play/ep123456
       *
       * 查询参数和 hash 不参与判断。
       */
      return (
        url.protocol === "https:" &&
        url.hostname === "www.bilibili.com" &&
        /^\/bangumi\/play\/(?:ss|ep)\d+\/?$/.test(url.pathname)
      );
    } catch {
      return false;
    }
  }

  function findBilibiliStructure() {
    /*
     * 目前番剧播放器的稳定外层结构：
     *
     * .plp-player
     * └─ #bilibili-player-wrap
     *    └─ .video_playerInner__...
     *       ├─ #bilibili-player
     *       └─ #big-block-panel
     *
     * 覆盖 #bilibili-player-wrap 可以同时盖住原生播放器、地区限制层、
     * VIP/付费提示、缓冲层和原生控制栏。
     */
    const playerWrap = document.querySelector("#bilibili-player-wrap");

    if (playerWrap instanceof HTMLElement) {
      const nativePlayer = playerWrap.querySelector(
        [
          "#bilibili-player",
          ".bpx-player-container",
          ".bpx-player-primary-area",
          "video",
          "#big-block-panel"
        ].join(", ")
      );

      if (nativePlayer) {
        return {
          target: playerWrap,
          sizeHost: playerWrap,
          nativePlayer
        };
      }
    }

    /*
     * 降级路径：某些版本可能暂时没有 #bilibili-player-wrap，
     * 但仍保留 #bilibili-player 或 .bpx-player-container。
     */
    const player = document.querySelector(
      "#bilibili-player, .bpx-player-container"
    );

    if (player instanceof HTMLElement) {
      const fallbackTarget =
        player.closest("#bilibili-player-wrap") ||
        player.closest(".plp-player") ||
        player;

      return {
        target: fallbackTarget,
        sizeHost: fallbackTarget,
        nativePlayer: player
      };
    }

    return null;
  }

  function waitForBilibiliStructure(timeoutMs = 15000) {
    const immediate = findBilibiliStructure();

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
        const structure = findBilibiliStructure();

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
    name: "哔哩哔哩番剧",

    async detect() {
      if (!matchesBilibiliUrl()) {
        return {
          supported: false,
          code: "UNSUPPORTED_URL",
          message:
            "仅支持 https://www.bilibili.com/bangumi/play/ss<数字> 或 ep<数字> 格式的番剧播放页"
        };
      }

      const structure = await waitForBilibiliStructure();

      if (!structure) {
        return {
          supported: false,
          code: "UNSUPPORTED_STRUCTURE",
          message:
            "URL 符合哔哩哔哩番剧格式，但没有找到 #bilibili-player-wrap 或 .bpx-player-container"
        };
      }

      return {
        supported: true,
        message: "已找到哔哩哔哩番剧播放器区域",
        context: {
          target: structure.target,
          sizeHost: structure.sizeHost,
          sourceUrl: location.href,

          /*
           * B 站播放器也会重建内部 DOM，使用页面顶层覆盖层，
           * 并持续跟踪新的 #bilibili-player-wrap。
           */
          mountStrategy: "viewport-overlay",
          resolveStructure: findBilibiliStructure
        }
      };
    }
  });
})();
