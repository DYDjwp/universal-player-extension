(() => {
  "use strict";

  const api = globalThis.VideoPlayerReplacer;

  if (!api) {
    throw new Error("VideoPlayerReplacer 核心未加载");
  }

  const ADAPTER_ID = "tencent";

  if (api.hasAdapter(ADAPTER_ID)) {
    return;
  }

  function matchesTencentUrl() {
    try {
      const url = new URL(location.href);

      return (
        url.protocol === "https:" &&
        url.hostname === "v.qq.com" &&
        /^\/x\/cover\/[^/]+\/[^/]+\.html$/.test(url.pathname)
      );
    } catch {
      return false;
    }
  }

  function findTencentStructure() {
    const container = document.querySelector(".container-player");
    const wrapper = container?.querySelector(".main-player-wrapper");
    const mainPlayer = wrapper?.querySelector("#main-player");
    const playerComponent = mainPlayer?.querySelector("#player-component");

    if (
      !(container instanceof HTMLElement) ||
      !(wrapper instanceof HTMLElement) ||
      !(mainPlayer instanceof HTMLElement) ||
      !(playerComponent instanceof HTMLElement)
    ) {
      return null;
    }

    return {
      container,
      wrapper,
      mainPlayer,
      playerComponent
    };
  }

  function waitForTencentStructure(timeoutMs = 10000) {
    const immediate = findTencentStructure();

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
        const structure = findTencentStructure();

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
    name: "腾讯视频",

    async detect() {
      if (!matchesTencentUrl()) {
        return {
          supported: false,
          code: "UNSUPPORTED_URL",
          message:
            "仅支持 https://v.qq.com/x/cover/<id>/<id>.html 格式的腾讯视频页面"
        };
      }

      const structure = await waitForTencentStructure();

      if (!structure) {
        return {
          supported: false,
          code: "UNSUPPORTED_STRUCTURE",
          message:
            "URL 符合腾讯视频格式，但没有找到 .container-player > .main-player-wrapper > #main-player > #player-component"
        };
      }

      return {
        supported: true,
        message: "已找到腾讯视频播放器容器",
        context: {
          /*
           * 在 #player-component 上覆盖通用播放器，但保留原节点布局，
           * 避免腾讯内部手势 ResizeObserver 因节点脱离 DOM 而读到 0 宽度。
           */
          target: structure.playerComponent,
          sizeHost: structure.mainPlayer,
          sourceUrl: location.href
        }
      };
    }
  });
})();
