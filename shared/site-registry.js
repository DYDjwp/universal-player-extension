(() => {
  "use strict";

  /*
   * 这里只负责：
   * 1. 根据 URL 判断应该交给哪个网站适配器；
   * 2. 指定适配器脚本路径。
   *
   * 所有网站最终都会使用同一个 player/index.html。
   */
  globalThis.VPR_SITE_ROUTES = Object.freeze([
    Object.freeze({
      id: "tencent",
      name: "腾讯视频",
      adapterScript: "content/sites/tencent.js",

      getPageKey(urlString) {
        const url = new URL(urlString);
        return `${url.origin}${url.pathname}`;
      },

      matches(urlString) {
        try {
          const url = new URL(urlString);

          return (
            url.protocol === "https:" &&
            url.hostname === "v.qq.com" &&
            /^\/x\/cover\/[^/]+\/[^/]+\.html$/.test(url.pathname)
          );
        } catch {
          return false;
        }
      }
    }),

    Object.freeze({
      id: "iqiyi",
      name: "爱奇艺",
      adapterScript: "content/sites/iqiyi.js",

      getPageKey(urlString) {
        const url = new URL(urlString);
        return `${url.origin}${url.pathname}`;
      },

      matches(urlString) {
        try {
          const url = new URL(urlString);

          /*
           * 只检查 pathname，a=image、qyTrace 等查询参数不会影响匹配。
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
    }),

    Object.freeze({
      id: "mgtv",
      name: "芒果 TV",
      adapterScript: "content/sites/mgtv.js",

      getPageKey(urlString) {
        const url = new URL(urlString);
        return `${url.origin}${url.pathname}`;
      },

      matches(urlString) {
        try {
          const url = new URL(urlString);

          return (
            url.protocol === "https:" &&
            (url.hostname === "www.mgtv.com" || url.hostname === "mgtv.com") &&
            /^\/b\/\d+\/\d+\.html$/.test(url.pathname)
          );
        } catch {
          return false;
        }
      }
    }),

    Object.freeze({
      id: "youku",
      name: "优酷",
      adapterScript: "content/sites/youku.js",

      getPageKey(urlString) {
        const url = new URL(urlString);
        return `${url.origin}${url.pathname}`;
      },

      matches(urlString) {
        try {
          const url = new URL(urlString);

          return (
            url.protocol === "https:" &&
            url.hostname === "v.youku.com" &&
            /^\/v_show\/id_[A-Za-z0-9_-]+={0,2}\.html$/.test(url.pathname)
          );
        } catch {
          return false;
        }
      }
    }),

    Object.freeze({
      id: "bilibili",
      name: "哔哩哔哩番剧",
      adapterScript: "content/sites/bilibili.js",

      getPageKey(urlString) {
        const url = new URL(urlString);
        const pathname = url.pathname.replace(/\/$/, "");
        return `${url.origin}${pathname}`;
      },

      matches(urlString) {
        try {
          const url = new URL(urlString);

          return (
            url.protocol === "https:" &&
            url.hostname === "www.bilibili.com" &&
            /^\/bangumi\/play\/(?:ss|ep)\d+\/?$/.test(url.pathname)
          );
        } catch {
          return false;
        }
      }
    })
  ]);
})();
