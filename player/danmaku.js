(() => {
  "use strict";

  const API_URL = "https://dmku.hls.one/";
  const SETTINGS_KEY = "danmakuSettings";
  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    platformEnabled: true,
    independentEnabled: true,
    opacity: 0.9,
    fontScale: 1,
    speed: 1,
    area: 0.75,
    maxOnScreen: 60
  });

  const SYSTEM_MESSAGE_PATTERNS = Object.freeze([
    /弹幕列队来袭/,
    /遵守弹幕礼仪/,
    /文明发送弹幕/,
    /请合理使用/
  ]);

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function normalizeHexColor(value, fallback = "#FFFFFF") {
    const text = String(value || "").trim();
    if (/^#[0-9a-f]{6}$/i.test(text)) return text.toUpperCase();
    if (/^#[0-9a-f]{3}$/i.test(text)) {
      return `#${text.slice(1).split("").map(char => char + char).join("")}`.toUpperCase();
    }
    return fallback;
  }

  function normalizeFontSize(value, fallback = 28) {
    const match = String(value ?? "").match(/\d+(?:\.\d+)?/);
    const number = Number(match?.[0]);
    return Number.isFinite(number) ? clamp(number, 16, 48) : fallback;
  }

  function normalizeMode(value) {
    const mode = String(value || "right").toLowerCase();
    if (["top", "fixed-top", "center-top"].includes(mode)) return "top";
    if (["bottom", "fixed-bottom", "center-bottom"].includes(mode)) return "bottom";
    return "right";
  }

  function isSyntheticSystemMessage(raw, text) {
    if (!Array.isArray(raw) || raw.length > 5) return false;
    return SYSTEM_MESSAGE_PATTERNS.some(pattern => pattern.test(text));
  }

  function normalizeDanmakuItem(raw, source, index) {
    if (!Array.isArray(raw) || raw.length < 5) return null;

    const time = Number(raw[0]);
    const text = String(raw[4] ?? "").trim();

    if (!Number.isFinite(time) || time < 0 || !text) return null;
    if (isSyntheticSystemMessage(raw, text)) return null;

    const longFormat = raw.length >= 7;
    const rawId = longFormat ? String(raw[3] ?? "") : "";
    const size = normalizeFontSize(longFormat ? raw[6] : raw[3]);

    return Object.freeze({
      id: rawId || `${source}-${index}-${Math.round(time * 1000)}`,
      time,
      mode: normalizeMode(raw[1]),
      color: normalizeHexColor(raw[2]),
      size,
      text: text.slice(0, 200),
      source,
      raw
    });
  }

  function normalizeResponse(data, source) {
    if (Number(data?.code) !== 23 || !Array.isArray(data?.danmuku)) {
      return [];
    }

    return data.danmuku
      .map((raw, index) => normalizeDanmakuItem(raw, source, index))
      .filter(Boolean);
  }

  function itemKey(item) {
    return [
      Math.round(item.time * 10),
      item.mode,
      item.color,
      item.text
    ].join("|");
  }

  function mergeDanmakuLists(...lists) {
    const seen = new Set();
    const merged = [];

    for (const list of lists) {
      for (const item of list) {
        const key = itemKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(item);
      }
    }

    return merged.sort((left, right) => left.time - right.time);
  }

  function binarySearchByTime(items, target) {
    let low = 0;
    let high = items.length;

    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (items[middle].time < target) low = middle + 1;
      else high = middle;
    }

    return low;
  }

  function computeDanmakuId(url) {
    if (typeof CryptoJS === "undefined") {
      throw new Error("CryptoJS 未加载，无法生成弹幕 ID");
    }

    return CryptoJS.MD5(String(url))
      .toString(CryptoJS.enc.Hex)
      .slice(8, 24);
  }

  async function fetchJson(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        cache: "no-store",
        credentials: "omit",
        ...options,
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
      }

      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async function fetchWithRetry(url, options = {}, retries = 2) {
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await fetchJson(url, options);
      } catch (error) {
        lastError = error;
        if (attempt < retries) {
          await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)));
        }
      }
    }

    throw lastError || new Error("弹幕请求失败");
  }

  async function readSettings() {
    try {
      const stored = await chrome.storage.local.get({
        [SETTINGS_KEY]: DEFAULT_SETTINGS
      });
      return normalizeSettings(stored[SETTINGS_KEY]);
    } catch (error) {
      console.warn("[Universal Danmaku] 读取设置失败：", error);
      return { ...DEFAULT_SETTINGS };
    }
  }

  function normalizeSettings(value) {
    const source = value && typeof value === "object" ? value : {};
    return {
      enabled: source.enabled !== false,
      platformEnabled: source.platformEnabled !== false,
      independentEnabled: source.independentEnabled !== false,
      opacity: clamp(Number(source.opacity) || DEFAULT_SETTINGS.opacity, 0.2, 1),
      fontScale: clamp(Number(source.fontScale) || DEFAULT_SETTINGS.fontScale, 0.6, 1.8),
      speed: clamp(Number(source.speed) || DEFAULT_SETTINGS.speed, 0.5, 2),
      area: [0.25, 0.5, 0.75, 1].includes(Number(source.area))
        ? Number(source.area)
        : DEFAULT_SETTINGS.area,
      maxOnScreen: clamp(
        Math.round(Number(source.maxOnScreen) || DEFAULT_SETTINGS.maxOnScreen),
        10,
        120
      )
    };
  }

  async function persistSettings(settings) {
    try {
      await chrome.storage.local.set({
        [SETTINGS_KEY]: normalizeSettings(settings)
      });
    } catch (error) {
      console.warn("[Universal Danmaku] 保存设置失败：", error);
    }
  }

  class DanmakuRenderer {
    constructor(video, layer, settings) {
      this.video = video;
      this.layer = layer;
      this.settings = normalizeSettings(settings);
      this.items = [];
      this.cursor = 0;
      this.lastMediaTime = -1;
      this.frameId = 0;
      this.destroyed = false;
      this.active = new Set();
      this.scrollLaneAvailableAt = [];
      this.topLaneAvailableAt = [];
      this.bottomLaneAvailableAt = [];

      this.handlePlay = this.handlePlay.bind(this);
      this.handlePause = this.handlePause.bind(this);
      this.handleSeeked = this.handleSeeked.bind(this);
      this.handleRateChange = this.handleRateChange.bind(this);
      this.handleVisibility = this.handleVisibility.bind(this);

      video.addEventListener("play", this.handlePlay);
      video.addEventListener("playing", this.handlePlay);
      video.addEventListener("pause", this.handlePause);
      video.addEventListener("waiting", this.handlePause);
      video.addEventListener("seeking", this.handlePause);
      video.addEventListener("seeked", this.handleSeeked);
      video.addEventListener("ratechange", this.handleRateChange);
      document.addEventListener("visibilitychange", this.handleVisibility);

      this.applySettings();
    }

    setItems(items) {
      this.items = Array.isArray(items) ? [...items].sort((a, b) => a.time - b.time) : [];
      this.seekTo(this.video.currentTime || 0);
    }

    addItem(item, renderNow = false) {
      if (!item) return;
      const insertAt = binarySearchByTime(this.items, item.time);
      this.items.splice(insertAt, 0, item);

      if (insertAt < this.cursor) this.cursor += 1;
      if (renderNow && this.settings.enabled) this.renderItem(item, this.video.currentTime || item.time);
    }

    setSettings(settings) {
      this.settings = normalizeSettings(settings);
      this.applySettings();
    }

    applySettings() {
      this.layer.hidden = !this.settings.enabled;
      this.layer.style.setProperty("--danmaku-opacity", String(this.settings.opacity));
      this.layer.style.setProperty("--danmaku-font-scale", String(this.settings.fontScale));
      this.layer.style.setProperty("--danmaku-area", `${this.settings.area * 100}%`);

      if (!this.settings.enabled) this.clear();
      else if (!this.video.paused) this.startLoop();
    }

    handlePlay() {
      this.resumeAnimations();
      this.startLoop();
    }

    handlePause() {
      this.pauseAnimations();
      this.stopLoop();
    }

    handleSeeked() {
      this.seekTo(this.video.currentTime || 0);
      if (!this.video.paused) this.handlePlay();
    }

    handleRateChange() {
      const rate = Math.max(0.1, Number(this.video.playbackRate) || 1);
      for (const entry of this.active) {
        entry.animation.playbackRate = rate;
      }
    }

    handleVisibility() {
      if (document.visibilityState === "hidden") this.handlePause();
      else if (!this.video.paused) this.handlePlay();
    }

    startLoop() {
      if (this.destroyed || this.frameId || !this.settings.enabled) return;

      const tick = () => {
        this.frameId = 0;
        if (this.destroyed || this.video.paused || !this.settings.enabled) return;

        const currentTime = Number(this.video.currentTime) || 0;
        if (this.lastMediaTime >= 0 && Math.abs(currentTime - this.lastMediaTime) > 1.5) {
          this.seekTo(currentTime);
        }

        this.dispatchUntil(currentTime + 0.08);
        this.lastMediaTime = currentTime;
        this.frameId = requestAnimationFrame(tick);
      };

      this.frameId = requestAnimationFrame(tick);
    }

    stopLoop() {
      if (!this.frameId) return;
      cancelAnimationFrame(this.frameId);
      this.frameId = 0;
    }

    seekTo(time) {
      this.clear();
      this.cursor = binarySearchByTime(this.items, Math.max(0, time - 0.06));
      this.lastMediaTime = time;
    }

    dispatchUntil(time) {
      while (this.cursor < this.items.length && this.items[this.cursor].time <= time) {
        const item = this.items[this.cursor];
        this.cursor += 1;

        if (item.time < time - 0.8) continue;
        if (item.source === "platform" && !this.settings.platformEnabled) continue;
        if (item.source === "independent" && !this.settings.independentEnabled) continue;
        this.renderItem(item, time);
      }
    }

    getGeometry(item) {
      const layerHeight = this.layer.clientHeight || 360;
      const areaHeight = Math.max(36, layerHeight * this.settings.area);
      const fontSize = clamp(item.size * this.settings.fontScale, 16, 52);
      const laneHeight = Math.max(25, Math.ceil(fontSize * 1.38));
      const laneCount = Math.max(1, Math.floor(areaHeight / laneHeight));
      return { layerHeight, areaHeight, fontSize, laneHeight, laneCount };
    }

    findLane(availability, laneCount, mediaTime, reserveFor) {
      while (availability.length < laneCount) availability.push(0);

      let bestLane = -1;
      let earliest = Infinity;

      for (let lane = 0; lane < laneCount; lane += 1) {
        const availableAt = Number(availability[lane]) || 0;

        if (availableAt <= mediaTime) {
          availability[lane] = mediaTime + reserveFor;
          return lane;
        }

        if (availableAt < earliest) {
          earliest = availableAt;
          bestLane = lane;
        }
      }

      if (bestLane < 0 || earliest > mediaTime + 0.8) return -1;
      availability[bestLane] = mediaTime + reserveFor;
      return bestLane;
    }

    renderItem(item, mediaTime) {
      if (this.active.size >= this.settings.maxOnScreen) return;
      if (!this.layer.isConnected || this.layer.hidden) return;

      const geometry = this.getGeometry(item);
      const isFixed = item.mode === "top" || item.mode === "bottom";
      const durationSeconds = isFixed
        ? 4.5 / this.settings.speed
        : 9 / this.settings.speed;
      const reserveFor = isFixed ? durationSeconds : Math.max(1.1, durationSeconds * 0.28);
      const availability = item.mode === "top"
        ? this.topLaneAvailableAt
        : item.mode === "bottom"
          ? this.bottomLaneAvailableAt
          : this.scrollLaneAvailableAt;
      const lane = this.findLane(
        availability,
        geometry.laneCount,
        mediaTime,
        reserveFor
      );

      if (lane < 0) return;

      const element = document.createElement("div");
      element.className = `danmaku-item danmaku-${item.mode}`;
      element.textContent = item.text;
      element.dataset.source = item.source;
      element.style.color = item.color;
      element.style.fontSize = `${geometry.fontSize}px`;
      element.style.opacity = String(this.settings.opacity);

      if (item.mode === "bottom") {
        const areaBottomInset = Math.max(0, geometry.layerHeight - geometry.areaHeight);
        element.style.bottom = `${
          areaBottomInset + Math.max(0, (geometry.laneCount - 1 - lane) * geometry.laneHeight)
        }px`;
      } else {
        element.style.top = `${lane * geometry.laneHeight}px`;
      }

      this.layer.appendChild(element);

      let animation;
      if (item.mode === "right") {
        const layerWidth = this.layer.clientWidth || 640;
        const elementWidth = element.getBoundingClientRect().width || item.text.length * geometry.fontSize;
        const distance = layerWidth + elementWidth + 24;
        const naturalDuration = clamp((distance / 150) * 1000, 5500, 15000);
        const duration = naturalDuration / this.settings.speed;

        animation = element.animate(
          [
            { transform: "translate3d(0, 0, 0)" },
            { transform: `translate3d(-${distance}px, 0, 0)` }
          ],
          { duration, easing: "linear", fill: "forwards" }
        );
      } else {
        animation = element.animate(
          [
            { opacity: this.settings.opacity, offset: 0 },
            { opacity: this.settings.opacity, offset: 0.78 },
            { opacity: 0, offset: 1 }
          ],
          {
            duration: (4500 / this.settings.speed),
            easing: "linear",
            fill: "forwards"
          }
        );
      }

      animation.playbackRate = Math.max(0.1, Number(this.video.playbackRate) || 1);
      if (this.video.paused) animation.pause();

      const entry = { element, animation };
      this.active.add(entry);

      const cleanup = () => {
        this.active.delete(entry);
        element.remove();
      };
      animation.addEventListener("finish", cleanup, { once: true });
      animation.addEventListener("cancel", cleanup, { once: true });
    }

    pauseAnimations() {
      for (const entry of this.active) entry.animation.pause();
    }

    resumeAnimations() {
      for (const entry of this.active) entry.animation.play();
      this.handleRateChange();
    }

    clear() {
      for (const entry of [...this.active]) {
        entry.animation.cancel();
        entry.element.remove();
      }
      this.active.clear();
      this.layer.replaceChildren();
      this.scrollLaneAvailableAt.length = 0;
      this.topLaneAvailableAt.length = 0;
      this.bottomLaneAvailableAt.length = 0;
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.stopLoop();
      this.clear();
      this.video.removeEventListener("play", this.handlePlay);
      this.video.removeEventListener("playing", this.handlePlay);
      this.video.removeEventListener("pause", this.handlePause);
      this.video.removeEventListener("waiting", this.handlePause);
      this.video.removeEventListener("seeking", this.handlePause);
      this.video.removeEventListener("seeked", this.handleSeeked);
      this.video.removeEventListener("ratechange", this.handleRateChange);
      document.removeEventListener("visibilitychange", this.handleVisibility);
    }
  }

  function showToast(elements, message, state = "info") {
    const toast = elements.toast;
    toast.textContent = String(message);
    toast.dataset.state = state;
    toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => {
      toast.hidden = true;
    }, state === "error" ? 4500 : 2600);
  }

  function updateToggleButton(elements, settings) {
    elements.toggleButton.classList.toggle("is-active", settings.enabled);
    elements.toggleButton.setAttribute("aria-pressed", String(settings.enabled));
    elements.toggleButton.title = settings.enabled ? "关闭弹幕" : "开启弹幕";
    elements.toggleButton.querySelector("span").textContent = settings.enabled ? "弹" : "弹幕关";
  }

  function updateCount(elements, counts) {
    const total = counts.platform + counts.independent;
    elements.count.textContent = `${total} 条`;
    elements.count.title = `平台弹幕 ${counts.platform} 条，独立弹幕 ${counts.independent} 条`;
  }

  function bindRangeOutput(input, output, formatter) {
    const update = () => {
      output.textContent = formatter(Number(input.value));
    };
    input.addEventListener("input", update);
    update();
  }

  async function createController({ video, sourceUrl, canonicalUrl, elements }) {
    let settings = await readSettings();
    let danmakuId = computeDanmakuId(canonicalUrl);
    let platformItems = [];
    let independentItems = [];
    let destroyed = false;
    let sending = false;
    let lastSentAt = 0;

    const renderer = new DanmakuRenderer(video, elements.layer, settings);

    function applySettingsFromPanel() {
      settings = normalizeSettings({
        ...settings,
        enabled: elements.toggleButton.getAttribute("aria-pressed") === "true",
        platformEnabled: elements.platformCheckbox.checked,
        independentEnabled: elements.independentCheckbox.checked,
        opacity: Number(elements.opacityInput.value),
        fontScale: Number(elements.fontScaleInput.value),
        speed: Number(elements.speedInput.value),
        area: Number(elements.areaSelect.value),
        maxOnScreen: Number(elements.densityInput.value)
      });
      renderer.setSettings(settings);
      updateToggleButton(elements, settings);
      void persistSettings(settings);
    }

    function populatePanel() {
      elements.platformCheckbox.checked = settings.platformEnabled;
      elements.independentCheckbox.checked = settings.independentEnabled;
      elements.opacityInput.value = String(settings.opacity);
      elements.fontScaleInput.value = String(settings.fontScale);
      elements.speedInput.value = String(settings.speed);
      elements.areaSelect.value = String(settings.area);
      elements.densityInput.value = String(settings.maxOnScreen);
      updateToggleButton(elements, settings);
    }

    async function load() {
      elements.count.textContent = "加载中";
      elements.reloadButton.disabled = true;
      platformItems = [];
      independentItems = [];

      const publicUrl = `${API_URL}?ac=dm&url=${encodeURIComponent(canonicalUrl)}`;
      const independentUrl = `${API_URL}?ac=dm&id=${encodeURIComponent(danmakuId)}`;

      const [platformResult, independentResult] = await Promise.allSettled([
        fetchWithRetry(publicUrl),
        fetchWithRetry(independentUrl)
      ]);

      if (destroyed) return;

      if (platformResult.status === "fulfilled") {
        platformItems = normalizeResponse(platformResult.value, "platform");
        const returnedId = String(platformResult.value?.name || "").trim();
        if (/^[0-9a-f]{16}$/i.test(returnedId) && returnedId !== danmakuId) {
          danmakuId = returnedId;
          try {
            const corrected = await fetchWithRetry(
              `${API_URL}?ac=dm&id=${encodeURIComponent(danmakuId)}`,
              {},
              1
            );
            independentItems = normalizeResponse(corrected, "independent");
          } catch (error) {
            console.warn("[Universal Danmaku] 使用服务端 ID 获取独立弹幕失败：", error);
          }
        }
      } else {
        console.warn("[Universal Danmaku] 平台弹幕加载失败：", platformResult.reason);
      }

      if (independentResult.status === "fulfilled" && independentItems.length === 0) {
        independentItems = normalizeResponse(independentResult.value, "independent");
      } else if (independentResult.status === "rejected") {
        console.warn("[Universal Danmaku] 独立弹幕加载失败：", independentResult.reason);
      }

      const merged = mergeDanmakuLists(platformItems, independentItems);
      renderer.setItems(merged);
      updateCount(elements, {
        platform: platformItems.length,
        independent: independentItems.length
      });
      elements.reloadButton.disabled = false;

      if (platformResult.status === "rejected" && independentResult.status === "rejected") {
        showToast(elements, "弹幕加载失败，可点击设置中的重新加载", "error");
      } else {
        showToast(
          elements,
          `已加载 ${platformItems.length} 条平台弹幕和 ${independentItems.length} 条独立弹幕`,
          "success"
        );
      }
    }

    async function send(text) {
      const normalizedText = String(text || "").trim().replace(/\s+/g, " ").slice(0, 80);
      if (!normalizedText) {
        showToast(elements, "请输入弹幕内容", "error");
        return false;
      }
      if (sending) return false;
      if (Date.now() - lastSentAt < 1500) {
        showToast(elements, "发送太快，请稍后再试", "error");
        return false;
      }

      sending = true;
      elements.sendButton.disabled = true;
      const color = normalizeHexColor(elements.colorInput.value);
      const size = `${normalizeFontSize(elements.sizeSelect.value, 24)}px`;
      const time = Math.max(0, Number(video.currentTime) || 0);

      try {
        const result = await fetchWithRetry(API_URL + "?ac=dm", {
          method: "POST",
          headers: {
            "Accept": "application/json",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            player: danmakuId,
            time: Number(time.toFixed(3)),
            text: normalizedText,
            color,
            size
          })
        }, 1);

        if (Number(result?.code) !== 23) {
          throw new Error(result?.message || result?.msg || `接口返回 ${String(result?.code)}`);
        }

        lastSentAt = Date.now();
        const localItem = Object.freeze({
          id: `local-${lastSentAt}`,
          time,
          mode: "right",
          color,
          size: normalizeFontSize(size),
          text: normalizedText,
          source: "independent",
          raw: null
        });
        independentItems.push(localItem);
        renderer.addItem(localItem, true);
        updateCount(elements, {
          platform: platformItems.length,
          independent: independentItems.length
        });
        showToast(elements, "弹幕发送成功", "success");
        return true;
      } catch (error) {
        console.error("[Universal Danmaku] 发送失败：", error);
        showToast(
          elements,
          `发送失败：${error instanceof Error ? error.message : String(error)}`,
          "error"
        );
        return false;
      } finally {
        sending = false;
        elements.sendButton.disabled = false;
      }
    }

    populatePanel();

    elements.toggleButton.addEventListener("click", () => {
      settings.enabled = !settings.enabled;
      renderer.setSettings(settings);
      updateToggleButton(elements, settings);
      void persistSettings(settings);
    });

    elements.settingsButton.addEventListener("click", () => {
      const willOpen = elements.settingsPanel.hidden;
      elements.settingsPanel.hidden = !willOpen;
      elements.settingsButton.classList.toggle("is-active", willOpen);
      elements.settingsButton.setAttribute("aria-expanded", String(willOpen));
    });

    elements.closeSettingsButton.addEventListener("click", () => {
      elements.settingsPanel.hidden = true;
      elements.settingsButton.classList.remove("is-active");
      elements.settingsButton.setAttribute("aria-expanded", "false");
    });

    for (const input of [
      elements.platformCheckbox,
      elements.independentCheckbox,
      elements.opacityInput,
      elements.fontScaleInput,
      elements.speedInput,
      elements.areaSelect,
      elements.densityInput
    ]) {
      input.addEventListener("input", applySettingsFromPanel);
      input.addEventListener("change", applySettingsFromPanel);
    }

    bindRangeOutput(elements.opacityInput, elements.opacityOutput, value => `${Math.round(value * 100)}%`);
    bindRangeOutput(elements.fontScaleInput, elements.fontScaleOutput, value => `${Math.round(value * 100)}%`);
    bindRangeOutput(elements.speedInput, elements.speedOutput, value => `${value.toFixed(1)}×`);
    bindRangeOutput(elements.densityInput, elements.densityOutput, value => `${Math.round(value)} 条`);

    elements.reloadButton.addEventListener("click", () => void load());

    elements.sendForm.addEventListener("submit", async event => {
      event.preventDefault();
      const sent = await send(elements.textInput.value);
      if (sent) elements.textInput.value = "";
    });

    elements.openComposerButton.addEventListener("click", () => {
      elements.composer.classList.toggle("is-open");
      if (elements.composer.classList.contains("is-open")) elements.textInput.focus();
    });

    elements.textInput.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        elements.composer.classList.remove("is-open");
        elements.textInput.blur();
      }
    });

    void load();

    return Object.freeze({
      get id() {
        return danmakuId;
      },
      get settings() {
        return { ...settings };
      },
      get counts() {
        return {
          platform: platformItems.length,
          independent: independentItems.length
        };
      },
      reload: load,
      send,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        renderer.destroy();
      }
    });
  }

  globalThis.EvanDanmaku = Object.freeze({
    createController,
    computeDanmakuId,
    normalizeResponse,
    mergeDanmakuLists,
    DEFAULT_SETTINGS
  });
})();
