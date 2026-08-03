(() => {
  "use strict";

  const VERSION = "1.0.0";
  const ROOT_ATTRIBUTE = "data-vpr-universal-root";

  if (
    globalThis.VideoPlayerReplacer &&
    globalThis.VideoPlayerReplacer.version === VERSION
  ) {
    return;
  }

  const adapters = new Map();
  const states = new Map();

  function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }

  function stopMedia(root) {
    if (!(root instanceof Element)) {
      return;
    }

    for (const media of root.querySelectorAll("video, audio")) {
      try {
        media.pause();
        media.removeAttribute("autoplay");
      } catch {
        // 某些网站可能重写媒体方法；替换流程继续执行。
      }
    }
  }

  function captureInlineStyles(element, names) {
    const values = {};

    for (const name of names) {
      values[name] = {
        value: element.style.getPropertyValue(name),
        priority: element.style.getPropertyPriority(name)
      };
    }

    return values;
  }

  function restoreInlineStyles(element, values) {
    for (const [name, entry] of Object.entries(values)) {
      if (entry.value) {
        element.style.setProperty(name, entry.value, entry.priority);
      } else {
        element.style.removeProperty(name);
      }
    }
  }

  function createUniversalRoot(siteId, sourceUrl, mountStrategy = "inline") {
    const root = document.createElement("div");

    root.setAttribute(ROOT_ATTRIBUTE, siteId);

    const viewportOverlay = mountStrategy === "viewport-overlay";

    Object.assign(root.style, {
      position: viewportOverlay ? "fixed" : "absolute",
      inset: viewportOverlay ? "auto" : "0",
      width: "100%",
      height: "100%",
      minWidth: "1px",
      minHeight: "1px",
      visibility: "visible",
      pointerEvents: "auto",
      overflow: "hidden",
      background: "#000",
      zIndex: "2147483000"
    });

    const iframe = document.createElement("iframe");
    const playerUrl = new URL(
      chrome.runtime.getURL("player/index.html")
    );

    playerUrl.searchParams.set("site", siteId);
    playerUrl.searchParams.set("source", sourceUrl);

    iframe.src = playerUrl.href;
    iframe.title = "Universal replacement player";
    iframe.allow = "autoplay; fullscreen; picture-in-picture";

    Object.assign(iframe.style, {
      display: "block",
      width: "100%",
      height: "100%",
      minWidth: "1px",
      minHeight: "1px",
      border: "0",
      background: "#000"
    });

    root.appendChild(iframe);

    return {
      root,
      iframe
    };
  }


  function mountViewportOverlay(siteId, context) {
    const initialTarget = context?.target;
    const initialSizeHost = context?.sizeHost || initialTarget;
    const resolveStructure =
      typeof context?.resolveStructure === "function"
        ? context.resolveStructure
        : () => ({
            target: initialTarget,
            sizeHost: initialSizeHost
          });
    const sourceUrl =
      typeof context?.sourceUrl === "string" && context.sourceUrl
        ? context.sourceUrl
        : location.href;

    if (!(initialTarget instanceof HTMLElement)) {
      return {
        ok: false,
        code: "INVALID_TARGET",
        message: "网站适配器没有返回有效的播放器目标元素"
      };
    }

    const existingState = states.get(siteId);

    if (
      existingState?.mounted &&
      existingState.root?.isConnected
    ) {
      return {
        ok: true,
        code: "ALREADY_MOUNTED",
        message: "通用播放器覆盖层仍在运行"
      };
    }

    if (existingState?.mounted) {
      restoreUniversal(siteId);
    }

    const { root, iframe } = createUniversalRoot(
      siteId,
      sourceUrl,
      "viewport-overlay"
    );

    root.style.setProperty("left", "0px", "important");
    root.style.setProperty("top", "0px", "important");
    root.style.setProperty("width", "1px", "important");
    root.style.setProperty("height", "1px", "important");
    root.style.setProperty("display", "none", "important");
    root.style.setProperty("contain", "layout paint size", "important");

    const styleNames = [
      "position",
      "overflow",
      "isolation",
      "background",
      "min-width",
      "min-height",
      "height",
      "aspect-ratio"
    ];
    const targetRecords = new Map();

    let currentTarget = null;
    let currentSizeHost = null;
    let childObserver = null;
    let resizeObserver = null;
    let documentObserver = null;
    let healthTimer = null;
    let scheduled = false;
    let stopped = false;
    let lastRect = null;
    let missingRectSince = 0;

    const getTargetRecord = target => {
      let record = targetRecords.get(target);

      if (!record) {
        record = {
          originalStyles: captureInlineStyles(target, styleNames),
          concealedNodes: new Map()
        };
        targetRecords.set(target, record);
      }

      return record;
    };

    const revealNode = (target, node) => {
      if (!(node instanceof HTMLElement)) {
        return;
      }

      const record = getTargetRecord(target);
      const original = record.concealedNodes.get(node);

      if (!original) {
        return;
      }

      restoreInlineStyles(node, original);
      record.concealedNodes.delete(node);
    };

    const concealNode = (target, node) => {
      if (!(node instanceof HTMLElement)) {
        return;
      }

      if (node === root || node.contains(root)) {
        revealNode(target, node);
        return;
      }

      const record = getTargetRecord(target);

      if (!record.concealedNodes.has(node)) {
        record.concealedNodes.set(
          node,
          captureInlineStyles(node, ["visibility", "pointer-events"])
        );
      }

      stopMedia(node);
      node.style.setProperty("visibility", "hidden", "important");
      node.style.setProperty("pointer-events", "none", "important");
    };

    const enforceConcealment = target => {
      if (!(target instanceof HTMLElement) || !target.isConnected) {
        return;
      }

      for (const child of Array.from(target.children)) {
        if (child === root || child.contains(root)) {
          revealNode(target, child);
        } else {
          concealNode(target, child);
        }
      }
    };

    const blockOriginalPlayback = event => {
      const media = event.target;

      if (
        media instanceof HTMLMediaElement &&
        !root.contains(media)
      ) {
        try {
          media.pause();
          media.removeAttribute("autoplay");
        } catch {
          // 忽略网站覆写媒体方法导致的异常。
        }
      }
    };

    const normalizeStructure = value => {
      const target = value?.target;
      const sizeHost = value?.sizeHost || target;

      if (!(target instanceof HTMLElement)) {
        return null;
      }

      return {
        target,
        sizeHost:
          sizeHost instanceof Element
            ? sizeHost
            : target
      };
    };

    const desiredPortalHost = () => {
      const fullscreenElement = document.fullscreenElement;

      if (
        fullscreenElement instanceof HTMLElement &&
        currentTarget instanceof HTMLElement &&
        (
          fullscreenElement.contains(currentTarget) ||
          currentTarget.contains(fullscreenElement)
        )
      ) {
        return fullscreenElement;
      }

      return document.body || document.documentElement;
    };

    const ensureRootConnected = () => {
      const host = desiredPortalHost();

      if (!host) {
        return;
      }

      if (root.parentElement !== host) {
        host.appendChild(root);
      }
    };

    const syncOverlayRect = () => {
      ensureRootConnected();

      const host =
        currentSizeHost instanceof Element &&
        currentSizeHost.isConnected
          ? currentSizeHost
          : currentTarget;

      if (!(host instanceof Element) || !host.isConnected) {
        if (!missingRectSince) {
          missingRectSince = performance.now();
        }

        if (
          !lastRect ||
          performance.now() - missingRectSince > 1800
        ) {
          root.style.setProperty("display", "none", "important");
        }

        return;
      }

      const rect = host.getBoundingClientRect();
      const validRect =
        Number.isFinite(rect.left) &&
        Number.isFinite(rect.top) &&
        rect.width > 1 &&
        rect.height > 8;

      if (!validRect) {
        if (!missingRectSince) {
          missingRectSince = performance.now();
        }

        /*
         * 视频网站切换播放状态时可能让播放器容器短暂变成 0×0。
         * 短时间内保留上一帧尺寸，避免自定义播放器闪烁或被误判为失效。
         */
        if (
          !lastRect ||
          performance.now() - missingRectSince > 1800
        ) {
          root.style.setProperty("display", "none", "important");
        }

        return;
      }

      missingRectSince = 0;
      lastRect = {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height
      };

      root.style.setProperty("display", "block", "important");
      root.style.setProperty("left", `${rect.left}px`, "important");
      root.style.setProperty("top", `${rect.top}px`, "important");
      root.style.setProperty("width", `${rect.width}px`, "important");
      root.style.setProperty("height", `${rect.height}px`, "important");
    };

    const bindStructure = structure => {
      const normalized = normalizeStructure(structure);

      if (!normalized) {
        return false;
      }

      const { target, sizeHost } = normalized;

      if (
        target === currentTarget &&
        sizeHost === currentSizeHost
      ) {
        enforceConcealment(target);
        return true;
      }

      childObserver?.disconnect();
      resizeObserver?.disconnect();

      currentTarget?.removeEventListener(
        "play",
        blockOriginalPlayback,
        true
      );

      currentTarget = target;
      currentSizeHost = sizeHost;

      getTargetRecord(target);
      stopMedia(target);
      enforceConcealment(target);

      const computedPosition = getComputedStyle(target).position;

      if (computedPosition === "static") {
        target.style.setProperty("position", "relative", "important");
      }

      target.style.setProperty("overflow", "hidden", "important");
      target.style.setProperty("isolation", "isolate", "important");
      target.style.setProperty("min-width", "1px", "important");
      target.style.setProperty("background", "#000", "important");

      target.addEventListener(
        "play",
        blockOriginalPlayback,
        true
      );

      childObserver = new MutationObserver(() => {
        scheduleHealthCheck();
      });
      childObserver.observe(target, {
        childList: true
      });

      if (typeof ResizeObserver === "function") {
        resizeObserver = new ResizeObserver(() => {
          syncOverlayRect();
        });
        resizeObserver.observe(sizeHost);

        if (sizeHost !== target) {
          resizeObserver.observe(target);
        }
      }

      syncOverlayRect();
      return true;
    };

    const resolveAndBind = () => {
      let structure = null;

      try {
        structure = resolveStructure();
      } catch {
        // 网站正在重建 DOM 时查询可能暂时失败，下一轮健康检查继续。
      }

      if (normalizeStructure(structure)) {
        bindStructure(structure);
      } else if (currentTarget?.isConnected) {
        enforceConcealment(currentTarget);
      }
    };

    const healthCheck = () => {
      if (stopped) {
        return;
      }

      ensureRootConnected();
      resolveAndBind();

      if (currentTarget?.isConnected) {
        enforceConcealment(currentTarget);
      }

      syncOverlayRect();
    };

    function scheduleHealthCheck() {
      if (scheduled || stopped) {
        return;
      }

      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        healthCheck();
      });
    }

    const onViewportChanged = () => {
      syncOverlayRect();
    };

    ensureRootConnected();
    bindStructure({
      target: initialTarget,
      sizeHost: initialSizeHost
    });

    documentObserver = new MutationObserver(() => {
      scheduleHealthCheck();
    });
    documentObserver.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    window.addEventListener("resize", onViewportChanged);
    window.addEventListener("scroll", onViewportChanged, true);
    document.addEventListener("fullscreenchange", scheduleHealthCheck);

    healthTimer = setInterval(healthCheck, 500);

    states.set(siteId, {
      mounted: true,
      state: "mounted",
      code: "MOUNTED_WITH_DOM_GUARD",
      message:
        "通用播放器已使用独立覆盖层挂载，并监视网站播放器 DOM 重建",
      mountStrategy: "viewport-overlay",
      sourceUrl,
      root,
      iframe,
      get target() {
        return currentTarget;
      },
      targetRecords,
      cleanup() {
        stopped = true;
        childObserver?.disconnect();
        resizeObserver?.disconnect();
        documentObserver?.disconnect();
        clearInterval(healthTimer);

        currentTarget?.removeEventListener(
          "play",
          blockOriginalPlayback,
          true
        );

        window.removeEventListener("resize", onViewportChanged);
        window.removeEventListener("scroll", onViewportChanged, true);
        document.removeEventListener(
          "fullscreenchange",
          scheduleHealthCheck
        );
      }
    });

    return {
      ok: true,
      code: "MOUNTED_WITH_DOM_GUARD",
      message:
        "网站播放器已由独立覆盖层替换，页面重建 DOM 时会自动恢复覆盖"
    };
  }

  function mountUniversal(siteId, context) {
    if (context?.mountStrategy === "viewport-overlay") {
      return mountViewportOverlay(siteId, context);
    }

    const target = context?.target;
    const sizeHost = context?.sizeHost || target;
    const sourceUrl =
      typeof context?.sourceUrl === "string" && context.sourceUrl
        ? context.sourceUrl
        : location.href;

    if (!(target instanceof HTMLElement)) {
      return {
        ok: false,
        code: "INVALID_TARGET",
        message: "网站适配器没有返回有效的播放器目标元素"
      };
    }

    const existingState = states.get(siteId);

    if (
      existingState?.mounted &&
      existingState.target === target &&
      existingState.root?.isConnected
    ) {
      return {
        ok: true,
        code: "ALREADY_MOUNTED",
        message: "通用 H5 页面已经嵌入当前播放器"
      };
    }

    if (existingState?.mounted) {
      restoreUniversal(siteId);
    }

    const targetRect = target.getBoundingClientRect();
    const sizeRect =
      sizeHost instanceof Element
        ? sizeHost.getBoundingClientRect()
        : targetRect;

    if (targetRect.width <= 0 || targetRect.height <= 0) {
      return {
        ok: false,
        code: "ZERO_SIZE_TARGET",
        message: "播放器目标元素当前没有可用尺寸"
      };
    }

    stopMedia(target);

    const styleNames = [
      "position",
      "overflow",
      "isolation",
      "background",
      "min-width",
      "min-height",
      "height",
      "aspect-ratio"
    ];

    const originalStyles = captureInlineStyles(target, styleNames);

    /*
     * 不再把腾讯原播放器节点移出 DOM。其手势库内部持有 ResizeObserver，
     * 节点一旦被移入 DocumentFragment，宽度会瞬间变成 0 并抛出
     * GestureOptionsError。这里改为保留布局，只隐藏原节点并在上方覆盖。
     */
    const concealedNodes = new Map();

    const concealNode = node => {
      if (!(node instanceof HTMLElement)) {
        return;
      }

      if (node.hasAttribute(ROOT_ATTRIBUTE)) {
        return;
      }

      if (!concealedNodes.has(node)) {
        concealedNodes.set(
          node,
          captureInlineStyles(node, ["visibility", "pointer-events"])
        );
      }

      stopMedia(node);
      node.style.setProperty("visibility", "hidden", "important");
      node.style.setProperty("pointer-events", "none", "important");
    };

    for (const child of Array.from(target.children)) {
      concealNode(child);
    }

    const computedPosition = getComputedStyle(target).position;

    if (computedPosition === "static") {
      target.style.setProperty("position", "relative", "important");
    }

    target.style.setProperty("overflow", "hidden", "important");
    target.style.setProperty("isolation", "isolate", "important");
    target.style.setProperty("min-width", "1px", "important");
    target.style.setProperty("background", "#000", "important");

    const ratio =
      sizeRect.width > 0 && sizeRect.height > 0
        ? sizeRect.width / sizeRect.height
        : null;

    const { root, iframe } = createUniversalRoot(siteId, sourceUrl);
    target.appendChild(root);

    let applyingFallbackSize = false;

    const maintainSize = () => {
      if (!target.isConnected) {
        return;
      }

      const rect = target.getBoundingClientRect();

      if (rect.width > 0 && rect.height >= 8) {
        return;
      }

      applyingFallbackSize = true;

      if (ratio && Number.isFinite(ratio) && ratio > 0) {
        target.style.setProperty("aspect-ratio", String(ratio), "important");
        target.style.setProperty("height", "auto", "important");
      } else {
        target.style.setProperty(
          "min-height",
          `${Math.max(1, Math.round(targetRect.height))}px`,
          "important"
        );
      }
    };

    maintainSize();

    const resizeObserver = new ResizeObserver(() => {
      maintainSize();
    });

    if (sizeHost instanceof Element) {
      resizeObserver.observe(sizeHost);
    }

    if (sizeHost !== target) {
      resizeObserver.observe(target);
    }

    const blockOriginalPlayback = event => {
      const media = event.target;

      if (
        media instanceof HTMLMediaElement &&
        !root.contains(media)
      ) {
        try {
          media.pause();
          media.removeAttribute("autoplay");
        } catch {
          // 忽略网站覆写媒体方法导致的异常。
        }
      }
    };

    target.addEventListener("play", blockOriginalPlayback, true);

    const childObserver = new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node === root || root.contains(node)) {
            continue;
          }

          concealNode(node);
        }
      }
    });

    childObserver.observe(target, {
      childList: true
    });

    const disconnectObserver = new MutationObserver(() => {
      if (!target.isConnected) {
        const state = states.get(siteId);

        if (state) {
          state.state = "error";
          state.code = "TARGET_REMOVED";
          state.message =
            "网站重新创建了播放器节点，请重新打开扩展并再次替换";
        }
      }
    });

    disconnectObserver.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    states.set(siteId, {
      mounted: true,
      state: "mounted",
      message: "原播放器布局已保留并隐藏，通用播放器页面已覆盖",
      target,
      sizeHost,
      sourceUrl,
      root,
      iframe,
      concealedNodes,
      originalStyles,
      blockOriginalPlayback,
      resizeObserver,
      childObserver,
      disconnectObserver,
      applyingFallbackSize
    });

    return {
      ok: true,
      code: "MOUNTED",
      message: "原播放器已由通用播放器页面覆盖"
    };
  }

  function restoreUniversal(siteId) {
    const state = states.get(siteId);

    if (!state?.mounted) {
      return {
        ok: true,
        code: "NOT_MOUNTED",
        message: "当前没有需要恢复的播放器"
      };
    }

    if (state.mountStrategy === "viewport-overlay") {
      state.cleanup?.();
      state.root?.remove();

      for (const [target, record] of state.targetRecords || []) {
        if (!(target instanceof HTMLElement) || !target.isConnected) {
          continue;
        }

        for (const [node, styles] of record.concealedNodes || []) {
          if (node?.isConnected) {
            restoreInlineStyles(node, styles);
          }
        }

        restoreInlineStyles(target, record.originalStyles || {});
      }

      states.set(siteId, {
        mounted: false,
        state: "restored",
        message: "原网站播放器内容已恢复"
      });

      return {
        ok: true,
        code: "RESTORED",
        message: "原网站播放器内容已恢复"
      };
    }

    const {
      target,
      root,
      concealedNodes,
      originalStyles,
      blockOriginalPlayback,
      resizeObserver,
      childObserver,
      disconnectObserver
    } = state;

    resizeObserver?.disconnect();
    childObserver?.disconnect();
    disconnectObserver?.disconnect();

    target?.removeEventListener(
      "play",
      blockOriginalPlayback,
      true
    );

    root?.remove();

    if (target?.isConnected) {
      for (const [node, styles] of concealedNodes || []) {
        if (node?.isConnected) {
          restoreInlineStyles(node, styles);
        }
      }

      restoreInlineStyles(target, originalStyles);
    }

    states.set(siteId, {
      mounted: false,
      state: "restored",
      message: target?.isConnected
        ? "原网站播放器内容已恢复"
        : "原播放器节点已被网站移除，无法原位恢复"
    });

    return {
      ok: true,
      code: target?.isConnected ? "RESTORED" : "TARGET_REMOVED",
      message: target?.isConnected
        ? "原网站播放器内容已恢复"
        : "播放器节点已被网站重新创建，请刷新页面恢复"
    };
  }

  const api = {
    version: VERSION,

    register(adapter) {
      if (!adapter || typeof adapter !== "object") {
        throw new TypeError("适配器必须是对象");
      }

      if (!adapter.id || typeof adapter.id !== "string") {
        throw new TypeError("适配器缺少字符串 id");
      }

      if (typeof adapter.detect !== "function") {
        throw new TypeError(`适配器 ${adapter.id} 缺少 detect()`);
      }

      adapters.set(adapter.id, adapter);
    },

    hasAdapter(id) {
      return adapters.has(id);
    },

    async probe(id) {
      const adapter = adapters.get(id);

      if (!adapter) {
        return {
          ok: false,
          code: "ADAPTER_NOT_FOUND",
          message: `没有找到网站适配器：${id}`
        };
      }

      try {
        const detection = await adapter.detect();

        return detection?.supported
          ? {
              ok: true,
              code: "SUPPORTED",
              message: detection.message || "当前网页结构受支持"
            }
          : {
              ok: false,
              code: detection?.code || "UNSUPPORTED_STRUCTURE",
              message: detection?.message || "当前网页结构不受支持"
            };
      } catch (error) {
        return {
          ok: false,
          code: "DETECTION_ERROR",
          message: errorMessage(error)
        };
      }
    },

    async run(id) {
      const adapter = adapters.get(id);

      if (!adapter) {
        return {
          ok: false,
          code: "ADAPTER_NOT_FOUND",
          message: `没有找到网站适配器：${id}`
        };
      }

      try {
        const detection = await adapter.detect();

        if (!detection?.supported) {
          return {
            ok: false,
            code: detection?.code || "UNSUPPORTED_STRUCTURE",
            message: detection?.message || "当前网页结构不受支持"
          };
        }

        return mountUniversal(id, detection.context);
      } catch (error) {
        return {
          ok: false,
          code: "UNEXPECTED_ERROR",
          message: errorMessage(error)
        };
      }
    },

    restore(id) {
      return restoreUniversal(id);
    },

    getStatus(id) {
      const state = states.get(id);

      if (!state) {
        return {
          ok: true,
          state: "not_mounted",
          message: "当前页面尚未替换播放器"
        };
      }

      return {
        ok: true,
        state: state.state,
        code: state.code,
        message: state.message
      };
    }
  };

  Object.defineProperty(globalThis, "VideoPlayerReplacer", {
    configurable: true,
    enumerable: false,
    writable: false,
    value: api
  });
})();
