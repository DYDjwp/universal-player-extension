(() => {
  "use strict";

  const i18n = globalThis.VPR_I18N;

  const MESSAGE_TYPES = Object.freeze({
    GET_CURRENT_PAGE:
      "VPR_GET_CURRENT_PAGE",

    INITIALIZE_PLAYER:
      "VPR_INITIALIZE_PLAYER",

    CURRENT_PAGE_CHANGED:
      "VPR_CURRENT_PAGE_CHANGED"
  });

  const ui = {
    siteName:
      document.getElementById("site-name"),

    pageUrl:
      document.getElementById("page-url"),

    statusBox:
      document.getElementById("status-box"),

    statusTitle:
      document.getElementById("status-title"),

    statusDetail:
      document.getElementById("status-detail"),

    actionButton:
      document.getElementById("action-button"),

    intervalButton:
      document.getElementById("interval-button")
  };

  let currentPageInfo = null;
  let mounted = false;
  let actionRunning = false;

  function setStatus(
    type,
    title,
    detail = ""
  ) {
    ui.statusBox.className =
      `status-box status-${type}`;

    ui.statusTitle.textContent =
      title;

    ui.statusDetail.textContent =
      detail;
  }

  function setAction(
    label,
    enabled
  ) {
    ui.actionButton.textContent =
      label;

    ui.actionButton.disabled =
      !enabled;
  }

  /*
   * 所有页面信息都从 background.js 获取。
   */
  async function requestCurrentPageInfo() {
    return browser.runtime.sendMessage({
      type:
        MESSAGE_TYPES.GET_CURRENT_PAGE
    });
  }

  /*
   * 请求 background.js 调用 initialization()。
   */
  async function requestPlayerInitialization() {
    return browser.runtime.sendMessage({
      type:
        MESSAGE_TYPES.INITIALIZE_PLAYER
    });
  }

  async function applyPageInfo(pageInfo) {
    currentPageInfo = pageInfo;
    mounted = false;

    ui.siteName.textContent =
      i18n.translateSiteName(pageInfo);

    ui.pageUrl.textContent =
      pageInfo?.url ||
      "";

    if (
      pageInfo?.supported === true
    ) {
      if (pageInfo?.mounted === true) {
        mounted = true;

        setStatus(
          "success",
          i18n.t("popup.replaceSuccess"),
          i18n.t("popup.playerReady")
        );

        setAction(
          i18n.t("popup.restoreOriginal"),
          true
        );

        return;
      }

      setStatus(
        "ready",
        i18n.t("popup.pageSupported"),
        i18n.t("popup.clickToInit")
      );

      setAction(
        i18n.t("popup.startReplace"),
        true
      );

      return;
    }

    setStatus(
      "unsupported",
      i18n.t("popup.pageUnsupported"),
      i18n.translateRuntime(
        pageInfo,
        "popup.pageNotEligible"
      )
    );

    setAction(
      i18n.t("popup.startReplace"),
      false
    );
  }

  async function initializePopup() {
    setStatus(
      "loading",
      i18n.t("popup.statusChecking"),
      i18n.t("popup.statusWaitingBackground")
    );

    setAction(
      i18n.t("popup.statusCheckingShort"),
      false
    );

    try {
      const pageInfo =
        await requestCurrentPageInfo();

      await applyPageInfo(pageInfo);
    } catch (error) {
      ui.siteName.textContent =
        i18n.t("sites.unknown");

      setStatus(
        "error",
        i18n.t("popup.error"),
        error?.message ||
          String(error)
      );

      setAction(
        i18n.t("popup.startReplace"),
        false
      );
    }
  }

  async function handleAction() {
    if (actionRunning) {
      return;
    }

    if (
      currentPageInfo?.supported !==
      true
    ) {
      setStatus(
        "unsupported",
        i18n.t("popup.pageUnsupported"),
        i18n.t("popup.backgroundUnsupported")
      );

      setAction(
        i18n.t("popup.startReplace"),
        false
      );

      return;
    }

    actionRunning = true;

    const siteLabel =
      i18n.translateSiteName(currentPageInfo);

    setAction(
      mounted
        ? i18n.t("popup.restoring")
        : i18n.t("popup.replacing"),
      false
    );

    setStatus(
      "loading",
      mounted
        ? i18n.t("popup.restoringPlayer")
        : i18n.t("popup.startingReplace"),
      i18n.t("popup.adapterWorking", {
        site: siteLabel
      })
    );

    try {
      /*
       * popup.js 不调用 initial.js。
       *
       * popup.js
       *   -> background.js
       *   -> initialization()
       *   -> initial.js
       */
      const result =
        await requestPlayerInitialization();

      if (!result?.ok) {
        const unsupported =
          result?.state ===
          "unsupported";

        setStatus(
          unsupported
            ? "unsupported"
            : "error",

          unsupported
            ? i18n.t("popup.pageUnsupported")
            : i18n.t("popup.error"),

          i18n.translateRuntime(
            result,
            "popup.initFailed"
          )
        );

        setAction(
          mounted
            ? i18n.t("popup.restoreOriginal")
            : i18n.t("popup.retryReplace"),

          result?.supported === true
        );

        return;
      }

      if (
        result.state === "mounted"
      ) {
        mounted = true;

        setStatus(
          "success",
          i18n.t("popup.replaceSuccess"),
          i18n.translateRuntime(
            result,
            "popup.embedded"
          )
        );

        setAction(
          i18n.t("popup.restoreOriginal"),
          true
        );

        return;
      }

      mounted = false;

      setStatus(
        "ready",
        i18n.t("popup.restored"),
        i18n.translateRuntime(
          result,
          "popup.originalRestored"
        )
      );

      setAction(
        i18n.t("popup.startReplace"),
        true
      );
    } catch (error) {
      setStatus(
        "error",
        i18n.t("popup.error"),
        error?.message ||
          String(error)
      );

      setAction(
        mounted
          ? i18n.t("popup.restoreOriginal")
          : i18n.t("popup.retryReplace"),
        true
      );
    } finally {
      actionRunning = false;
    }
  }

  browser.runtime.onMessage.addListener(
    message => {
      if (
        message?.type !==
        MESSAGE_TYPES.CURRENT_PAGE_CHANGED
      ) {
        // 不能把监听器声明为 async。否则即使消息不属于 popup，
        // Promise<undefined> 也可能抢先结束其他监听器的响应。
        return false;
      }

      void applyPageInfo(
        message.pageInfo
      ).catch(error => {
        console.warn(
          "[Universal Player] popup 页面状态更新失败：",
          error
        );
      });

      return false;
    }
  );

  ui.actionButton.addEventListener(
    "click",
    handleAction
  );

  ui.intervalButton.addEventListener(
    "click",
    () => {
      browser.tabs.create({
        url: browser.runtime.getURL(
          "setting/index.html"
        )
      });
    }
  );

  Promise.all([
    globalThis.VPR_THEME.initTheme(),
    i18n.initI18n()
  ]).then(() => initializePopup());
})();
