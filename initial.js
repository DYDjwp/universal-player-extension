(() => {
  "use strict";

  const CORE_SCRIPT = "content/core.js";
  const EXECUTION_MODES = new Set([
    "toggle",
    "ensure",
    "remount"
  ]);

  async function executeInTab(
    tabId,
    options
  ) {
    if (!Number.isInteger(tabId)) {
      throw new Error("找不到当前标签页");
    }

    return browser.scripting.executeScript({
      target: {
        tabId
      },
      ...options
    });
  }

  async function injectAdapter(
    tabId,
    route
  ) {
    await executeInTab(tabId, {
      files: [
        CORE_SCRIPT,
        route.adapterScript
      ]
    });
  }

  async function callApi(
    tabId,
    method,
    siteId
  ) {
    const results = await executeInTab(
      tabId,
      {
        func: async (
          methodName,
          id
        ) => {
          const api =
            globalThis.VideoPlayerReplacer;

          if (
            !api ||
            typeof api[methodName] !==
              "function"
          ) {
            return {
              ok: false,
              code: "CORE_NOT_LOADED",
              message:
                "扩展核心没有成功加载"
            };
          }

          try {
            return await api[methodName](id);
          } catch (error) {
            return {
              ok: false,
              code: "API_EXECUTION_FAILED",
              message:
                error?.message ||
                String(error)
            };
          }
        },
        args: [
          method,
          siteId
        ]
      }
    );

    return results[0]?.result ?? {
      ok: false,
      code: "EMPTY_RESULT",
      message: "页面没有返回执行结果"
    };
  }

  function normalizeFailure(result) {
    const unsupported =
      result?.code === "UNSUPPORTED_URL" ||
      result?.code ===
        "UNSUPPORTED_STRUCTURE";

    return {
      ok: false,
      state: unsupported
        ? "unsupported"
        : "error",
      code:
        result?.code ||
        "UNKNOWN_ERROR",
      message:
        result?.message ||
        "未知错误"
    };
  }

  async function restorePlayer(
    tabId,
    route
  ) {
    const restoreResult =
      await callApi(
        tabId,
        "restore",
        route.id
      );

    if (!restoreResult?.ok) {
      return normalizeFailure(
        restoreResult
      );
    }

    return {
      ok: true,
      state: "ready",
      action: "restored",
      code:
        restoreResult.code ||
        "PLAYER_RESTORED",
      message:
        restoreResult.message ||
        "原网站播放器内容已恢复"
    };
  }

  async function mountPlayer(
    tabId,
    route
  ) {
    const probeResult =
      await callApi(
        tabId,
        "probe",
        route.id
      );

    if (!probeResult?.ok) {
      return normalizeFailure(
        probeResult
      );
    }

    const runResult =
      await callApi(
        tabId,
        "run",
        route.id
      );

    if (!runResult?.ok) {
      return normalizeFailure(
        runResult
      );
    }

    return {
      ok: true,
      state: "mounted",
      action: "mounted",
      code:
        runResult.code ||
        "PLAYER_MOUNTED",
      message:
        runResult.message ||
        "通用 H5 页面已嵌入播放器区域"
    };
  }

  /*
   * mode:
   *
   * toggle:
   *   已替换则恢复，未替换则挂载。用于 popup 按钮。
   *
   * ensure:
   *   已替换则保持不动，未替换则挂载。用于自动替换和刷新恢复。
   *
   * remount:
   *   已替换则先恢复，再根据当前 URL 重新挂载。用于自动切换视频。
   */
  async function execute(
    tabId,
    route,
    options = {}
  ) {
    if (
      !route?.id ||
      !route?.adapterScript
    ) {
      return {
        ok: false,
        state: "unsupported",
        code: "INVALID_ROUTE",
        message: "网站适配器信息无效"
      };
    }

    const mode =
      EXECUTION_MODES.has(options?.mode)
        ? options.mode
        : "toggle";

    try {
      await injectAdapter(
        tabId,
        route
      );

      const currentStatus =
        await callApi(
          tabId,
          "getStatus",
          route.id
        );

      const mounted =
        currentStatus?.state ===
        "mounted";

      if (
        mode === "toggle" &&
        mounted
      ) {
        return restorePlayer(
          tabId,
          route
        );
      }

      if (
        mode === "ensure" &&
        mounted
      ) {
        return {
          ok: true,
          state: "mounted",
          action: "already_mounted",
          code: "PLAYER_ALREADY_MOUNTED",
          message:
            currentStatus?.message ||
            "播放器已经完成替换"
        };
      }

      if (
        mode === "remount" &&
        mounted
      ) {
        const restoreResult =
          await restorePlayer(
            tabId,
            route
          );

        if (!restoreResult?.ok) {
          return restoreResult;
        }
      }

      return mountPlayer(
        tabId,
        route
      );
    } catch (error) {
      return {
        ok: false,
        state: "error",
        code: "INITIALIZATION_ERROR",
        message:
          error?.message ||
          String(error)
      };
    }
  }

  async function getStatus(
    tabId,
    route
  ) {
    if (
      !route?.id ||
      !Number.isInteger(tabId)
    ) {
      return {
        ok: false,
        state: "not_mounted",
        code: "INVALID_STATUS_CONTEXT",
        message: "无法读取播放器状态"
      };
    }

    try {
      const status = await callApi(
        tabId,
        "getStatus",
        route.id
      );

      if (status?.code === "CORE_NOT_LOADED") {
        return {
          ok: true,
          state: "not_mounted",
          code: "CORE_NOT_LOADED",
          message: "当前页面尚未加载扩展核心"
        };
      }

      return status;
    } catch (error) {
      return {
        ok: false,
        state: "not_mounted",
        code: "STATUS_READ_FAILED",
        message:
          error?.message ||
          String(error)
      };
    }
  }

  globalThis.VPR_INITIALIZER =
    Object.freeze({
      execute,
      getStatus
    });
})();
