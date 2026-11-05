"use strict";

/*
 * background.js 是唯一的 Service Worker。
 *
 * 加载：
 * 1. 网站识别规则
 * 2. 播放器初始化模块
 * 注意：firefox 的 background.js 不能直接 import module，必须通过 manifest.json 的 scripts 注入。
 */


/* =========================================================
 * 设置与替换记录
 * ======================================================= */

async function getSettings() {
  const {
    autoReplace = false,
    autoChange = false
  } = await browser.storage.local.get([
    "autoReplace",
    "autoChange"
  ]);

  return {
    autoReplace,
    autoChange
  };
}

/*
 * replacedTabItems 的统一格式：
 *
 * [
 *   {
 *     tabId: 123,
 *     url: "https://v.qq.com/x/cover/.../...html"
 *     // 保存可比较的页面键；无关查询参数会被移除。
 *   }
 * ]
 *
 * 同时兼容并迁移旧的 replacedTabIds、[tabId, url]，
 * 以及误存成 { tabId, tabUrl: Tab } 的记录。
 */
function normalizeReplacedTabItem(item) {
  if (Array.isArray(item)) {
    const [tabId, url] = item;

    if (
      Number.isInteger(tabId) &&
      typeof url === "string" &&
      url
    ) {
      return {
        tabId,
        url
      };
    }

    return null;
  }

  if (
    !item ||
    typeof item !== "object"
  ) {
    return null;
  }

  const tabId = item.tabId;
  const url =
    typeof item.url === "string"
      ? item.url
      : typeof item.tabUrl === "string"
        ? item.tabUrl
        : typeof item.tabUrl?.url === "string"
          ? item.tabUrl.url
          : "";

  if (
    !Number.isInteger(tabId) ||
    !url
  ) {
    return null;
  }

  return {
    tabId,
    url
  };
}

async function getReplacedTabItems() {
  const stored =
    await browser.storage.local.get([
      "replacedTabItems",
      "replacedTabIds"
    ]);

  const currentItems =
    Array.isArray(stored.replacedTabItems)
      ? stored.replacedTabItems
      : [];

  const legacyItems =
    Array.isArray(stored.replacedTabIds)
      ? stored.replacedTabIds
      : [];

  const normalizedByTabId = new Map();

  /* 旧数据先写，新数据后写，保证 replacedTabItems 优先。 */
  for (const rawItem of [
    ...legacyItems,
    ...currentItems
  ]) {
    const normalized =
      normalizeReplacedTabItem(rawItem);

    if (normalized) {
      normalizedByTabId.set(
        normalized.tabId,
        normalized
      );
    }
  }

  const normalizedItems =
    [...normalizedByTabId.values()];

  const currentSerialized =
    JSON.stringify(currentItems);
  const normalizedSerialized =
    JSON.stringify(normalizedItems);

  if (
    currentSerialized !==
      normalizedSerialized ||
    Object.prototype.hasOwnProperty.call(
      stored,
      "replacedTabIds"
    )
  ) {
    await browser.storage.local.set({
      replacedTabItems: normalizedItems
    });

    await browser.storage.local.remove(
      "replacedTabIds"
    );
  }

  return normalizedItems;
}

function findReplacedTabItem(
  items,
  tabId
) {
  return items.find(
    item => item.tabId === tabId
  ) ?? null;
}

let replacedTabMutationChain =
  Promise.resolve();

function mutateReplacedTabItems(mutator) {
  const operation = replacedTabMutationChain
    .catch(() => undefined)
    .then(async () => {
      const items =
        await getReplacedTabItems();

      const updatedItems =
        mutator(items);

      if (
        JSON.stringify(updatedItems) !==
        JSON.stringify(items)
      ) {
        await browser.storage.local.set({
          replacedTabItems: updatedItems
        });
      }

      return updatedItems;
    });

  replacedTabMutationChain = operation;
  return operation;
}

