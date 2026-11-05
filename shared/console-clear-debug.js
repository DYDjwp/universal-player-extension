(() => {
  "use strict";

  // Do not inject the console.clear interceptor for regular users.
  // Dynamic registration works in Chrome MV3 and Firefox 128+.
  const api = globalThis.browser || globalThis.chrome;
  const SCRIPT_ID = "vpr-console-clear-debug";
  const SETTING_KEY = "debugConsoleClear";
  const SCRIPT = {
    id: SCRIPT_ID,
    // The manifest grants HTTPS host access; do not register on other schemes.
    matches: ["https://*/*"],
    js: ["intercept-console-clear.js"],
    runAt: "document_start",
    world: "MAIN",
    allFrames: false,
    persistAcrossSessions: true
  };

  let pending = Promise.resolve();

  async function reconcileRegistration() {
    const settings = await api.storage.local.get({ [SETTING_KEY]: false });
    const enabled = settings[SETTING_KEY] === true;
    const registered = await api.scripting.getRegisteredContentScripts({
      ids: [SCRIPT_ID]
    });
    const exists = Array.isArray(registered) &&
      registered.some(script => script.id === SCRIPT_ID);

    if (enabled && !exists) {
      await api.scripting.registerContentScripts([SCRIPT]);
    } else if (!enabled && exists) {
      await api.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
    }
  }

  function synchronizeRegistration() {
    // Keep all registration updates in order, including rapid toggle changes.
    pending = pending.catch(() => undefined).then(reconcileRegistration);
    void pending.catch(error => {
      console.warn("[Universal Player] console.clear 调试开关同步失败：", error);
    });
    return pending;
  }

  api.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" &&
        Object.prototype.hasOwnProperty.call(changes, SETTING_KEY)) {
      void synchronizeRegistration();
    }
  });
  api.runtime.onInstalled.addListener(() => { void synchronizeRegistration(); });
  api.runtime.onStartup.addListener(() => { void synchronizeRegistration(); });

  // Reconcile immediately after a service-worker/background start. This
  // removes registrations left over from an earlier enabled session.
  void synchronizeRegistration();
})();
