(() => {
  "use strict";

  const api = globalThis.VideoPlayerReplacer;

  if (!api) {
    throw new Error("VideoPlayerReplacer 核心未加载");
  }

  const ADAPTER_ID = "replace-me";

  if (api.hasAdapter(ADAPTER_ID)) {
    return;
  }

  api.register({
    id: ADAPTER_ID,
    name: "新视频网站",

    async detect() {
      /*
       * 只需要完成三件事：
       *
       * 1. 检查当前 URL；
       * 2. 找到网站播放器容器；
       * 3. 返回统一 context：
       *
       * return {
       *   supported: true,
       *   context: {
       *     target: 要被清空并替换的 HTMLElement,
       *     sizeHost: 用于保持尺寸的 HTMLElement
       *   }
       * };
       */

      return {
        supported: false,
        code: "UNSUPPORTED_STRUCTURE",
        message: "请实现这个网站的播放器结构检测"
      };
    }
  });
})();