async function setReplacedTabItem(
  tabId,
  url
) {
  if (
    !Number.isInteger(tabId) ||
    typeof url !== "string" ||
    !url
  ) {
    return;
  }

  await mutateReplacedTabItems(items => [
    ...items.filter(
      item => item.tabId !== tabId
    ),
    {
      tabId,
      url
    }
  ]);
}

async function removeReplacedTabItem(
  tabId
) {
  if (!Number.isInteger(tabId)) {
    return;
  }

  await mutateReplacedTabItems(
    items => items.filter(
      item => item.tabId !== tabId
    )
  );
}

/* =========================================================
 * 消息类型
 * ======================================================= */

const MESSAGE_TYPES = Object.freeze({
  GET_CURRENT_PAGE: "VPR_GET_CURRENT_PAGE",
  INITIALIZE_PLAYER: "VPR_INITIALIZE_PLAYER",
  CURRENT_PAGE_CHANGED: "VPR_CURRENT_PAGE_CHANGED",
  HISTORY_GET_FOR_URL: "VPR_HISTORY_GET_FOR_URL",
  HISTORY_LIST: "VPR_HISTORY_LIST",
  HISTORY_UPSERT: "VPR_HISTORY_UPSERT",
  HISTORY_IMPORT: "VPR_HISTORY_IMPORT",
  HISTORY_DELETE: "VPR_HISTORY_DELETE",
  HISTORY_CLEAR: "VPR_HISTORY_CLEAR",
  STORAGE_STATUS: "VPR_STORAGE_STATUS"
});


/* =========================================================
 * 观看历史与存储容量
 * ======================================================= */

const WATCH_HISTORY_KEY = "watchHistory";
const STORAGE_WARNING_RATIO = 0.8;
const STORAGE_CRITICAL_RATIO = 0.95;
const DEFAULT_STORAGE_QUOTA = 10 * 1024 * 1024;
let watchHistoryMutationChain = Promise.resolve();

