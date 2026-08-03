(() => {
  "use strict";

  const DEFAULT_THEME = "black";
  const SUPPORTED = Object.freeze(["black", "white"]);
  const STORAGE_KEY = "theme";

  let currentTheme = DEFAULT_THEME;

  function normalizeTheme(theme) {
    return SUPPORTED.includes(theme) ? theme : DEFAULT_THEME;
  }

  function applyTheme(theme) {
    const value = normalizeTheme(theme);
    currentTheme = value;
    document.documentElement.setAttribute("data-theme", value);
    document.documentElement.style.colorScheme = value === "white" ? "light" : "dark";
    return value;
  }

  async function getStoredTheme() {
    const result = await chrome.storage.local.get({ [STORAGE_KEY]: DEFAULT_THEME });
    return normalizeTheme(result[STORAGE_KEY]);
  }

  async function initTheme() {
    const theme = await getStoredTheme();
    return applyTheme(theme);
  }

  async function setTheme(theme) {
    const value = normalizeTheme(theme);
    await chrome.storage.local.set({ [STORAGE_KEY]: value });
    return applyTheme(value);
  }

  globalThis.VPR_THEME = Object.freeze({
    DEFAULT_THEME,
    SUPPORTED,
    STORAGE_KEY,
    normalizeTheme,
    applyTheme,
    getStoredTheme,
    initTheme,
    setTheme,
    getTheme: () => currentTheme
  });
})();
