(() => {
  "use strict";

  const BLOCKED_FLAG = Symbol.for(
    "evan.console.clear.blocked"
  );

  function installClearBlocker() {
    const currentConsole = globalThis.console;

    if (!currentConsole) {
      return;
    }

    if (currentConsole.clear?.[BLOCKED_FLAG]) {
      return;
    }

    const blockedClear = function blockedConsoleClear() {
      currentConsole.warn(
        "[Universal Player] 已拦截 console.clear()",
        {
          url: location.href,
          topFrame: window === window.top,
          stack: new Error().stack
        }
      );
    };

    Object.defineProperty(blockedClear, BLOCKED_FLAG, {
      value: true
    });

    try {
      Object.defineProperty(currentConsole, "clear", {
        value: blockedClear,
        writable: false,
        configurable: false,
        enumerable: true
      });

      currentConsole.info(
        "[Universal Player] console.clear 拦截器已安装",
        {
          url: location.href,
          topFrame: window === window.top
        }
      );
    } catch (error) {
      currentConsole.error(
        "[Universal Player] console.clear 拦截器安装失败",
        error
      );
    }
  }

  installClearBlocker();

  /*
   * 某些网站会替换整个 window.console 对象。
   * 定时检查新的 console 对象并重新安装。
   */
  const timer = setInterval(installClearBlocker, 500);

  window.addEventListener(
    "pagehide",
    () => clearInterval(timer),
    { once: true }
  );
})();