function normalizeHistoryUrl(urlString) {
  try {
    const url = new URL(urlString);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return `${url.origin}${url.pathname.replace(/\/$/, "") || "/"}`;
  } catch {
    return "";
  }
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function normalizeWatchHistoryItem(rawItem) {
  if (!rawItem || typeof rawItem !== "object") return null;

  const url = normalizeHistoryUrl(rawItem.url || rawItem.sourceUrl || "");
  if (!url) return null;

  const duration = Math.max(0, Number(rawItem.duration) || 0);
  const progress = clampNumber(rawItem.progress, 0, duration > 0 ? duration : Number.MAX_SAFE_INTEGER);
  const percent = duration > 0
    ? clampNumber((progress / duration) * 100, 0, 100)
    : clampNumber(rawItem.percent, 0, 100);
  const completed = Boolean(rawItem.completed) || (duration > 0 && percent >= 99.5);

  return {
    id: url,
    url,
    siteId: typeof rawItem.siteId === "string" ? rawItem.siteId : "unknown",
    progress: completed && duration > 0 ? duration : progress,
    duration,
    percent: completed ? 100 : percent,
    completed,
    title: typeof rawItem.title === "string" ? rawItem.title.trim() : "",
    episodeName: typeof rawItem.episodeName === "string" ? rawItem.episodeName.trim() : "",
    episodeIndex: rawItem.episodeIndex == null || rawItem.episodeIndex === ""
      ? null
      : (Number.isFinite(Number(rawItem.episodeIndex)) ? Number(rawItem.episodeIndex) : null),
    cover: typeof rawItem.cover === "string" ? rawItem.cover.trim() : "",
    updatedAt: Number.isFinite(Number(rawItem.updatedAt)) ? Number(rawItem.updatedAt) : Date.now()
  };
}

async function getWatchHistory() {
  const stored = await browser.storage.local.get({ [WATCH_HISTORY_KEY]: [] });
  const rawItems = Array.isArray(stored[WATCH_HISTORY_KEY]) ? stored[WATCH_HISTORY_KEY] : [];
  const byUrl = new Map();

  for (const rawItem of rawItems) {
    const item = normalizeWatchHistoryItem(rawItem);
    if (!item) continue;
    const previous = byUrl.get(item.url);
    if (!previous || item.updatedAt >= previous.updatedAt) byUrl.set(item.url, item);
  }

  const items = [...byUrl.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  // A read must not rewrite storage while another history mutation is in progress.
  return items;
}

function mutateWatchHistory(mutator) {
  const operation = watchHistoryMutationChain
    .catch(() => undefined)
    .then(async () => {
      const items = await getWatchHistory();
      const updated = await mutator(items.map(item => ({ ...item })));
      if (updated !== null) await browser.storage.local.set({ [WATCH_HISTORY_KEY]: updated });
      return updated;
    });
  watchHistoryMutationChain = operation;
  return operation;
}

async function getStorageStatus() {
  const local = browser.storage.local;
  let bytesInUse = NaN;
  try {
    if (typeof local.getBytesInUse === "function") {
      bytesInUse = Number(await local.getBytesInUse(null));
    }
  } catch {
    // Firefox before 144 does not support getBytesInUse for storage.local.
  }
  if (!Number.isFinite(bytesInUse)) {
    const values = await local.get(null);
    bytesInUse = new TextEncoder().encode(JSON.stringify(values)).byteLength;
  }
  const quotaBytes = Number(local.QUOTA_BYTES) || DEFAULT_STORAGE_QUOTA;
  const ratio = quotaBytes > 0 ? bytesInUse / quotaBytes : 0;
  return {
    bytesInUse,
    quotaBytes,
    ratio,
    percent: Math.min(100, ratio * 100),
    warning: ratio >= STORAGE_WARNING_RATIO,
    critical: ratio >= STORAGE_CRITICAL_RATIO
  };
}

async function upsertWatchHistory(rawItem, preserveUpdatedAt = false) {
  const normalized = normalizeWatchHistoryItem(rawItem);
  if (!normalized) throw new Error("历史记录 URL 无效");

  let savedItem = null;
  let disabled = false;
  await mutateWatchHistory(async items => {
    // Check inside the queue to preserve event order relative to clear/import.
    const settings = await browser.storage.local.get({ historyEnabled: true });
    if (!settings.historyEnabled) {
      disabled = true;
      return null;
    }
    const existing = items.find(item => item.url === normalized.url) || null;
    savedItem = {
      ...(existing || {}),
      ...normalized,
      title: normalized.title || existing?.title || "",
      episodeName: normalized.episodeName || existing?.episodeName || "",
      episodeIndex: normalized.episodeIndex ?? existing?.episodeIndex ?? null,
      cover: normalized.cover || existing?.cover || "",
      updatedAt: preserveUpdatedAt
        ? (existing?.updatedAt ?? normalized.updatedAt)
        : Date.now()
    };
    return [savedItem, ...items.filter(item => item.url !== normalized.url)]
      .sort((a, b) => b.updatedAt - a.updatedAt);
  });
  return { saved: !disabled, disabled, item: savedItem, storage: await getStorageStatus() };
}

const MAX_HISTORY_IMPORT_ITEMS = 20000;

async function importWatchHistory(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length > MAX_HISTORY_IMPORT_ITEMS) {
    throw new Error("Invalid history backup size");
  }

  // Validate everything before touching persistent storage.
  const incoming = new Map();
  for (let index = 0; index < rawItems.length; index++) {
    const raw = rawItems[index];
    if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
        typeof raw.url !== "string" || !Number.isFinite(raw.updatedAt) ||
        raw.updatedAt < 0) {
      throw new Error(`Invalid history record at index ${index + 1}`);
    }
    const item = normalizeWatchHistoryItem(raw);
    if (!item) throw new Error(`Invalid history record at index ${index + 1}`);
    const previous = incoming.get(item.url);
    if (!previous || item.updatedAt > previous.updatedAt) incoming.set(item.url, item);
  }

  const stats = { added: 0, updated: 0, skipped: rawItems.length - incoming.size };
  if (!incoming.size) return stats;

  // One serialized write instead of N full-array writes.
  await mutateWatchHistory(items => {
    const merged = new Map(items.map(item => [item.url, item]));
    for (const item of incoming.values()) {
      const existing = merged.get(item.url);
      if (!existing) {
        merged.set(item.url, item);
        stats.added++;
      } else if (item.updatedAt > existing.updatedAt) {
        merged.set(item.url, {
          ...existing,
          ...item,
          title: item.title || existing.title,
          episodeName: item.episodeName || existing.episodeName,
          episodeIndex: item.episodeIndex ?? existing.episodeIndex ?? null,
          cover: item.cover || existing.cover
        });
        stats.updated++;
      } else {
        stats.skipped++;
      }
    }
    return [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  });
  return stats;
}

async function deleteWatchHistory(urlString) {
  const url = normalizeHistoryUrl(urlString);
  if (!url) return false;
  let deleted = false;
  await mutateWatchHistory(items => {
    const updated = items.filter(item => item.url !== url);
    deleted = updated.length !== items.length;
    return updated;
  });
  return deleted;
}

async function clearWatchHistory() {
  await mutateWatchHistory(() => []);
  return true;
}

/* =========================================================
 * DNR 网络规则
 * ======================================================= */

const API_ORIGIN_RULE_ID = 1;
const HLS_NAVIGATION_HEADERS_RULE_ID = 2;

async function registerNetworkRules() {
  const rules = [
    {
      id: API_ORIGIN_RULE_ID,
      priority: 2,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          {
            header: "Origin",
            operation: "set",
            value: "https://jx.xmflv.com"
          }
        ]
      },
      condition: {
        requestDomains: [
          "cache.0567890.xyz"
        ],
        resourceTypes: [
          "xmlhttprequest"
        ],
        requestMethods: [
          "post",
          "options"
        ]
      }
    },
    {
      id: HLS_NAVIGATION_HEADERS_RULE_ID,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          {
            header: "Origin",
            operation: "remove"
          },
          {
            header: "Referer",
            operation: "remove"
          }
        ]
      },
      condition: {
        initiatorDomains: [
          new URL(browser.runtime.getURL("")).hostname
        ],
        requestDomains: [
          "cdn.hls.one",
          "s3.hls.one"
        ],
        resourceTypes: [
          "xmlhttprequest"
        ],
        requestMethods: [
          "get"
        ]
      }
    }
  ];

  try {
    await browser.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: rules.map(rule => rule.id),
      addRules: rules
    });

    console.log(
      "DNR 规则注册成功：",
      await browser.declarativeNetRequest.getDynamicRules()
    );
  } catch (error) {
    console.error(
      "DNR 规则注册失败：",
      error
    );
  }
}

