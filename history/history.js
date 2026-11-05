(() => {
  "use strict";
  const i18n = globalThis.VPR_I18N;
  const ui = {
    list: document.getElementById("historyList"),
    summary: document.getElementById("summary"),
    clearAll: document.getElementById("clearAllButton"),
    storageBadge: document.getElementById("storageBadge"),
    storageWarning: document.getElementById("storageWarning")
  };


  function canonicalizeUrl(urlString) {
    try {
      const url = new URL(urlString);
      return `${url.origin}${url.pathname.replace(/\/$/, "") || "/"}`;
    } catch {
      return urlString;
    }
  }

  function episodeNumberFromName(name) {
    const match = String(name || "").match(/第\s*(\d+)\s*集|(?:^|\D)(\d+)(?:\D|$)/);
    return match ? Number(match[1] || match[2]) : null;
  }

  async function exportHistory() {
    const response = await chrome.runtime.sendMessage({
      type: "VPR_HISTORY_LIST"
    });

    if (!response?.ok) {
      throw new Error(
        response?.message || i18n.t("history.loadFailed")
      );
    }

    const items = Array.isArray(response.items)
      ? response.items
      : [];

    const backup = {
      format: "universal-player-history",
      schemaVersion: 1,
      extensionVersion: chrome.runtime.getManifest().version,
      exportedAt: new Date().toISOString(),
      items
    };

    const json = JSON.stringify(backup, null, 2);

    const blob = new Blob([json], {
      type: "application/json;charset=utf-8"
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-");

    link.href = url;
    link.download = `vpr_history_${timestamp}.json`;
    link.style.display = "none";

    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 60000);
  }

  async function fetchMetadata(item) {
    try {
      const response = await fetch(
        `https://dmku.hls.one/?ac=list&url=${encodeURIComponent(canonicalizeUrl(item.url))}`,
        { cache: "no-store" }
      );
      if (!response.ok) return false;
      const data = await response.json();
      if (Number(data?.vod_code) !== 200) return false;
      const episode = (Array.isArray(data.vod_episodes) ? data.vod_episodes : [])
        .find(entry => canonicalizeUrl(entry?.url || "") === canonicalizeUrl(item.url));
      const episodeName = typeof episode?.name === "string" ? episode.name.trim() : item.episodeName;
      const updated = {
        ...item,
        title: typeof data.vod_title === "string" && data.vod_title.trim() ? data.vod_title.trim() : item.title,
        episodeName,
        episodeIndex: episodeNumberFromName(episodeName) ?? item.episodeIndex
      };
      await chrome.runtime.sendMessage({
        type: "VPR_HISTORY_UPSERT",
        item: updated,
        preserveUpdatedAt: true
      });
      return true;
    } catch {
      return false;
    }
  }

  async function hydrateMissingMetadata(items) {
    const pending = items.filter(item => !item.title || !item.episodeName);
    if (!pending.length) return false;
    let cursor = 0;
    let changed = false;
    const workers = Array.from({ length: Math.min(3, pending.length) }, async () => {
      while (cursor < pending.length) {
        const item = pending[cursor++];
        if (await fetchMetadata(item)) changed = true;
      }
    });
    await Promise.all(workers);
    return changed;
  }

  function formatTime(seconds) {
    const value = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(value / 3600), m = Math.floor((value % 3600) / 60), s = value % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  }
  function formatDate(timestamp) {
    const locale = i18n.getLang() === "en" ? "en-US" : "zh-CN";
    return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(timestamp));
  }
  function fallbackTitle(item) {
    try {
      const url = new URL(item.url);
      return `${url.hostname}${url.pathname}`;
    } catch {
      return i18n.t("history.untitled");
    }
  }
  function sortEpisodes(a, b) {
    const ai = Number.isFinite(a.episodeIndex) ? a.episodeIndex : Number.MAX_SAFE_INTEGER;
    const bi = Number.isFinite(b.episodeIndex) ? b.episodeIndex : Number.MAX_SAFE_INTEGER;
    return ai - bi || b.updatedAt - a.updatedAt;
  }

  function render(items, storage) {
    ui.list.replaceChildren();
    ui.summary.textContent = i18n.t("history.summary", { count: items.length });
    ui.storageBadge.textContent = i18n.t("history.storageBadge", {
      percent: storage.percent.toFixed(1)
    });
    ui.storageWarning.hidden = !storage.warning;
    ui.storageWarning.textContent = storage.critical
      ? i18n.t("history.storageCritical")
      : i18n.t("history.storageWarning");

    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = i18n.t("history.empty");
      ui.list.appendChild(empty);
      return;
    }

    const groups = new Map();
    for (const item of items) {
      const title = item.title || fallbackTitle(item);
      if (!groups.has(title)) groups.set(title, []);
      groups.get(title).push(item);
    }

    for (const [title, episodes] of groups) {
      episodes.sort(sortEpisodes);
      const group = document.createElement("section");
      group.className = "series-group";
      const heading = document.createElement("div");
      heading.className = "series-heading";
      heading.innerHTML = `<h2></h2><span></span>`;
      heading.querySelector("h2").textContent = title;
      heading.querySelector("span").textContent = i18n.t("history.episodeCount", {
        count: episodes.length
      });
      const grid = document.createElement("div");
      grid.className = "episode-grid";

      for (const item of episodes) {
        const card = document.createElement("article");
        card.className = "history-card";
        card.tabIndex = 0;
        const episodeLabel = item.episodeName
          || (item.episodeIndex ? i18n.t("history.episodeN", { n: item.episodeIndex }) : i18n.t("history.videoRecord"));
        const percent = item.completed ? 100 : Math.max(0, Math.min(100, Number(item.percent) || 0));
        const deleteLabel = i18n.t("history.deleteRecord");
        card.innerHTML = `
          <button class="delete-button" type="button">×</button>
          <div class="cover-wrap">
            <div class="cover-placeholder"></div>
            <span class="percent-badge"></span>
          </div>
          <div class="card-body">
            <h3 class="episode-title"></h3>
            <span class="url"></span>
            <div class="progress-row"><span></span><span></span></div>
            <div class="progress-track"><span></span></div>
          </div>`;
        const placeholder = card.querySelector(".cover-placeholder");
        if (item.cover) {
          const image = document.createElement("img");
          image.alt = "";
          placeholder.replaceWith(image);
        } else if (placeholder) {
          placeholder.textContent = i18n.t("history.noCover");
        }
        const deleteButton = card.querySelector(".delete-button");
        deleteButton.title = deleteLabel;
        deleteButton.setAttribute("aria-label", deleteLabel);
        card.querySelector(".progress-track span").style.width = `${percent}%`;
        card.querySelector(".percent-badge").textContent = item.completed
          ? i18n.t("history.completed")
          : `${percent.toFixed(0)}%`;
        card.querySelector(".episode-title").textContent = episodeLabel;
        card.querySelector(".url").textContent = item.url;
        const progressSpans = card.querySelectorAll(".progress-row span");
        progressSpans[0].textContent = `${formatTime(item.progress)} / ${formatTime(item.duration)}`;
        progressSpans[1].textContent = formatDate(item.updatedAt);
        const image = card.querySelector("img");
        if (image) { image.src = item.cover; image.alt = `${title} ${episodeLabel}`; }
        const open = () => chrome.tabs.create({ url: item.url });
        card.addEventListener("click", open);
        card.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") open(); });
        card.querySelector(".delete-button").addEventListener("click", async event => {
          event.stopPropagation();
          await chrome.runtime.sendMessage({ type: "VPR_HISTORY_DELETE", url: item.url });
          await load();
        });
        grid.appendChild(card);
      }
      group.append(heading, grid);
      ui.list.appendChild(group);
    }
  }

  async function load(allowHydration = true) {
    const response = await chrome.runtime.sendMessage({ type: "VPR_HISTORY_LIST" });
    if (!response?.ok) throw new Error(response?.message || i18n.t("history.loadFailed"));
    const items = response.items || [];
    render(items, response.storage);
    if (allowHydration && await hydrateMissingMetadata(items)) {
      await load(false);
    }
  }

  ui.clearAll.addEventListener("click", async () => {
    if (!confirm(i18n.t("history.clearConfirm"))) return;
    await chrome.runtime.sendMessage({ type: "VPR_HISTORY_CLEAR" });
    await load();
  });

  document.getElementById("exportHistoryDatas").addEventListener("click", async () => {
    try {
      await exportHistory();
    } catch (error) {
      alert(error?.message || String(error));
    }
  });

  document.getElementById("importHistoryDatas").addEventListener("change", async event => {
    const input = event.target;
    if (!input.files?.length || input.disabled) return;
    const file = input.files[0];
    input.disabled = true;
    try {
      if (file.size > 10 * 1024 * 1024) {
        throw new Error(i18n.t("history.importFileTooLarge"));
      }
      const data = JSON.parse(await file.text());
      if (data?.format !== "universal-player-history" ||
          data.schemaVersion !== 1 || !Array.isArray(data.items)) {
        throw new Error(i18n.t("history.importFailed"));
      }
      const response = await chrome.runtime.sendMessage({
        type: "VPR_HISTORY_IMPORT",
        items: data.items
      });
      if (!response?.ok) {
        throw new Error(response?.message || i18n.t("history.importFailed"));
      }
      await load(false);
      alert(i18n.t("history.importSuccess", {
        added: response.added,
        updated: response.updated,
        skipped: response.skipped
      }));
    } catch (error) {
      alert(error?.message || String(error));
    } finally {
      input.value = "";
      input.disabled = false;
    }
  });

  Promise.all([
    globalThis.VPR_THEME.initTheme(),
    i18n.initI18n()
  ])
    .then(() => load())
    .catch(error => {
      ui.summary.textContent = error?.message || String(error);
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = i18n.t("history.readFailed");
      ui.list.replaceChildren(empty);
    });
})();
