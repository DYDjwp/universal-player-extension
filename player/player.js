(async () => {
  (function() {
      const disableClear = {
          value: function() { console.log("[拦截] 有脚本尝试调用 clear()"); },
          writable: false,    
          configurable: false  
      };
      Object.defineProperty(console, 'clear', disableClear);

      if (window.Console && window.Console.prototype) {
          Object.defineProperty(window.Console.prototype, 'clear', disableClear);
      }
  })();
  "use strict";

  const app = document.getElementById("app");

  if (!(app instanceof HTMLElement)) {
    throw new Error("找不到播放器根容器 #app");
  }

  if (typeof CryptoJS === "undefined") {
    throw new Error(
      "CryptoJS 未加载，请确认 player/index.html 先加载 libs/crypto-js.js"
    );
  }

  const FORBIDDEN_IP_MESSAGE =
    "当前端口不支持该ip，请切换网络或开启国内vpn后再试";

  const HLS_LIBRARY_MISSING_MESSAGE =
    "Firefox 播放标准 HLS 需要本地 hls.js。请运行 tools/download-hls.cmd，" +
    "或将 hls.min.js 放到 player/libs/hls.min.js 后重新加载扩展。";

  function getErrorStatus(error) {
    let current = error;
    const visited = new Set();

    while (current && !visited.has(current)) {
      visited.add(current);

      for (const key of ["httpStatus", "status", "statusCode", "code"]) {
        const value = Number(current?.[key]);

        if (Number.isFinite(value)) {
          return value;
        }
      }

      current = current?.cause;
    }

    return null;
  }

  function isForbiddenError(error) {
    if (getErrorStatus(error) === 403) {
      return true;
    }

    const message = error instanceof Error
      ? error.message
      : String(error ?? "");

    return (
      /\b403\s+Forbidden\b/i.test(message) ||
      /\bHTTP\s*403\b/i.test(message) ||
      /接口(?:请求失败|返回|返回异常代码)[^\n]*\b403\b/i.test(message)
    );
  }

  function getDisplayErrorMessage(error) {
    if (isForbiddenError(error)) {
      return FORBIDDEN_IP_MESSAGE;
    }

    return error instanceof Error
      ? error.message
      : String(error);
  }

  function createHttpError(message, status) {
    const error = new Error(message);
    error.httpStatus = Number(status);
    return error;
  }

  function renderPlayerError(message) {
    const existing = document.getElementById("player-status");
    existing?.remove?.();

    const errorElement = document.createElement("div");
    errorElement.id = "player-status";
    errorElement.dataset.state = "error";
    errorElement.setAttribute("role", "alert");
    errorElement.textContent = String(message);
    app.appendChild(errorElement);

    return errorElement;
  }

  const params = new URLSearchParams(location.search);
  const siteId = params.get("site") || "unknown";
  const sourceUrl = params.get("source");

  if (!sourceUrl) {
    throw new Error("没有收到原始视频页面 URL");
  }

  let parsedSourceUrl;

  try {
    parsedSourceUrl = new URL(sourceUrl);
  } catch {
    throw new Error("收到的原始视频页面 URL 无效");
  }

  if (
    siteId === "tencent" &&
    !(
      parsedSourceUrl.protocol === "https:" &&
      parsedSourceUrl.hostname === "v.qq.com"
    )
  ) {
    throw new Error("腾讯适配器收到的页面地址不是 v.qq.com");
  }

  const videoDataApi = "https://cache.0567890.xyz:4433/Api";
  const timeApi = "https://data.video.iqiyi.com/v.f4v?src=iqiyi.com";
  const signAesIv = CryptoJS.enc.Utf8.parse("fUU9eRmkYzsgbkEK");

  const playerLogEntries = [];

  function setStatus(message, state = "loading", details = null) {
    const normalizedMessage =
      state === "error" &&
      (isForbiddenError(details) || isForbiddenError(message))
        ? FORBIDDEN_IP_MESSAGE
        : String(message);

    const entry = Object.freeze({
      time: new Date().toISOString(),
      state,
      message: normalizedMessage,
      details
    });

    playerLogEntries.push(entry);

    if (playerLogEntries.length > 500) {
      playerLogEntries.splice(0, playerLogEntries.length - 500);
    }

    const logMethod = state === "error"
      ? "error"
      : state === "ready"
        ? "info"
        : "debug";

    console[logMethod](`[Universal Player] ${entry.message}`, details || "");

    if (state === "error") {
      renderPlayerError(entry.message);
    }
  }

  function encodeUrlForApi(url) {
    // 与 Python urllib.parse.quote(url, safe="") 的结果保持一致。
    return encodeURIComponent(url).replace(
      /[!'()*]/g,
      char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
    );
  }

  function generateKey(tm, encodedUrl) {
    return CryptoJS.MD5(
      String(tm) + encodedUrl
    ).toString(CryptoJS.enc.Hex);
  }

  function aesEncrypt(data, requestKey) {
    const plaintext = CryptoJS.enc.Utf8.parse(data);
    const md5Hex = CryptoJS.MD5(
      requestKey
    ).toString(CryptoJS.enc.Hex);

    // 必须按 32 个 ASCII/UTF-8 字节处理，即 AES-256。
    const aesKey = CryptoJS.enc.Utf8.parse(md5Hex);

    /*
     * 接口的 sign 算法不会在刚好对齐 16 字节时追加 PKCS#7 块。
     * request key 固定为 32 个 ASCII 字节，已经是两个完整 AES 块，
     * 因此这里必须使用 NoPadding。使用 Pkcs7 会得到 48 字节密文，
     * Base64 长度变成 64，服务端会返回 code 403。
     */
    if (plaintext.sigBytes % 16 !== 0) {
      throw new Error(
        `sign 明文长度必须是 16 的倍数，当前为 ${plaintext.sigBytes} 字节`
      );
    }

    const encrypted = CryptoJS.AES.encrypt(
      plaintext,
      aesKey,
      {
        iv: signAesIv,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.NoPadding
      }
    );

    return CryptoJS.enc.Base64.stringify(
      encrypted.ciphertext
    );
  }

  function aesDecrypt(base64Data, keyStr, ivStr) {
    if (
      typeof base64Data !== "string" ||
      typeof keyStr !== "string" ||
      typeof ivStr !== "string"
    ) {
      throw new TypeError("解密参数必须是字符串");
    }

    const key = CryptoJS.enc.Utf8.parse(keyStr);
    const iv = CryptoJS.enc.Utf8.parse(ivStr);

    if (key.sigBytes !== 16) {
      throw new Error(
        `响应 AES key 长度错误：${key.sigBytes} 字节`
      );
    }

    if (iv.sigBytes !== 16) {
      throw new Error(
        `响应 AES IV 长度错误：${iv.sigBytes} 字节`
      );
    }

    const cipherParams = CryptoJS.lib.CipherParams.create({
      ciphertext: CryptoJS.enc.Base64.parse(base64Data)
    });

    const decrypted = CryptoJS.AES.decrypt(
      cipherParams,
      key,
      {
        iv,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7
      }
    );

    const plaintext = decrypted.toString(CryptoJS.enc.Utf8);

    if (!plaintext) {
      throw new Error(
        "AES 解密结果为空，可能是 key、iv 或密文不匹配"
      );
    }

    return plaintext;
  }

  function generateSign(key) {
    return aesEncrypt(key, key);
  }

  async function getPayload() {
    const response = await fetch(timeApi, {
      method: "GET",
      cache: "no-store"
    });

    if (!response.ok) {
      throw createHttpError(
        `获取服务器时间失败：HTTP ${response.status}${
          response.statusText ? ` ${response.statusText}` : ""
        }`,
        response.status
      );
    }

    const timeData = await response.json();

    if (
      timeData.time === undefined ||
      timeData.time === null
    ) {
      throw new Error("时间接口响应中不存在 time 字段");
    }

    const tm = String(timeData.time);
    const encodedUrl = encodeUrlForApi(sourceUrl);
    const key = generateKey(tm, encodedUrl);
    const sign = generateSign(key);
    const signByteLength = CryptoJS.enc.Base64.parse(sign).sigBytes;

    if (signByteLength !== 32) {
      throw new Error(
        `sign 密文长度异常：预期 32 字节，实际 ${signByteLength} 字节`
      );
    }

    return {
      tm,
      url: encodedUrl,
      key,
      sign
    };
  }

  async function getData() {
    const payload = await getPayload();
    const body = new URLSearchParams();

    body.set("tm", String(payload.tm));
    body.set("url", payload.url);
    body.set("key", payload.key);
    body.set("sign", payload.sign);

    console.log("POST payload:", payload);

    const response = await fetch(videoDataApi, {
      method: "POST",
      headers: {
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Content-Type":
          "application/x-www-form-urlencoded;charset=UTF-8",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache"
      },
      body: body.toString(),
      cache: "no-store",
      credentials: "omit"
    });

    if (!response.ok) {
      throw createHttpError(
        `接口请求失败：HTTP ${response.status}${
          response.statusText ? ` ${response.statusText}` : ""
        }`,
        response.status
      );
    }

    const result = await response.json();

    if (Number(result.code) !== 200) {
      console.error("API rejected response:", result);

      const serverMessage =
        result.message || result.msg || result.error || "";

      const error = new Error(
        serverMessage
          ? `接口返回 ${String(result.code)}：${serverMessage}`
          : `接口返回异常代码：${String(result.code)}`
      );

      if (Number(result.code) === 403) {
        error.httpStatus = 403;
      }

      throw error;
    }

    if (
      typeof result.data !== "string" ||
      typeof result.key !== "string" ||
      typeof result.iv !== "string"
    ) {
      throw new Error("接口响应缺少 data、key 或 iv");
    }

    console.log("Encrypted response:", result);
    return result;
  }

  function extractResponseJson(decryptedText) {
    const marker = "tg:@xmflv";
    let jsonText = decryptedText.trim();

    if (jsonText.startsWith(marker)) {
      jsonText = jsonText.slice(marker.length);
    }

    if (jsonText.endsWith(marker)) {
      jsonText = jsonText.slice(0, -marker.length);
    }

    try {
      return JSON.parse(jsonText);
    } catch (error) {
      console.error("无法解析的解密原文：", decryptedText);
      throw new Error(
        `解密成功，但 JSON 解析失败：${error.message}`
      );
    }
  }

  async function decryptData() {
    const responseData = await getData();
    const decryptedText = aesDecrypt(
      responseData.data,
      responseData.key,
      responseData.iv
    );

    console.log("Decrypted raw text:", decryptedText);

    const videoInfo = extractResponseJson(decryptedText);

    console.log("Parsed video info:", videoInfo);
    console.log("Video URL:", videoInfo.url);

    return videoInfo;
  }

  function formatBytes(value) {
    if (!Number.isFinite(value) || value < 0) {
      return "0 B";
    }

    const units = ["B", "KB", "MB", "GB"];
    let amount = value;
    let unitIndex = 0;

    while (amount >= 1024 && unitIndex < units.length - 1) {
      amount /= 1024;
      unitIndex += 1;
    }

    return `${amount.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
  }

  const MEDIA_CHROME_ELEMENTS = Object.freeze([
    "media-controller",
    "media-control-bar",
    "media-play-button",
    "media-seek-backward-button",
    "media-seek-forward-button",
    "media-time-display",
    "media-time-range",
    "media-mute-button",
    "media-volume-range",
    "media-pip-button",
    "media-fullscreen-button"
  ]);

  async function ensureMediaChromeReady(timeoutMs = 4000) {
    if (!globalThis.customElements) {
      throw new Error("当前浏览器不支持 Web Components，无法加载 Media browser");
    }

    const waitForDefinitions = Promise.all(
      MEDIA_CHROME_ELEMENTS.map(tagName => customElements.whenDefined(tagName))
    );

    let timeoutId = 0;
    const timeout = new Promise((_, reject) => {
      timeoutId = window.setTimeout(() => {
        const missing = MEDIA_CHROME_ELEMENTS.filter(
          tagName => !customElements.get(tagName)
        );
        reject(new Error(
          `Media browser 未安装或加载失败：${missing.join(", ") || "组件注册超时"}。` +
          "请运行扩展根目录中的 install-media-browser.cmd，然后重新加载扩展。"
        ));
      }, timeoutMs);
    });

    try {
      await Promise.race([waitForDefinitions, timeout]);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function createMediaElement(tagName, attributes = {}) {
    const element = document.createElement(tagName);

    for (const [name, value] of Object.entries(attributes)) {
      if (value === true) {
        element.setAttribute(name, "");
      } else if (value !== false && value !== null && value !== undefined) {
        element.setAttribute(name, String(value));
      }
    }

    return element;
  }

  function createDanmakuUi() {
    const layer = document.createElement("div");
    layer.id = "danmaku-layer";
    layer.setAttribute("aria-hidden", "true");

    const toast = document.createElement("div");
    toast.id = "danmaku-toast";
    toast.hidden = true;
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");

    const settingsPanel = document.createElement("section");
    settingsPanel.id = "danmaku-settings-panel";
    settingsPanel.hidden = true;
    settingsPanel.setAttribute("aria-label", "弹幕设置");
    settingsPanel.innerHTML = `
      <header class="danmaku-panel-header">
        <div>
          <strong>弹幕设置</strong>
          <span>平台弹幕与公益弹幕库</span>
        </div>
        <button id="danmaku-settings-close" class="danmaku-panel-close" type="button" aria-label="关闭弹幕设置">×</button>
      </header>
      <div class="danmaku-panel-body">
        <label class="danmaku-check-row">
          <input id="danmaku-source-platform" type="checkbox">
          <span>显示平台原生弹幕</span>
        </label>
        <label class="danmaku-check-row">
          <input id="danmaku-source-independent" type="checkbox">
          <span>显示独立弹幕库</span>
        </label>
        <label class="danmaku-setting-row">
          <span>不透明度 <output id="danmaku-opacity-output"></output></span>
          <input id="danmaku-opacity" type="range" min="0.2" max="1" step="0.05">
        </label>
        <label class="danmaku-setting-row">
          <span>字体大小 <output id="danmaku-font-scale-output"></output></span>
          <input id="danmaku-font-scale" type="range" min="0.6" max="1.8" step="0.1">
        </label>
        <label class="danmaku-setting-row">
          <span>滚动速度 <output id="danmaku-speed-output"></output></span>
          <input id="danmaku-speed" type="range" min="0.5" max="2" step="0.1">
        </label>
        <label class="danmaku-setting-row">
          <span>显示区域</span>
          <select id="danmaku-area">
            <option value="0.25">顶部 25%</option>
            <option value="0.5">顶部 50%</option>
            <option value="0.75">顶部 75%</option>
            <option value="1">全屏</option>
          </select>
        </label>
        <label class="danmaku-setting-row">
          <span>同屏上限 <output id="danmaku-density-output"></output></span>
          <input id="danmaku-density" type="range" min="10" max="120" step="5">
        </label>
      </div>
      <footer class="danmaku-panel-footer">
        <button id="danmaku-reload" type="button">重新加载弹幕</button>
      </footer>
    `;

    const toggleButton = document.createElement("button");
    toggleButton.id = "danmaku-toggle";
    toggleButton.className = "evan-control-button danmaku-toggle is-active";
    toggleButton.type = "button";
    toggleButton.setAttribute("aria-pressed", "true");
    toggleButton.innerHTML = '<span>弹</span><small id="danmaku-count">加载中</small>';

    const settingsButton = document.createElement("button");
    settingsButton.id = "danmaku-settings-button";
    settingsButton.className = "evan-control-button danmaku-settings-button";
    settingsButton.type = "button";
    settingsButton.title = "弹幕设置";
    settingsButton.setAttribute("aria-expanded", "false");
    settingsButton.textContent = "弹幕设置";

    const openComposerButton = document.createElement("button");
    openComposerButton.id = "danmaku-open-composer";
    openComposerButton.className = "evan-control-button";
    openComposerButton.type = "button";
    openComposerButton.textContent = "发弹幕";

    const composer = document.createElement("div");
    composer.id = "danmaku-composer";

    const sendForm = document.createElement("form");
    sendForm.id = "danmaku-send-form";
    sendForm.autocomplete = "off";

    const colorInput = document.createElement("input");
    colorInput.id = "danmaku-color";
    colorInput.type = "color";
    colorInput.value = "#FFFFFF";
    colorInput.title = "弹幕颜色";
    colorInput.setAttribute("aria-label", "弹幕颜色");

    const sizeSelect = document.createElement("select");
    sizeSelect.id = "danmaku-size";
    sizeSelect.title = "弹幕字号";
    sizeSelect.setAttribute("aria-label", "弹幕字号");
    for (const [value, label] of [["18", "小"], ["24", "中"], ["32", "大"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      if (value === "24") option.selected = true;
      sizeSelect.appendChild(option);
    }

    const textInput = document.createElement("input");
    textInput.id = "danmaku-text";
    textInput.type = "text";
    textInput.maxLength = 80;
    textInput.placeholder = "发一条友善的弹幕";
    textInput.setAttribute("aria-label", "弹幕内容");

    const sendButton = document.createElement("button");
    sendButton.id = "danmaku-send";
    sendButton.type = "submit";
    sendButton.textContent = "发送";

    sendForm.append(colorInput, sizeSelect, textInput, sendButton);
    composer.appendChild(sendForm);

    const byId = id => settingsPanel.querySelector(`#${id}`);

    return {
      layer,
      toast,
      settingsPanel,
      toggleButton,
      settingsButton,
      openComposerButton,
      composer,
      sendForm,
      colorInput,
      sizeSelect,
      textInput,
      sendButton,
      count: toggleButton.querySelector("#danmaku-count"),
      closeSettingsButton: byId("danmaku-settings-close"),
      platformCheckbox: byId("danmaku-source-platform"),
      independentCheckbox: byId("danmaku-source-independent"),
      opacityInput: byId("danmaku-opacity"),
      opacityOutput: byId("danmaku-opacity-output"),
      fontScaleInput: byId("danmaku-font-scale"),
      fontScaleOutput: byId("danmaku-font-scale-output"),
      speedInput: byId("danmaku-speed"),
      speedOutput: byId("danmaku-speed-output"),
      areaSelect: byId("danmaku-area"),
      densityInput: byId("danmaku-density"),
      densityOutput: byId("danmaku-density-output"),
      reloadButton: byId("danmaku-reload")
    };
  }

  function createVideoElement() {
    const container = document.createElement("div");
    container.id = "player-container";
    container.tabIndex = -1;

    const videoRegion = document.createElement("div");
    videoRegion.id = "player-video-region";

    const controllerId = "evan-media-controller";
    const mediaController = createMediaElement("media-controller", {
      id: controllerId,
      defaultstreamtype: "on-demand",
      keyboardforwardseekoffset: "10",
      keyboardbackwardseekoffset: "10",
      autohide: "-1"
    });

    const video = document.createElement("video");
    video.id = "video";
    video.slot = "media";
    video.controls = false;
    video.playsInline = true;
    video.preload = "auto";

    mediaController.appendChild(video);

    const danmakuElements = createDanmakuUi();
    videoRegion.append(
      mediaController,
      danmakuElements.layer,
      danmakuElements.toast,
      danmakuElements.settingsPanel
    );

    const controlsShell = document.createElement("div");
    controlsShell.id = "player-controls";

    const timeline = createMediaElement("media-time-range", {
      id: "player-timeline",
      mediacontroller: controllerId,
      "aria-label": "播放进度"
    });
    const emptyPreview = document.createElement("span");
    emptyPreview.slot = "preview";
    timeline.appendChild(emptyPreview);

    const controlBar = createMediaElement("media-control-bar", {
      id: "player-control-bar",
      mediacontroller: controllerId
    });

    const playButton = createMediaElement("media-play-button", {
      title: "播放 / 暂停"
    });
    const backwardButton = createMediaElement("media-seek-backward-button", {
      seekoffset: "10",
      title: "后退 10 秒"
    });
    const forwardButton = createMediaElement("media-seek-forward-button", {
      seekoffset: "10",
      title: "前进 10 秒"
    });
    const timeDisplay = createMediaElement("media-time-display", {
      showduration: true,
      title: "播放时间"
    });

    const spacer = document.createElement("span");
    spacer.className = "player-control-spacer";
    spacer.setAttribute("aria-hidden", "true");

    const playbackRateControl = document.createElement("div");
    playbackRateControl.id = "playback-rate-control";

    const playbackRateButton = document.createElement("button");
    playbackRateButton.id = "playback-rate-button";
    playbackRateButton.className = "evan-control-button playback-rate-trigger";
    playbackRateButton.type = "button";
    playbackRateButton.title = "选择播放速度";
    playbackRateButton.setAttribute("aria-haspopup", "menu");
    playbackRateButton.setAttribute("aria-expanded", "false");
    playbackRateButton.setAttribute("aria-controls", "playback-rate-menu");
    playbackRateButton.textContent = formatPlaybackRate(1);

    const playbackRateMenu = document.createElement("div");
    playbackRateMenu.id = "playback-rate-menu";
    playbackRateMenu.setAttribute("role", "menu");
    playbackRateMenu.setAttribute("aria-label", "播放速度");
    playbackRateMenu.hidden = true;

    for (const rate of PLAYBACK_RATES) {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "playback-rate-option";
      option.dataset.playbackRate = String(rate);
      option.setAttribute("role", "menuitemradio");
      option.setAttribute("aria-checked", rate === 1 ? "true" : "false");
      option.textContent = formatPlaybackRate(rate);
      playbackRateMenu.appendChild(option);
    }

    playbackRateControl.append(playbackRateButton, playbackRateMenu);
    const muteButton = createMediaElement("media-mute-button", {
      title: "静音"
    });
    const volumeRange = createMediaElement("media-volume-range", {
      title: "音量"
    });
    const pipButton = createMediaElement("media-pip-button", {
      title: "画中画"
    });
    const fullscreenButton = createMediaElement("media-fullscreen-button", {
      title: "全屏"
    });

    controlBar.append(
      playButton,
      backwardButton,
      forwardButton,
      timeDisplay,
      spacer,
      danmakuElements.composer,
      danmakuElements.openComposerButton,
      danmakuElements.toggleButton,
      danmakuElements.settingsButton,
      playbackRateControl,
      muteButton,
      volumeRange,
      pipButton,
      fullscreenButton
    );

    controlsShell.append(timeline, controlBar);
    container.append(videoRegion, controlsShell);

    // Media browser resolves the `fullscreenelement` attribute while the
    // controller is still detached. At that point it cannot find the outer
    // container, so it silently falls back to fullscreening only the inner
    // media-controller. The custom controls are siblings of that element and
    // would therefore disappear from the fullscreen top layer.
    //
    // Assign the element reference directly after the complete player tree is
    // assembled so video, danmaku and the entire control bar enter fullscreen
    // together.
    const bindFullscreenElement = () => {
      if (!("fullscreenElement" in mediaController)) return false;
      mediaController.fullscreenElement = container;
      return true;
    };

    if (!bindFullscreenElement()) {
      customElements.whenDefined("media-controller")
        .then(bindFullscreenElement)
        .catch(error => {
          console.warn("[Universal Player] 绑定全屏容器失败：", error);
        });
    }

    return {
      container,
      videoRegion,
      mediaController,
      controlsShell,
      controlBar,
      timeline,
      playbackRateControl,
      playbackRateButton,
      playbackRateMenu,
      danmakuElements,
      video
    };
  }

  const PLAYBACK_RATE_KEY = "playerPlaybackRate";
  const PLAYBACK_RATES = Object.freeze([
    0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3
  ]);

  function normalizePlaybackRate(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 1;
    return PLAYBACK_RATES.reduce((nearest, candidate) =>
      Math.abs(candidate - number) < Math.abs(nearest - number)
        ? candidate
        : nearest
    , 1);
  }

  function formatPlaybackRate(rate) {
    return Number.isInteger(rate)
      ? `${rate}.0×`
      : `${rate}×`;
  }

  async function setupPlaybackRatePersistence(video, elements) {
    const {
      control,
      button,
      menu
    } = elements || {};

    let currentRate = 1;
    let lastPersistedRate = null;
    let destroyed = false;

    const setMenuOpen = open => {
      if (!(menu instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) {
        return;
      }

      const shouldOpen = Boolean(open);
      menu.hidden = !shouldOpen;
      button.setAttribute("aria-expanded", String(shouldOpen));
      button.classList.toggle("is-active", shouldOpen);

      if (shouldOpen) {
        menu.querySelector('[aria-checked="true"]')?.focus?.();
      }
    };

    const updateUi = rate => {
      if (button instanceof HTMLButtonElement) {
        button.textContent = formatPlaybackRate(rate);
        button.title = `播放速度：${formatPlaybackRate(rate)}`;
      }

      if (menu instanceof HTMLElement) {
        for (const option of menu.querySelectorAll("[data-playback-rate]")) {
          const selected = Number(option.dataset.playbackRate) === rate;
          option.setAttribute("aria-checked", String(selected));
          option.classList.toggle("is-selected", selected);
        }
      }
    };

    const updateRate = rate => {
      currentRate = normalizePlaybackRate(rate);
      video.defaultPlaybackRate = currentRate;
      video.playbackRate = currentRate;
      video.preservesPitch = true;
      if ("webkitPreservesPitch" in video) {
        video.webkitPreservesPitch = true;
      }
      updateUi(currentRate);
    };

    const persistRate = async rate => {
      if (destroyed || lastPersistedRate === rate) return;
      lastPersistedRate = rate;

      try {
        await browser.storage.local.set({ [PLAYBACK_RATE_KEY]: rate });
      } catch (error) {
        console.warn("[Universal Player] 保存倍速设置失败：", error);
      }
    };

    const setRate = rate => {
      const normalized = normalizePlaybackRate(rate);
      updateRate(normalized);
      void persistRate(normalized);
    };

    const handleRateChange = () => {
      const normalized = normalizePlaybackRate(video.playbackRate);

      if (Math.abs(video.playbackRate - normalized) > 0.001) {
        updateRate(normalized);
      } else {
        currentRate = normalized;
        updateUi(normalized);
      }

      void persistRate(normalized);
    };

    const handleButtonClick = event => {
      event.stopPropagation();
      setMenuOpen(menu?.hidden !== false);
    };

    const handleMenuClick = event => {
      const option = event.target.closest?.("[data-playback-rate]");
      if (!(option instanceof HTMLButtonElement)) return;
      setRate(option.dataset.playbackRate);
      setMenuOpen(false);
      button?.focus?.();
    };

    const handleDocumentPointerDown = event => {
      if (control instanceof HTMLElement && !control.contains(event.target)) {
        setMenuOpen(false);
      }
    };

    const handleDocumentKeyDown = event => {
      if (event.key === "Escape" && menu?.hidden === false) {
        event.preventDefault();
        setMenuOpen(false);
        button?.focus?.();
      }
    };

    video.addEventListener("ratechange", handleRateChange);
    button?.addEventListener("click", handleButtonClick);
    menu?.addEventListener("click", handleMenuClick);
    document.addEventListener("pointerdown", handleDocumentPointerDown);
    document.addEventListener("keydown", handleDocumentKeyDown);

    try {
      const stored = await browser.storage.local.get({ [PLAYBACK_RATE_KEY]: 1 });
      const savedRate = normalizePlaybackRate(stored[PLAYBACK_RATE_KEY]);
      lastPersistedRate = savedRate;
      updateRate(savedRate);
    } catch (error) {
      console.warn("[Universal Player] 读取倍速设置失败：", error);
      updateRate(1);
    }

    return Object.freeze({
      get rate() {
        return currentRate;
      },
      setRate,
      closeMenu() {
        setMenuOpen(false);
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        video.removeEventListener("ratechange", handleRateChange);
        button?.removeEventListener("click", handleButtonClick);
        menu?.removeEventListener("click", handleMenuClick);
        document.removeEventListener("pointerdown", handleDocumentPointerDown);
        document.removeEventListener("keydown", handleDocumentKeyDown);
      }
    });
  }

  function setupFullscreenControls(container, video, controlsShell) {
    const HIDE_DELAY_MS = 2800;
    let hideTimer = 0;
    let destroyed = false;

    const isFullscreen = () => (
      document.fullscreenElement === container ||
      document.webkitFullscreenElement === container
    );

    const hasOpenPanel = () => Boolean(
      container.querySelector('[aria-expanded="true"]') ||
      container.querySelector("#danmaku-composer.is-open") ||
      container.querySelector("#danmaku-settings-panel:not([hidden])")
    );

    const clearHideTimer = () => {
      if (!hideTimer) return;
      clearTimeout(hideTimer);
      hideTimer = 0;
    };

    const showControls = () => {
      clearHideTimer();
      container.classList.remove("is-controls-hidden");
    };

    const scheduleHide = () => {
      clearHideTimer();
      if (!isFullscreen() || video.paused || video.ended) return;

      hideTimer = window.setTimeout(() => {
        hideTimer = 0;
        if (
          destroyed ||
          !isFullscreen() ||
          video.paused ||
          video.ended ||
          hasOpenPanel()
        ) {
          scheduleHide();
          return;
        }
        container.classList.add("is-controls-hidden");
      }, HIDE_DELAY_MS);
    };

    const revealAndSchedule = () => {
      showControls();
      scheduleHide();
    };

    const handleFullscreenChange = () => {
      showControls();
      if (isFullscreen()) scheduleHide();
    };

    const handlePause = () => {
      showControls();
    };

    const handlePlay = () => {
      revealAndSchedule();
    };

    const handleControlsEnter = () => {
      revealAndSchedule();
    };

    const handleControlsLeave = () => {
      scheduleHide();
    };

    container.addEventListener("pointermove", revealAndSchedule, { passive: true });
    container.addEventListener("pointerdown", revealAndSchedule, { passive: true });
    container.addEventListener("keydown", revealAndSchedule);
    controlsShell.addEventListener("pointerenter", handleControlsEnter);
    controlsShell.addEventListener("pointerleave", handleControlsLeave);
    video.addEventListener("pause", handlePause);
    video.addEventListener("play", handlePlay);
    video.addEventListener("ended", handlePause);
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("webkitfullscreenchange", handleFullscreenChange);

    return Object.freeze({
      show: revealAndSchedule,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        clearHideTimer();
        container.classList.remove("is-controls-hidden");
        container.removeEventListener("pointermove", revealAndSchedule);
        container.removeEventListener("pointerdown", revealAndSchedule);
        container.removeEventListener("keydown", revealAndSchedule);
        controlsShell.removeEventListener("pointerenter", handleControlsEnter);
        controlsShell.removeEventListener("pointerleave", handleControlsLeave);
        video.removeEventListener("pause", handlePause);
        video.removeEventListener("play", handlePlay);
        video.removeEventListener("ended", handlePause);
        document.removeEventListener("fullscreenchange", handleFullscreenChange);
        document.removeEventListener("webkitfullscreenchange", handleFullscreenChange);
      }
    });
  }

  function attachVideoStatusEvents(video, playbackState) {
    video.addEventListener("loadedmetadata", () => {
      const isMsePlayback = [
        "hls-js",
        "preparing-hls-js",
        "mse-decoded-hls",
        "preparing-mse-hls"
      ].includes(playbackState.mode);

      setStatus(
        isMsePlayback
          ? "MSE 播放已启动，视频元数据已加载"
          : "视频地址已加载",
        "ready"
      );
    });

    video.addEventListener("canplay", () => {
      document
        .getElementById("player-status")
        ?.remove();

      // 必须通过 Proxy 写入
      playbackState.mode = "ready";
    });

    video.addEventListener("waiting", () => {
      console.log("[Universal Player] 视频正在缓冲");
    });

    video.addEventListener("playing", () => {
      console.log("[Universal Player] 视频开始播放");
    });

    video.addEventListener("error", () => {
      const mediaError = video.error;
      const details = mediaError
        ? `（MediaError ${mediaError.code}）`
        : "";

      playbackState.mode = "error";

      setStatus(
        `视频播放失败${details}`,
        "error"
      );
    });
  }

  function looksLikeHlsUrl(url) {
    try {
      const parsed = new URL(url);
      return /\.m3u8(?:$|[?#])/i.test(parsed.href);
    } catch {
      return /\.m3u8(?:$|[?#])/i.test(String(url));
    }
  }

  async function createHlsJsPlayback(video, sourceUrl, options = {}) {
    const HlsConstructor = globalThis.Hls;

    if (typeof HlsConstructor !== "function") {
      throw new Error(HLS_LIBRARY_MISSING_MESSAGE);
    }

    if (!HlsConstructor.isSupported()) {
      throw new Error(
        "当前 Firefox 环境不支持 hls.js 所需的 Media Source Extensions"
      );
    }

    const hls = new HlsConstructor({
      // Firefox 扩展页面的 CSP 可能阻止 blob Worker，关闭 Worker 更稳妥。
      enableWorker: false,
      lowLatencyMode: true,
      backBufferLength: 60,
      maxBufferLength: 45,
      maxMaxBufferLength: 90,
      manifestLoadingMaxRetry: 4,
      levelLoadingMaxRetry: 4,
      fragLoadingMaxRetry: 4
    });

    let destroyed = false;
    let networkRecoveries = 0;
    let mediaRecoveries = 0;

    const destroy = () => {
      if (destroyed) {
        return;
      }

      destroyed = true;
      hls.destroy();
    };

    const ready = new Promise((resolve, reject) => {
      const rejectPlayback = error => {
        destroy();
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      hls.on(HlsConstructor.Events.MEDIA_ATTACHED, () => {
        options.onStatus?.("hls.js 已连接播放器，正在加载播放列表……");
        hls.loadSource(sourceUrl);
      });

      hls.on(HlsConstructor.Events.MANIFEST_PARSED, (_event, data) => {
        options.onStatus?.(
          `hls.js 已解析播放列表（${data?.levels?.length || 1} 个清晰度）`
        );
        resolve();
      });

      hls.on(HlsConstructor.Events.ERROR, (_event, data) => {
        const summary = [
          data?.type,
          data?.details,
          Number.isFinite(data?.response?.code)
            ? `HTTP ${data.response.code}`
            : null
        ].filter(Boolean).join(" / ");

        if (!data?.fatal) {
          console.debug("[Universal Player] hls.js 非致命错误：", data);
          return;
        }

        if (
          data.type === HlsConstructor.ErrorTypes.NETWORK_ERROR &&
          networkRecoveries < 2
        ) {
          networkRecoveries += 1;
          options.onStatus?.(
            `HLS 网络错误，正在恢复（${networkRecoveries}/2）……`
          );
          hls.startLoad();
          return;
        }

        if (
          data.type === HlsConstructor.ErrorTypes.MEDIA_ERROR &&
          mediaRecoveries < 2
        ) {
          mediaRecoveries += 1;
          options.onStatus?.(
            `HLS 媒体错误，正在恢复（${mediaRecoveries}/2）……`
          );
          hls.recoverMediaError();
          return;
        }

        const error = new Error(
          `hls.js 播放失败${summary ? `：${summary}` : ""}`
        );

        const status = Number(data?.response?.code);
        if (Number.isFinite(status)) {
          error.httpStatus = status;
        }

        options.onError?.(error, data);
        rejectPlayback(error);
      });

      hls.attachMedia(video);
    });

    try {
      await ready;
    } catch (error) {
      destroy();
      throw error;
    }

    return {
      mode: "hls-js",
      hls,
      destroy,
      revoke: destroy
    };
  }

  async function selectPlaybackSource(video, videoUrl, playbackState) {
    if (!globalThis.NativeHlsDecoder) {
      throw new Error("HLS 检测与解包模块没有加载");
    }

    setStatus("正在判断媒体能否直接播放……", "loading");

    let analysis;

    try {
      analysis = await globalThis.NativeHlsDecoder.inspectSource(
        videoUrl,
        {
          signal: playbackState.abortController.signal,
          onStatus(message) {
            setStatus(message, "loading");
          }
        }
      );
    } catch (error) {
      if (isForbiddenError(error)) {
        playbackState.mode = "error";
        setStatus(
          FORBIDDEN_IP_MESSAGE,
          "error",
          error
        );
        throw error;
      }

      console.warn(
        "媒体预检失败：",
        error
      );

      if (looksLikeHlsUrl(videoUrl)) {
        playbackState.mode = "preparing-hls-js";
        setStatus(
          "媒体预检失败，但地址看起来是 HLS，正在使用 hls.js……",
          "loading"
        );

        const prepared = await createHlsJsPlayback(video, videoUrl, {
          onStatus(message) {
            setStatus(message, "loading");
          },
          onError(hlsError) {
            setStatus(
              isForbiddenError(hlsError)
                ? FORBIDDEN_IP_MESSAGE
                : getDisplayErrorMessage(hlsError),
              "error",
              hlsError
            );
          }
        });

        playbackState.prepared = prepared;
        playbackState.mode = "hls-js";
        return null;
      }

      playbackState.mode = "native-fallback";
      setStatus(
        "媒体预检失败，正在尝试浏览器直接播放……",
        "loading"
      );

      return videoUrl;
    }

    playbackState.analysis = analysis;

    if (analysis.kind !== "hls") {
      playbackState.mode = "native-media";
      setStatus("检测为普通媒体，使用浏览器直接播放……", "loading");
      return videoUrl;
    }

    console.log("HLS 分片检测结果：", {
      playlist: analysis.mediaPlaylist.url,
      segment: analysis.firstSegmentUrl,
      contentType: analysis.firstSegmentContentType,
      inspection: analysis.inspection
    });

    if (!analysis.requiresUnwrap) {
      playbackState.mode = "preparing-hls-js";
      setStatus(
        `检测为标准 HLS（${analysis.inspection.kind}），正在使用 hls.js……`,
        "loading"
      );

      const hlsSourceUrl =
        analysis.rootPlaylist?.url ||
        analysis.mediaPlaylist?.url ||
        videoUrl;

      const prepared = await createHlsJsPlayback(video, hlsSourceUrl, {
        onStatus(message) {
          setStatus(message, "loading");
        },
        onError(error) {
          setStatus(
            isForbiddenError(error)
              ? FORBIDDEN_IP_MESSAGE
              : getDisplayErrorMessage(error),
            "error",
            error
          );
        }
      });

      playbackState.prepared = prepared;
      playbackState.mode = "hls-js";

      // hls.js 已绑定 MediaSource；不要再覆盖 video.src。
      return null;
    }

    playbackState.mode = "preparing-mse-hls";
    setStatus(
      "检测到 PNG 外壳，正在启动 MSE 边加载边解包……",
      "loading"
    );

    const prepared = await globalThis.NativeHlsDecoder.createMsePlayback(
      video,
      analysis,
      {
        signal: playbackState.abortController.signal,
        onStatus(message, stats) {
          playbackState.stats = stats || playbackState.stats;
          setStatus(message, "loading");
        },
        onError(error, stats) {
          playbackState.stats = stats || playbackState.stats;
          setStatus(
            isForbiddenError(error)
              ? FORBIDDEN_IP_MESSAGE
              : `HLS 解包播放失败：${getDisplayErrorMessage(error)}`,
            "error",
            error
          );
        }
      }
    );

    playbackState.prepared = prepared;
    playbackState.stats = prepared.stats;
    playbackState.mode = "mse-decoded-hls";

    console.log("HLS MSE 按需解包已启用：", prepared.stats);
    setStatus(
      "首个分片已解包，正在等待播放器就绪……",
      "loading"
    );

    // createMsePlayback 已经设置 video.src；不要再次覆盖。
    return null;
  }


  const HISTORY_MESSAGES = Object.freeze({
    GET: "VPR_HISTORY_GET_FOR_URL",
    UPSERT: "VPR_HISTORY_UPSERT"
  });

  function canonicalizeWatchUrl(urlString) {
    try {
      const url = new URL(urlString);
      return `${url.origin}${url.pathname.replace(/\/$/, "") || "/"}`;
    } catch {
      return urlString;
    }
  }

  function formatWatchTime(seconds) {
    const value = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const secs = value % 60;
    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
      : `${minutes}:${String(secs).padStart(2, "0")}`;
  }

  function wait(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
  }

  function sendHistoryMessageOnce(message, timeoutMs = 4500) {
    // Firefox's browser.runtime.sendMessage is Promise-based. Passing a
    // callback as its second argument is not supported by the browser API.
    if (!globalThis.browser?.runtime?.sendMessage) {
      return Promise.reject(new Error("扩展消息接口不可用"));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("观看历史后台响应超时"));
      }, timeoutMs);

      const resolveOnce = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const rejectOnce = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      try {
        Promise.resolve(browser.runtime.sendMessage(message)).then(response => {
          if (typeof response === "undefined") {
            rejectOnce(new Error("扩展后台没有返回观看历史响应"));
            return;
          }
          resolveOnce(response);
        }, rejectOnce);
      } catch (error) {
        rejectOnce(error);
      }
    });
  }

  async function sendHistoryMessage(message, retries = 1) {
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await sendHistoryMessageOnce(message);
      } catch (error) {
        lastError = error;
        if (attempt < retries) await wait(160 * (attempt + 1));
      }
    }

    throw lastError || new Error("观看历史后台通信失败");
  }

  function episodeNumberFromName(name) {
    const match = String(name || "").match(/第\s*(\d+)\s*集|(?:^|\D)(\d+)(?:\D|$)/);
    return match ? Number(match[1] || match[2]) : null;
  }

  async function fetchCatalogMetadata(urlString) {
    try {
      const response = await fetch(
        `https://dmku.hls.one/?ac=list&url=${encodeURIComponent(canonicalizeWatchUrl(urlString))}`,
        { method: "GET", cache: "no-store" }
      );
      if (!response.ok) return null;
      const data = await response.json();
      if (Number(data?.vod_code) !== 200) return null;

      const canonicalUrl = canonicalizeWatchUrl(urlString);
      const episodes = Array.isArray(data.vod_episodes) ? data.vod_episodes : [];
      const matched = episodes.find(item => canonicalizeWatchUrl(item?.url || "") === canonicalUrl) || null;
      const episodeName = typeof matched?.name === "string" ? matched.name.trim() : "";

      return {
        title: typeof data.vod_title === "string" ? data.vod_title.trim() : "",
        episodeName,
        episodeIndex: episodeNumberFromName(episodeName)
      };
    } catch (error) {
      console.warn("[Universal Player] 获取剧集信息失败：", error);
      return null;
    }
  }

  function showStorageWarning(storage) {
    if (!storage?.warning) return;
    let element = document.getElementById("history-storage-warning");
    if (!element) {
      element = document.createElement("div");
      element.id = "history-storage-warning";
      app.appendChild(element);
    }
    element.textContent = storage.critical
      ? "扩展存储空间即将用尽，请前往设置清理历史记录"
      : "扩展存储空间已使用超过 80%，建议清理历史记录";
  }

  function showResumePrompt(video, record) {
    if (!record || Number(record.progress) < 3) return;

    document.getElementById("resume-prompt")?.remove();

    const prompt = document.createElement("button");
    prompt.id = "resume-prompt";
    prompt.type = "button";
    prompt.setAttribute("aria-label", `跳转到上次观看位置 ${formatWatchTime(record.progress)}`);
    prompt.innerHTML = `<span>上次看到了 ${formatWatchTime(record.progress)}</span><strong>点击跳转</strong>`;

    let dismissTimer = 0;
    let removeTimer = 0;
    let dismissed = false;

    const dismiss = (immediate = false) => {
      if (dismissed) return;
      dismissed = true;
      clearTimeout(dismissTimer);
      clearTimeout(removeTimer);

      if (immediate) {
        prompt.remove();
        return;
      }

      prompt.classList.add("is-hiding");
      removeTimer = window.setTimeout(() => prompt.remove(), 220);
    };

    const jump = () => {
      const target = Math.max(0, Number(record.progress) || 0);
      dismiss(true);

      const apply = () => {
        const duration = Number(video.duration);
        video.currentTime = Number.isFinite(duration) && duration > 0
          ? Math.min(target, Math.max(0, duration - 0.25))
          : target;
        video.play().catch(() => undefined);
      };

      if (video.readyState >= 1) apply();
      else video.addEventListener("loadedmetadata", apply, { once: true });
    };

    prompt.addEventListener("click", jump, { once: true });
    app.appendChild(prompt);
    dismissTimer = window.setTimeout(() => dismiss(false), 9000);
  }

  async function setupWatchHistory(video, videoInfo) {
    const settings = await browser.storage.local.get({ historyEnabled: true });
    let enabled = settings.historyEnabled !== false;
    const canonicalUrl = canonicalizeWatchUrl(sourceUrl);
    let catalogMetadata = null;
    let lastSavedAt = 0;
    let lastSavedProgress = -1;
    let saving = Promise.resolve();

    if (enabled) {
      const existingResponse = await sendHistoryMessage({
        type: HISTORY_MESSAGES.GET,
        url: canonicalUrl
      }).catch(() => null);
      showResumePrompt(video, existingResponse?.item || null);
    }

    // Metadata is optional: a slow third-party catalog must never block
    // progress updates or the initial playback pipeline.
    void fetchCatalogMetadata(canonicalUrl).then(metadata => {
      catalogMetadata = metadata;
    });

    const save = (force = false, completed = false) => {
      if (!enabled) return Promise.resolve();
      const progress = completed
        ? (Number(video.duration) || Number(video.currentTime) || 0)
        : (Number(video.currentTime) || 0);
      const duration = Number(video.duration) || 0;
      const now = Date.now();

      if (!completed && progress < 2) return Promise.resolve();
      if (!force && now - lastSavedAt < 5000) return Promise.resolve();
      if (!force && Math.abs(progress - lastSavedProgress) < 2) return Promise.resolve();

      lastSavedAt = now;
      lastSavedProgress = progress;
      saving = saving.catch(() => undefined).then(async () => {
        let response;

        try {
          response = await sendHistoryMessage({
            type: HISTORY_MESSAGES.UPSERT,
            item: {
              url: canonicalUrl,
              siteId,
              progress,
              duration,
              completed,
              title: catalogMetadata?.title || "",
              episodeName: catalogMetadata?.episodeName || "",
              episodeIndex: catalogMetadata?.episodeIndex ?? null,
              cover: typeof videoInfo?.pic === "string" ? videoInfo.pic : ""
            }
          });
        } catch (error) {
          const message = error instanceof Error
            ? error.message
            : String(error || "未知错误");
          console.warn("[Universal Player] 保存观看历史失败：", message, error);
          if (/quota|storage|存储|空间/i.test(message)) {
            showStorageWarning({ warning: true, critical: true });
          }
          return;
        }

        if (!response.ok) {
          const message = response.message || response.code || "后台拒绝保存观看历史";
          console.warn("[Universal Player] 保存观看历史失败：", message, response);
          if (/quota|storage|存储|空间/i.test(String(message))) {
            showStorageWarning({ warning: true, critical: true });
          }
          return;
        }
        if (response.storage) showStorageWarning(response.storage);
      });
      return saving;
    };

    video.addEventListener("timeupdate", () => { void save(false, false); });
    video.addEventListener("pause", () => { void save(true, false); });
    video.addEventListener("ended", () => { void save(true, true); });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") void save(true, video.ended);
    });
    window.addEventListener("pagehide", () => { void save(true, video.ended); });

    browser.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "local" && changes.historyEnabled) {
        enabled = changes.historyEnabled.newValue !== false;
      }
    });

    return { save };
  }

  async function initializePlayer() {
    await ensureMediaChromeReady();
    setStatus("正在解析视频地址……", "loading");

    let covered = true;
    const videoInfo = await decryptData();

    if (
      !videoInfo ||
      typeof videoInfo.url !== "string" ||
      !videoInfo.url.trim()
    ) {
      throw new Error("解析结果中没有有效的视频 URL");
    } else if(
      !videoInfo.pic || 
      typeof videoInfo.pic !== "string" ||
      !videoInfo.pic.trim()
    ) {
      covered = false;
      console.warn("解析结果中没有有效的视频封面 URL");
    }

    app.replaceChildren();

    const {
      container,
      mediaController,
      controlsShell,
      playbackRateControl,
      playbackRateButton,
      playbackRateMenu,
      danmakuElements,
      video
    } = createVideoElement();

    if (covered) {
      video.poster = videoInfo.pic.trim();
    }

    const rawPlaybackState = {
      mode: "detecting",
      analysis: null,
      prepared: null,
      stats: null,
      abortController: new AbortController()
    };

    const playbackState = new Proxy(rawPlaybackState, {
      set(target, property, value, receiver) {
        const oldValue = Reflect.get(
          target,
          property,
          receiver
        );

        const success = Reflect.set(
          target,
          property,
          value,
          receiver
        );

        if (
          success &&
          property === "mode" &&
          oldValue !== value
        ) {
          console.log(
            `[Universal Player] 播放模式已切换：${oldValue} → ${value}`
          );

          if (value === "ready") {
            video.play().catch(error => {
              console.warn(
                "[Universal Player] 自动播放失败：",
                error
              );
            });
          }
        }

        return success;
      }
    });

    attachVideoStatusEvents(video, playbackState);
    app.appendChild(container);
    const playbackRateController = await setupPlaybackRatePersistence(video, {
      control: playbackRateControl,
      button: playbackRateButton,
      menu: playbackRateMenu
    });
    const fullscreenControlsController = setupFullscreenControls(
      container,
      video,
      controlsShell
    );
    const historyController = await setupWatchHistory(video, videoInfo);

    let danmakuController = null;

    try {
      if (!globalThis.EvanDanmaku?.createController) {
        throw new Error("弹幕模块未加载");
      }

      danmakuController = await globalThis.EvanDanmaku.createController({
        video,
        sourceUrl,
        canonicalUrl: canonicalizeWatchUrl(sourceUrl),
        elements: danmakuElements
      });
    } catch (error) {
      console.error("[Universal Player] 弹幕系统初始化失败：", error);
      danmakuElements.count.textContent = "不可用";
      danmakuElements.toast.textContent = `弹幕系统初始化失败：${
        error instanceof Error ? error.message : String(error)
      }`;
      danmakuElements.toast.dataset.state = "error";
      danmakuElements.toast.hidden = false;
    }

    const playableUrl = await selectPlaybackSource(
      video,
      videoInfo.url.trim(),
      playbackState
    );

    if (playableUrl) {
      video.src = playableUrl;
      video.load();
    }

    const cleanup = () => {
      void historyController?.save?.(true, video.ended);
      playbackState.abortController.abort();
      playbackRateController?.destroy?.();
      fullscreenControlsController?.destroy?.();
      danmakuController?.destroy?.();
      playbackState.prepared?.destroy?.();
      playbackState.prepared?.revoke?.();
    };

    window.addEventListener("pagehide", cleanup, { once: true });

    globalThis.UniversalPlayer = Object.freeze({
      version: "1.0.1",
      app,
      siteId,
      sourceUrl,
      video,
      mediaController,
      videoInfo,
      playbackState,
      playbackRateController,
      fullscreenControlsController,
      danmakuController,

      getLogs() {
        return playerLogEntries.map(
          entry => ({ ...entry })
        );
      },

      cleanup
    });

    window.parent.postMessage(
      {
        source: "Evan Player",
        type: "PLAYER_READY",
        siteId,
        hasVideoUrl: true,
        playbackMode: playbackState.mode
      },
      "*"
    );

    return videoInfo;
  }

  await initializePlayer();
})().catch(error => {
  console.error("播放器初始化失败：", error);

  const forbiddenMessage =
    "当前端口不支持该ip，请切换网络或开启国内vpn后再试";
  const rawMessage = error instanceof Error
    ? error.message
    : String(error);

  let current = error;
  let forbidden = false;
  const visited = new Set();

  while (current && !visited.has(current)) {
    visited.add(current);

    const status = Number(
      current?.httpStatus ??
      current?.status ??
      current?.statusCode ??
      current?.code
    );

    if (status === 403) {
      forbidden = true;
      break;
    }

    current = current?.cause;
  }

  if (!forbidden) {
    forbidden =
      /\b403\s+Forbidden\b/i.test(rawMessage) ||
      /\bHTTP\s*403\b/i.test(rawMessage) ||
      /接口(?:请求失败|返回|返回异常代码)[^\n]*\b403\b/i.test(rawMessage);
  }

  const displayMessage = forbidden
    ? forbiddenMessage
    : rawMessage;
  const app = document.getElementById("app");

  if (app) {
    app.replaceChildren();

    const errorElement = document.createElement("div");
    errorElement.id = "player-status";
    errorElement.dataset.state = "error";
    errorElement.setAttribute("role", "alert");
    errorElement.textContent = forbidden
      ? displayMessage
      : `播放器初始化失败：${displayMessage}`;

    app.appendChild(errorElement);
  }

  window.parent.postMessage(
    {
      source: "Evan Player",
      type: "PLAYER_ERROR",
      message: displayMessage
    },
    "*"
  );
});