void registerNetworkRules();
void getReplacedTabItems().catch(error => {
  console.warn(
    "[Universal Player] 替换记录迁移失败：",
    error
  );
});

browser.runtime.onInstalled.addListener(() => {
  void registerNetworkRules();
  void getReplacedTabItems().catch(error => {
    console.warn(
      "[Universal Player] 安装后迁移替换记录失败：",
      error
    );
  });
});

browser.runtime.onStartup.addListener(() => {
  void registerNetworkRules();
  void getReplacedTabItems().catch(error => {
    console.warn(
      "[Universal Player] 启动时迁移替换记录失败：",
      error
    );
  });
});

/*
 * onRuleMatchedDebug 只用于开发调试。
 */
if (
  browser.declarativeNetRequest
    ?.onRuleMatchedDebug
) {
  browser.declarativeNetRequest
    .onRuleMatchedDebug
    .addListener(info => {
      console.log("DNR 规则命中：", {
        ruleId: info.rule.ruleId,
        url: info.request.url,
        method: info.request.method,
        initiator: info.request.initiator,
        resourceType: info.request.type
      });
    });
}

/* =========================================================
 * 当前网页识别
 * ======================================================= */

function findRoute(urlString) {
  if (!urlString) {
    return null;
  }

  return (
    globalThis.VPR_SITE_ROUTES.find(route => {
      return route.matches(urlString);
    }) ?? null
  );
}

