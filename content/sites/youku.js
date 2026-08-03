(() => {
  "use strict";

  const api = globalThis.VideoPlayerReplacer;

  if (!api) {
    throw new Error("VideoPlayerReplacer 核心未加载");
  }

  const ADAPTER_ID = "youku";

  if (api.hasAdapter(ADAPTER_ID)) {
    return;
  }

  function matchesYoukuUrl() {
    try {
      const url = new URL(location.href);

      /*
       * 优酷正常播放页：
       * https://v.youku.com/v_show/id_XNjUxNjk2MTUwNA==.html
       *
       * spm、s、scm、alginfo、scg_id 等查询参数不参与判断。
       * 视频 ID 通常为 Base64 风格字符串，末尾可能带一个或两个 =。
       */
      return (
        url.protocol === "https:" &&
        url.hostname === "v.youku.com" &&
        /^\/v_show\/id_[A-Za-z0-9_-]+={0,2}\.html$/.test(url.pathname)
      );
    } catch {
      return false;
    }
  }

  function findYoukuStructure() {
    /*
     * 当前稳定结构：
     *
     * .player-container
     * ├─ #video_unfold
     * └─ #ykPlayer.youku-player
     *    ├─ .video-layer
     *    ├─ .advertise-layer
     *    ├─ .youku-advertise-layer
     *    └─ dashboard#youku-dashboard
     *
     * 以 .player-container 作为隐藏目标、#ykPlayer 作为尺寸基准，
     * 可以同时遮盖原生视频、广告、VIP 层、弹幕与控制栏。
     */
    const player = document.querySelector("#ykPlayer");

    if (player instanceof HTMLElement) {
      const nativePlayer = player.querySelector(
        [
          ".video-layer",
          "video",
          ".advertise-layer",
          ".youku-advertise-layer",
          "#youku-dashboard",
          "dashboard"
        ].join(", ")
      );

      if (nativePlayer) {
        const outer =
          player.closest(".player-container") ||
          player;

        return {
          target: outer,
          sizeHost: player,
          nativePlayer
        };
      }
    }

    /*
     * 降级路径：播放器初始化阶段可能先出现 video-layer 或 dashboard，
     * 再补上 #ykPlayer。此时向上寻找最近的播放器包装层。
     */
    const fallbackPlayer = document.querySelector(
      ".youku-player, .video-layer, #youku-dashboard, dashboard.kui-dashboard-0"
    );

    if (fallbackPlayer instanceof HTMLElement) {
      const fallbackTarget =
        fallbackPlayer.closest(".player-container") ||
        fallbackPlayer.closest("#ykPlayer") ||
        fallbackPlayer;
      const fallbackSizeHost =
        fallbackTarget.querySelector?.("#ykPlayer") ||
        fallbackPlayer.closest("#ykPlayer") ||
        fallbackTarget;

      return {
        target: fallbackTarget,
        sizeHost: fallbackSizeHost,
        nativePlayer: fallbackPlayer
      };
    }

    return null;
  }

  function waitForYoukuStructure(timeoutMs = 15000) {
    const immediate = findYoukuStructure();

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
        const structure = findYoukuStructure();

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
    name: "优酷",

    async detect() {
      if (!matchesYoukuUrl()) {
        return {
          supported: false,
          code: "UNSUPPORTED_URL",
          message:
            "仅支持 https://v.youku.com/v_show/id_<视频ID>.html 格式的优酷播放页"
        };
      }

      const structure = await waitForYoukuStructure();

      if (!structure) {
        return {
          supported: false,
          code: "UNSUPPORTED_STRUCTURE",
          message:
            "URL 符合优酷播放页格式，但没有找到 .player-container 或 #ykPlayer"
        };
      }

      return {
        supported: true,
        message: "已找到优酷播放器区域",
        context: {
          target: structure.target,
          sizeHost: structure.sizeHost,
          sourceUrl: location.href,

          /*
           * 优酷会在广告结束、切集、画质变化时重建 video-layer、
           * advertise-layer 和 dashboard。独立覆盖层不会被这些更新删除，
           * resolveStructure 会持续追踪新的 #ykPlayer。
           */
          mountStrategy: "viewport-overlay",
          resolveStructure: findYoukuStructure
        }
      };
    }
  });
})();
