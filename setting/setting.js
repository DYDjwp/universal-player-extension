(() => {
  "use strict";
  const i18n = globalThis.VPR_I18N;
  const themeApi = globalThis.VPR_THEME;
  const ui = {
    autoReplace: document.getElementById("autoReplace"),
    autoChange: document.getElementById("autoChange"),
    historyEnabled: document.getElementById("historyEnabled"),
    languageSwitch: document.getElementById("languageSwitch"),
    languageOptions: [...document.querySelectorAll(".language-option")],
    themeSwitch: document.getElementById("themeSwitch"),
    themeOptions: [...document.querySelectorAll(".theme-option")],
    clearStorageButton: document.getElementById("clearStorageButton"),
    openHistoryButton: document.getElementById("openHistoryButton"),
    storageText: document.getElementById("storageText"),
    storageBadge: document.getElementById("storageBadge"),
    storageBar: document.getElementById("storageBar"),
    storageWarning: document.getElementById("storageWarning")
  };

  function formatBytes(bytes) {
    const units = ["B", "KB", "MB", "GB"];
    let value = Math.max(0, Number(bytes) || 0);
    let index = 0;
    while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
    return `${value.toFixed(index ? 1 : 0)} ${units[index]}`;
  }

  function syncChoiceButtons(buttons, activeValue, dataKey) {
    for (const button of buttons) {
      const selected = button.dataset[dataKey] === activeValue;
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-pressed", selected ? "true" : "false");
    }
  }

  function syncLanguageButtons(lang) {
    syncChoiceButtons(ui.languageOptions, i18n.normalizeLang(lang), "lang");
  }

  function syncThemeButtons(theme) {
    syncChoiceButtons(ui.themeOptions, themeApi.normalizeTheme(theme), "theme");
  }

  async function refreshStorageStatus() {
    const response = await browser.runtime.sendMessage({ type: "VPR_STORAGE_STATUS" });
    if (!response?.ok) throw new Error(response?.message || i18n.t("settings.storageReadError"));
    const status = response.storage;
    ui.storageText.textContent = i18n.t("settings.storageUsed", {
      used: formatBytes(status.bytesInUse),
      quota: formatBytes(status.quotaBytes)
    });
    ui.storageBadge.textContent = `${status.percent.toFixed(1)}%`;
    ui.storageBar.style.width = `${Math.min(100, status.percent)}%`;
    ui.storageWarning.hidden = !status.warning;
    ui.storageWarning.textContent = status.critical
      ? i18n.t("settings.storageCritical")
      : i18n.t("settings.storageWarning");
  }

  async function initialize() {
    const settings = await browser.storage.local.get({
      autoReplace: false,
      autoChange: false,
      historyEnabled: true,
      language: i18n.DEFAULT_LANG,
      theme: themeApi.DEFAULT_THEME
    });
    ui.autoReplace.checked = settings.autoReplace;
    ui.autoChange.checked = settings.autoChange;
    ui.historyEnabled.checked = settings.historyEnabled !== false;
    syncLanguageButtons(settings.language);
    syncThemeButtons(settings.theme);
    await refreshStorageStatus();
  }

  for (const [element, key] of [
    [ui.autoReplace, "autoReplace"],
    [ui.autoChange, "autoChange"],
    [ui.historyEnabled, "historyEnabled"]
  ]) {
    element.addEventListener("change", async () => {
      await browser.storage.local.set({ [key]: element.checked });
      await refreshStorageStatus();
    });
  }

  ui.languageSwitch.addEventListener("click", async event => {
    const button = event.target.closest(".language-option");
    if (!button || !ui.languageSwitch.contains(button)) return;
    const nextLang = button.dataset.lang;
    if (!nextLang || nextLang === i18n.getLang()) return;
    await i18n.setLanguage(nextLang);
    syncLanguageButtons(i18n.getLang());
    await refreshStorageStatus();
  });

  ui.themeSwitch.addEventListener("click", async event => {
    const button = event.target.closest(".theme-option");
    if (!button || !ui.themeSwitch.contains(button)) return;
    const nextTheme = button.dataset.theme;
    if (!nextTheme || nextTheme === themeApi.getTheme()) return;
    await themeApi.setTheme(nextTheme);
    syncThemeButtons(themeApi.getTheme());
  });

  ui.openHistoryButton.addEventListener("click", () => {
    browser.tabs.create({ url: browser.runtime.getURL("history/index.html") });
  });

  ui.clearStorageButton.addEventListener("click", async () => {
    if (!confirm(i18n.t("settings.clearConfirm"))) return;
    await browser.storage.local.clear();
    await browser.storage.local.set({
      historyEnabled: true,
      language: i18n.DEFAULT_LANG,
      theme: themeApi.DEFAULT_THEME
    });
    await themeApi.setTheme(themeApi.DEFAULT_THEME);
    await i18n.setLanguage(i18n.DEFAULT_LANG);
    syncLanguageButtons(i18n.DEFAULT_LANG);
    syncThemeButtons(themeApi.DEFAULT_THEME);
    await initialize();
    alert(i18n.t("settings.clearDone"));
  });

  Promise.all([themeApi.initTheme(), i18n.initI18n()])
    .then(() => initialize())
    .catch(error => {
      ui.storageText.textContent = error?.message || String(error);
    });
})();