function getPageKey(
  urlString,
  route = findRoute(urlString)
) {
  if (!urlString) {
    return "";
  }

  if (
    route &&
    typeof route.getPageKey === "function"
  ) {
    try {
      return route.getPageKey(urlString);
    } catch {
      /* 降级为原始 URL。 */
    }
  }

  return urlString;
}

function createPageContext(tab) {
  const url = tab?.url || "";
  const route = findRoute(url);

  return {
    tabId: Number.isInteger(tab?.id)
      ? tab.id
      : null,
    url,
    pageKey: getPageKey(url, route),
    route
  };
}

function createPublicPageInfo(context) {
  if (
    !Number.isInteger(context?.tabId)
  ) {
    return {
      supported: false,
      mounted: false,
      tabId: null,
      url: "",
      siteId: null,
      siteName: "未知页面",
      siteNameKey: "sites.unknown",
      message: "无法读取当前标签页",
      messageKey: "runtime.CANNOT_READ_TAB",
      code: "CANNOT_READ_TAB"
    };
  }

  if (!context.route) {
    return {
      supported: false,
      mounted: false,
      tabId: context.tabId,
      url: context.url,
      siteId: null,
      siteName: "未匹配",
      siteNameKey: "sites.unmatched",
      message:
        "当前 URL 没有匹配到已安装的网站适配器",
      messageKey: "runtime.NO_ADAPTER",
      code: "NO_ADAPTER"
    };
  }

  return {
    supported: true,
    mounted: false,
    tabId: context.tabId,
    url: context.url,
    siteId: context.route.id,
    siteName: context.route.name,
    message: "当前网页符合替换条件",
    messageKey: "runtime.PAGE_ELIGIBLE",
    code: "PAGE_ELIGIBLE"
  };
}

async function createPublicPageInfoWithState(
  context
) {
  const pageInfo =
    createPublicPageInfo(context);

  if (
    !pageInfo.supported ||
    !Number.isInteger(context?.tabId)
  ) {
    return pageInfo;
  }

  const items =
    await getReplacedTabItems();

  const item = findReplacedTabItem(
    items,
    context.tabId
  );

  if (
    getPageKey(item?.url) !==
    context.pageKey
  ) {
    return pageInfo;
  }

  const actualStatus =
    await globalThis.VPR_INITIALIZER.getStatus(
      context.tabId,
      context.route
    );

  const mounted =
    actualStatus?.state === "mounted";

  /*
   * 页面刷新后 storage 可能仍有记录，但页面执行环境已经重建。
   * 实际未挂载时清掉过期记录，避免 popup 错误显示“已替换”。
   */
  if (!mounted) {
    await removeReplacedTabItem(
      context.tabId
    );
  }

  return {
    ...pageInfo,
    mounted
  };
}

async function getCurrentTab() {
  const tabs = await browser.tabs.query({
    active: true,
    lastFocusedWindow: true
  });

  return tabs[0] ?? null;
}

async function getCurrentPageContext() {
  const tab = await getCurrentTab();
  return createPageContext(tab);
}

async function getCurrentPageInfo() {
  const context =
    await getCurrentPageContext();

  return createPublicPageInfoWithState(
    context
  );
}

/* =========================================================
 * 播放器初始化入口
 * ======================================================= */

function initialization(
  tabId,
  route,
  options
) {
  return globalThis.VPR_INITIALIZER.execute(
    tabId,
    route,
    options
  );
}

