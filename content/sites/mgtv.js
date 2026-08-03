(() => {
  "use strict";

  const api = globalThis.VideoPlayerReplacer;

  if (!api) {
    throw new Error("VideoPlayerReplacer 核心未加载");
  }

  const ADAPTER_ID = "mgtv";

  if (api.hasAdapter(ADAPTER_ID)) {
    return;
  }

  function matchesMgtvUrl() {
    try {
      const url = new URL(location.href);

      /*
       * 芒果 TV 正常播放页：
       * https://www.mgtv.com/b/<节目ID>/<视频ID>.html
       *
       * fpa、fpos、lastp、cpid 等查询参数不参与判断。
       */
      return (
        url.protocol === "https:" &&
        (url.hostname === "www.mgtv.com" || url.hostname === "mgtv.com") &&
        /^\/b\/\d+\/\d+\.html$/.test(url.pathname)
      );
    } catch {
      return false;
    }
  }

  function findMgtvStructure() {
    /*
     * 当前稳定结构：
     *
     * .mgtv-player-container
     * ├─ .m-player-poster
     * ├─ #mgtv-player-wrap
     * │  └─ .mango-player
     * │     ├─ mango-control-bar
     * │     ├─ mango-vip-dialog
     * │     └─ mango-error-layer
     * └─ #player-outer
     *
     * 覆盖最外层可以同时遮住原生播放器、地区限制提示、广告层、
     * VIP 层、弹幕和原生控制区域。
     */
    const container = document.querySelector(".mgtv-player-container");

    if (container instanceof HTMLElement) {
      const nativePlayer = container.querySelector(
        [
          "#mgtv-player-wrap",
          ".mango-player",
          "mango-kernel-layer",
          "mango-error-layer",
          "mango-control-bar"
        ].join(", ")
      );

      if (nativePlayer) {
        return {
          target: container,
          sizeHost: container,
          nativePlayer
        };
      }
    }

    /*
     * 降级路径：页面初始化期间最外层可能尚未出现，先寻找播放器包装层。
     */
    const playerWrap = document.querySelector(
      "#mgtv-player-wrap, .mango-player"
    );

    if (playerWrap instanceof HTMLElement) {
      const fallbackTarget =
        playerWrap.closest(".mgtv-player-container") ||
        playerWrap.closest("#mgtv-player-wrap") ||
        playerWrap;

      return {
        target: fallbackTarget,
        sizeHost: fallbackTarget,
        nativePlayer: playerWrap
      };
    }

    return null;
  }

  function waitForMgtvStructure(timeoutMs = 15000) {
    const immediate = findMgtvStructure();

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
        const structure = findMgtvStructure();

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
    name: "芒果 TV",

    async detect() {
      if (!matchesMgtvUrl()) {
        return {
          supported: false,
          code: "UNSUPPORTED_URL",
          message:
            "仅支持 https://www.mgtv.com/b/<节目ID>/<视频ID>.html 格式的芒果 TV 播放页"
        };
      }

      const structure = await waitForMgtvStructure();

      if (!structure) {
        return {
          supported: false,
          code: "UNSUPPORTED_STRUCTURE",
          message:
            "URL 符合芒果 TV 播放页格式，但没有找到 .mgtv-player-container 或 #mgtv-player-wrap"
        };
      }

      return {
        supported: true,
        message: "已找到芒果 TV 播放器区域",
        context: {
          target: structure.target,
          sizeHost: structure.sizeHost,
          sourceUrl: location.href,

          /*
           * 芒果播放器会动态重建错误层、VIP 层、广告层和内核节点，
           * 使用页面顶层独立覆盖层，避免注入节点被网站移除。
           */
          mountStrategy: "viewport-overlay",
          resolveStructure: findMgtvStructure
        }
      };
    }
  });
})();
