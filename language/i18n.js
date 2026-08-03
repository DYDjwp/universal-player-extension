(() => {
  "use strict";

  const DEFAULT_LANG = "zh-CN";
  const SUPPORTED = Object.freeze(["zh-CN", "en"]);
  const STORAGE_KEY = "language";

  let currentLang = DEFAULT_LANG;
  let messages = Object.create(null);

  function normalizeLang(lang) {
    if (lang === "en" || lang === "en-US") return "en";
    if (lang === "zh" || lang === "zh-CN" || lang === "zh-Hans") return "zh-CN";
    return SUPPORTED.includes(lang) ? lang : DEFAULT_LANG;
  }

  function has(key) {
    return typeof messages[key] === "string";
  }

  function t(key, vars) {
    let text = has(key) ? messages[key] : key;
    if (vars && typeof vars === "object") {
      for (const [name, value] of Object.entries(vars)) {
        text = text.replaceAll(`{${name}}`, String(value));
      }
    }
    return text;
  }

  function translateRuntime(info, fallbackKey, vars) {
    if (info?.messageKey && has(info.messageKey)) {
      return t(info.messageKey, vars);
    }
    if (info?.code) {
      const codeKey = `runtime.${info.code}`;
      if (has(codeKey)) return t(codeKey, vars);
    }
    if (fallbackKey && has(fallbackKey)) return t(fallbackKey, vars);
    return typeof info?.message === "string" && info.message
      ? info.message
      : fallbackKey
        ? t(fallbackKey, vars)
        : "";
  }

  function translateSiteName(pageInfo) {
    if (pageInfo?.siteId) {
      const key = `sites.${pageInfo.siteId}`;
      if (has(key)) return t(key);
    }
    if (pageInfo?.siteNameKey && has(pageInfo.siteNameKey)) {
      return t(pageInfo.siteNameKey);
    }
    return pageInfo?.siteName || t("sites.unknown");
  }

  async function loadLanguage(lang) {
    const code = normalizeLang(lang);
    const url = chrome.runtime.getURL(`language/${code}.json`);
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Failed to load language pack: ${code}`);
    }
    messages = await response.json();
    currentLang = code;
    document.documentElement.lang = code === "zh-CN" ? "zh-CN" : "en";
    return currentLang;
  }

  function applyTranslations(root = document) {
    const scope = root instanceof Document || root instanceof Element ? root : document;

    for (const el of scope.querySelectorAll("[data-i18n]")) {
      const key = el.getAttribute("data-i18n");
      if (!key) continue;
      const attr = el.getAttribute("data-i18n-attr");
      const value = t(key);
      if (attr) {
        el.setAttribute(attr, value);
      } else {
        el.textContent = value;
      }
    }

    for (const el of scope.querySelectorAll("[data-i18n-html]")) {
      const key = el.getAttribute("data-i18n-html");
      if (key) el.innerHTML = t(key);
    }

    const titleKey = document.documentElement.getAttribute("data-i18n-title");
    if (titleKey) document.title = t(titleKey);
  }

  async function getStoredLanguage() {
    const result = await chrome.storage.local.get({ [STORAGE_KEY]: DEFAULT_LANG });
    return normalizeLang(result[STORAGE_KEY]);
  }

  async function initI18n() {
    const lang = await getStoredLanguage();
    await loadLanguage(lang);
    applyTranslations();
    return currentLang;
  }

  async function setLanguage(lang) {
    const code = normalizeLang(lang);
    await chrome.storage.local.set({ [STORAGE_KEY]: code });
    await loadLanguage(code);
    applyTranslations();
    return currentLang;
  }

  globalThis.VPR_I18N = Object.freeze({
    DEFAULT_LANG,
    SUPPORTED,
    STORAGE_KEY,
    has,
    t,
    translateRuntime,
    translateSiteName,
    initI18n,
    setLanguage,
    loadLanguage,
    applyTranslations,
    getLang: () => currentLang,
    getStoredLanguage,
    normalizeLang
  });
})();