async function initializePlayerForContext(
  context,
  mode
) {
  const pageInfo =
    createPublicPageInfo(context);

  if (
    !pageInfo.supported ||
    !Number.isInteger(context.tabId) ||
    !context.route
  ) {
    return {
      ok: false,
      state: "unsupported",
      code: "UNSUPPORTED_URL",
      ...pageInfo
    };
  }

  const result = await initialization(
    context.tabId,
    context.route,
    {
      mode
    }
  );

  let latestUrl = context.url;
  let latestContext = context;

  try {
    const latestTab =
      await browser.tabs.get(context.tabId);
    latestUrl = latestTab.url || "";
    latestContext = createPageContext(latestTab);
  } catch {
    latestUrl = "";
    latestContext = {
      ...context,
      url: "",
      pageKey: ""
    };
  }

  /*
   * 初始化过程中切换到另一个视频时，不把旧页面写入记录。
   * 仅查询参数发生变化不会被误判为换集，例如爱奇艺的 qyTrace。
   */
  const contextStillCurrent =
    latestContext.pageKey ===
    context.pageKey;

  if (result?.ok && contextStillCurrent) {
    if (result.state === "mounted") {
      await setReplacedTabItem(
        context.tabId,
        context.pageKey
      );
    } else if (
      result.state === "ready" ||
      result.action === "restored"
    ) {
      await removeReplacedTabItem(
        context.tabId
      );
    }
  }

  if (!contextStillCurrent) {
    return {
      ok: false,
      state: "stale",
      code: "URL_CHANGED_DURING_INITIALIZATION",
      message: "初始化期间页面 URL 已变化，已忽略旧结果",
      supported: true,
      mounted: false,
      tabId: context.tabId,
      url: latestUrl,
      siteId: context.route.id,
      siteName: context.route.name
    };
  }

  return {
    ...result,
    supported: true,
    mounted:
      result?.state === "mounted",
    tabId: context.tabId,
    url: context.url,
    siteId: context.route.id,
    siteName: context.route.name
  };
}

/*
 * 同一标签页的操作串行执行，避免 url/complete 两个事件或 popup
 * 点击同时触发两次初始化。
 */
const tabOperationChains = new Map();

function queuePlayerInitialization(
  context,
  mode
) {
  const tabId = context?.tabId;

  if (!Number.isInteger(tabId)) {
    return Promise.resolve({
      ok: false,
      state: "unsupported",
      code: "INVALID_TAB_ID",
      message: "找不到需要初始化的标签页"
    });
  }

  const existing =
    tabOperationChains.get(tabId) ??
    null;

  /*
   * 同一 URL 的重复自动请求直接复用现有 Promise。
   * url 和 complete 连续触发时不会进行两次 remount。
   */
  if (
    existing?.pageKey === context.pageKey &&
    (
      existing.mode === mode ||
      (
        existing.mode === "remount" &&
        mode === "ensure"
      )
    )
  ) {
    return existing.promise;
  }

  const previous =
    existing?.promise ??
    Promise.resolve();

  const operation = previous
    .catch(() => undefined)
    .then(async () => {
      let latestTab;

      try {
        latestTab = await browser.tabs.get(tabId);
      } catch {
        await removeReplacedTabItem(tabId);

        return {
          ok: false,
          state: "error",
          code: "TAB_CLOSED",
          message: "标签页已经关闭"
        };
      }

      const latestContext =
        createPageContext(latestTab);

      /*
       * 等待队列期间 URL 又发生变化时，丢弃旧任务，防止把旧视频
       * 的播放器挂到新页面。
       */
      if (
        latestContext.pageKey !==
        context.pageKey
      ) {
        return {
          ok: false,
          state: "stale",
          code: "STALE_PAGE_CONTEXT",
          message: "页面 URL 已变化，已取消旧的初始化任务",
          supported: Boolean(latestContext.route),
          mounted: false,
          tabId,
          url: latestContext.url,
          siteId: latestContext.route?.id ?? null,
          siteName: latestContext.route?.name ?? "未匹配"
        };
      }

      return initializePlayerForContext(
        latestContext,
        mode
      );
    });

  const entry = {
    pageKey: context.pageKey,
    mode,
    promise: null
  };

  const trackedOperation = operation.finally(() => {
    if (
      tabOperationChains.get(tabId) ===
      entry
    ) {
      tabOperationChains.delete(tabId);
    }
  });

  entry.promise = trackedOperation;
  tabOperationChains.set(tabId, entry);

  return trackedOperation;
}

async function initializeCurrentPlayer() {
  const context =
    await getCurrentPageContext();

  const pageInfo =
    createPublicPageInfo(context);

  if (
    !pageInfo.supported ||
    !Number.isInteger(context.tabId)
  ) {
    return {
      ok: false,
      state: "unsupported",
      code: "UNSUPPORTED_URL",
      ...pageInfo
    };
  }

  const items =
    await getReplacedTabItems();

  const trackedItem =
    findReplacedTabItem(
      items,
      context.tabId
    );

  /*
   * 当前 URL 与记录一致：按钮执行正常 toggle（恢复）。
   * 没有记录或 URL 已变化：按钮代表“开始替换”，需要确保旧播放器
   * 先被清理，再挂载当前 URL。
   */
  const mode =
    getPageKey(trackedItem?.url) ===
      context.pageKey
      ? "toggle"
      : "remount";

  return queuePlayerInitialization(
    context,
    mode
  );
}

/* =========================================================
 * 页面变化监听和自动初始化
 * ======================================================= */

async function runAutomaticPolicy(
  tab,
  trigger
) {
  if (!tab?.active) {
    return null;
  }

  const context =
    createPageContext(tab);

  if (
    !context.route ||
    !Number.isInteger(context.tabId)
  ) {
    return null;
  }

  const [
    settings,
    replacedItems
  ] = await Promise.all([
    getSettings(),
    getReplacedTabItems()
  ]);

  const trackedItem =
    findReplacedTabItem(
      replacedItems,
      context.tabId
    );

  const urlChanged =
    trackedItem &&
    getPageKey(trackedItem.url) !==
      context.pageKey;

  /*
   * 自动切换：
   * 已经替换过该 tab，但记录 URL 与当前 URL 不一致时，重新初始化。
   */
  if (
    settings.autoChange &&
    urlChanged
  ) {
    return queuePlayerInitialization(
      context,
      "remount"
    );
  }

  /*
   * 自动替换：
   * 该 tab 尚无替换记录时进行挂载。
   */
  if (
    settings.autoReplace &&
    !trackedItem
  ) {
    return queuePlayerInitialization(
      context,
      "remount"
    );
  }

  /*
   * 页面刷新后 storage 记录仍存在，但页面中的注入状态已经消失。
   * complete/activated 时用 ensure 恢复播放器；已挂载时不会重复重建。
   */
  if (
    settings.autoReplace &&
    getPageKey(trackedItem?.url) ===
      context.pageKey &&
    (
      trigger === "complete" ||
      trigger === "activated"
    )
  ) {
    return queuePlayerInitialization(
      context,
      "ensure"
    );
  }

  return null;
}

async function notifyCurrentPageChanged(tab) {
  if (!tab?.active) {
    return;
  }

  const context =
    createPageContext(tab);

  const pageInfo =
    await createPublicPageInfoWithState(
      context
    );

  try {
    await browser.runtime.sendMessage({
      type:
        MESSAGE_TYPES.CURRENT_PAGE_CHANGED,
      pageInfo
    });
  } catch {
    /* popup 未打开时没有接收方，属于正常情况。 */
  }
}

browser.tabs.onUpdated.addListener(
  (tabId, changeInfo, tab) => {
    const urlChanged =
      typeof changeInfo.url === "string";

    const loadCompleted =
      changeInfo.status === "complete";

    if (
      !urlChanged &&
      !loadCompleted
    ) {
      return;
    }

    if (!tab?.active) {
      return;
    }

    const trigger = loadCompleted
      ? "complete"
      : "url";

    void (async () => {
      await runAutomaticPolicy(
        tab,
        trigger
      );

      /*
       * 自动处理完成后再通知 popup，保证 mounted 状态来自最新记录。
       */
      let latestTab = tab;

      try {
        latestTab =
          await browser.tabs.get(tabId);
      } catch {
        return;
      }

      await notifyCurrentPageChanged(
        latestTab
      );
    })().catch(error => {
      console.error(
        "[Universal Player] 页面更新处理失败：",
        error
      );
    });
  }
);

browser.tabs.onActivated.addListener(
  activeInfo => {
    void (async () => {
      const tab =
        await browser.tabs.get(
          activeInfo.tabId
        );

      await runAutomaticPolicy(
        tab,
        "activated"
      );

      const latestTab =
        await browser.tabs.get(
          activeInfo.tabId
        );

      await notifyCurrentPageChanged(
        latestTab
      );
    })().catch(error => {
      console.warn(
        "[Universal Player] 获取活动标签页失败：",
        error
      );
    });
  }
);

/* =========================================================
 * popup 消息处理
 * ======================================================= */

browser.runtime.onMessage.addListener(
  (message, sender, sendResponse) => {
    if (
      !message ||
      typeof message !== "object"
    ) {
      return false;
    }

    if (
      message.type ===
      MESSAGE_TYPES.GET_CURRENT_PAGE
    ) {
      getCurrentPageInfo()
        .then(sendResponse)
        .catch(error => {
          sendResponse({
            supported: false,
            mounted: false,
            tabId: null,
            url: "",
            siteId: null,
            siteName: "未知页面",
            siteNameKey: "sites.unknown",
            message:
              error?.message ||
              String(error),
            messageKey: "runtime.CANNOT_READ_TAB",
            code: "CANNOT_READ_TAB"
          });
        });

      return true;
    }

    if (
      message.type ===
      MESSAGE_TYPES.INITIALIZE_PLAYER
    ) {
      initializeCurrentPlayer()
        .then(sendResponse)
        .catch(error => {
          sendResponse({
            ok: false,
            supported: false,
            mounted: false,
            state: "error",
            code: "INITIALIZATION_FAILED",
            message:
              error?.message ||
              String(error),
            messageKey: "runtime.INITIALIZATION_FAILED"
          });
        });

      return true;
    }

    if (message.type === MESSAGE_TYPES.HISTORY_GET_FOR_URL) {
      getWatchHistory()
        .then(items => sendResponse({
          ok: true,
          item: items.find(item => item.url === normalizeHistoryUrl(message.url)) || null
        }))
        .catch(error => sendResponse({ ok: false, message: error?.message || String(error) }));
      return true;
    }

    if (message.type === MESSAGE_TYPES.HISTORY_LIST) {
      Promise.all([getWatchHistory(), getStorageStatus()])
        .then(([items, storage]) => sendResponse({ ok: true, items, storage }))
        .catch(error => sendResponse({ ok: false, items: [], message: error?.message || String(error) }));
      return true;
    }

    if (message.type === MESSAGE_TYPES.HISTORY_UPSERT) {
      upsertWatchHistory(message.item, Boolean(message.preserveUpdatedAt))
        .then(result => sendResponse({ ok: true, ...result }))
        .catch(error => sendResponse({ ok: false, message: error?.message || String(error) }));
      return true;
    }

    if (message.type === MESSAGE_TYPES.HISTORY_IMPORT) {
      importWatchHistory(message.items)
        .then(stats => sendResponse({ ok: true, ...stats }))
        .catch(error => sendResponse({ ok: false, message: error?.message || String(error) }));
      return true;
    }

    if (message.type === MESSAGE_TYPES.HISTORY_DELETE) {
      deleteWatchHistory(message.url)
        .then(deleted => sendResponse({ ok: true, deleted }))
        .catch(error => sendResponse({ ok: false, message: error?.message || String(error) }));
      return true;
    }

    if (message.type === MESSAGE_TYPES.HISTORY_CLEAR) {
      clearWatchHistory()
        .then(() => sendResponse({ ok: true }))
        .catch(error => sendResponse({ ok: false, message: error?.message || String(error) }));
      return true;
    }

    if (message.type === MESSAGE_TYPES.STORAGE_STATUS) {
      getStorageStatus()
        .then(storage => sendResponse({ ok: true, storage }))
        .catch(error => sendResponse({ ok: false, message: error?.message || String(error) }));
      return true;
    }

    return false;
  }
);

/* =========================================================
 * 清理已经关闭的 tab
 * ======================================================= */

browser.tabs.onRemoved.addListener(tabId => {
  tabOperationChains.delete(tabId);

  void removeReplacedTabItem(tabId)
    .catch(error => {
      console.warn(
        "[Universal Player] 清理已关闭标签页失败：",
        error
      );
    });
});
