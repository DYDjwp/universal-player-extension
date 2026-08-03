(() => {
  "use strict";

  const PNG_SIGNATURE = Object.freeze([
    0x89, 0x50, 0x4e, 0x47,
    0x0d, 0x0a, 0x1a, 0x0a
  ]);
  const TS_PACKET_SIZE = 188;
  const TS_SYNC_CHECKS = 5;
  const MAX_RETRIES = 3;
  const FETCH_HEADER_TIMEOUT_MS = 15000;
  const INSPECTION_PREFIX_BYTES = 16 * 1024;
  const SEGMENT_TIMEOUT_MS = 18000;
  const STARTUP_BUFFER_SECONDS = 32;
  const FORWARD_BUFFER_SECONDS = 100;
  const PREFETCH_BUFFER_SECONDS = 140;
  const PREFETCH_CONCURRENCY = 3;
  const MAX_PREFETCH_SEGMENTS = 14;
  const MAX_SEGMENT_FAILURE_ROUNDS = 3;
  const BACK_BUFFER_SECONDS = 60;
  const SEEK_BACKTRACK_SEGMENTS = 2;
  const SEEK_BACKTRACK_SECONDS = 10;
  const SEEK_PRIORITY_SEGMENTS = 6;
  const SEEK_PREFETCH_CONCURRENCY = 4;
  const SEEK_TIME_EPSILON = 0.15;
  const SEEK_WATCHDOG_INTERVAL_MS = 900;
  const SOURCE_BUFFER_STATE_RETRY_MS = 20;
  const SOURCE_BUFFER_STATE_TIMEOUT_MS = 1500;
  const MSE_PUMP_INTERVAL_MS = 350;
  const MSE_TS_MIME_CANDIDATES = Object.freeze([
    'video/mp2t; codecs="avc1.42E01E, mp4a.40.2"',
    'video/mp2t; codecs="avc1.4D401F, mp4a.40.2"',
    'video/mp2t; codecs="avc1.640028, mp4a.40.2"',
    'video/mp2t; codecs="avc1.42E01E"'
  ]);
  const RETRYABLE_STATUS = new Set([
    408, 425, 429, 500, 502, 503, 504
  ]);
  const HARD_MISSING_STATUS = new Set([404, 410]);
  const HARD_MISSING_GATEWAY_REFRESHES = 1;
  const HARD_MISSING_RETRY_COOLDOWN_MS = 15000;
  const HLS_ONE_REDIRECT_HOST = "cdn.hls.one";
  const RESOLVED_ROUTE_TTL_MS = 20 * 60 * 1000;
  const MAX_RESOLVED_ROUTES = 512;
  const resolvedRouteCache = new Map();
  const routeHostHealth = new Map();

  function uniqueUrls(urls) {
    return [...new Set(urls.filter(Boolean))];
  }

  function isHttpUrl(url) {
    try {
      const protocol = new URL(url).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }

  function isRedirectGatewayUrl(url) {
    try {
      return new URL(url).hostname.toLowerCase() === HLS_ONE_REDIRECT_HOST;
    } catch {
      return false;
    }
  }

  function getRouteHost(url) {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return "";
    }
  }

  function trimResolvedRouteCache() {
    while (resolvedRouteCache.size > MAX_RESOLVED_ROUTES) {
      const oldestKey = resolvedRouteCache.keys().next().value;

      if (oldestKey === undefined) {
        break;
      }

      resolvedRouteCache.delete(oldestKey);
    }
  }

  function rememberResolvedRoute(originalUrl, resolvedUrl) {
    if (
      !isHttpUrl(originalUrl) ||
      !isHttpUrl(resolvedUrl) ||
      originalUrl === resolvedUrl
    ) {
      return false;
    }

    resolvedRouteCache.delete(originalUrl);
    resolvedRouteCache.set(originalUrl, {
      url: resolvedUrl,
      updatedAt: Date.now()
    });
    trimResolvedRouteCache();
    return true;
  }

  function forgetResolvedRoute(originalUrl, resolvedUrl = null) {
    const cached = resolvedRouteCache.get(originalUrl);

    if (!cached) {
      return;
    }

    if (!resolvedUrl || cached.url === resolvedUrl) {
      resolvedRouteCache.delete(originalUrl);
    }
  }

  function getResolvedSegmentUrl(url) {
    const cached = resolvedRouteCache.get(url);

    if (!cached) {
      return null;
    }

    if (Date.now() - cached.updatedAt > RESOLVED_ROUTE_TTL_MS) {
      resolvedRouteCache.delete(url);
      return null;
    }

    // 更新 Map 顺序，优先保留最近使用的映射。
    resolvedRouteCache.delete(url);
    resolvedRouteCache.set(url, cached);
    return cached.url;
  }

  // 兼容旧版外部调用；不再假设最终地址固定为 s3.hls.one。
  function getHlsOneStorageUrl(url) {
    return getResolvedSegmentUrl(url);
  }

  function getHostHealth(url) {
    const host = getRouteHost(url);

    if (!host) {
      return null;
    }

    let health = routeHostHealth.get(host);

    if (!health) {
      health = {
        failureStreak: 0,
        cooldownUntil: 0,
        latencyMs: 0,
        successes: 0
      };
      routeHostHealth.set(host, health);
    }

    return health;
  }

  function markRouteSuccess(url, latencyMs) {
    const health = getHostHealth(url);

    if (!health) {
      return;
    }

    health.failureStreak = Math.max(0, health.failureStreak - 2);
    health.cooldownUntil = 0;
    health.successes += 1;

    if (Number.isFinite(latencyMs) && latencyMs >= 0) {
      health.latencyMs = health.latencyMs > 0
        ? health.latencyMs * 0.7 + latencyMs * 0.3
        : latencyMs;
    }
  }

  function markRouteFailure(url, status = 0) {
    const health = getHostHealth(url);

    if (!health) {
      return;
    }

    health.failureStreak = Math.min(8, health.failureStreak + 1);

    if ([429, 500, 502, 503, 504].includes(status)) {
      const cooldown = Math.min(
        250 * 2 ** Math.max(0, health.failureStreak - 1),
        4000
      );
      health.cooldownUntil = Math.max(
        health.cooldownUntil,
        Date.now() + cooldown
      );
    }
  }

  function routeScore(url, originalUrl) {
    const health = getHostHealth(url);
    const cooldown = health
      ? Math.max(0, health.cooldownUntil - Date.now())
      : 0;
    const failurePenalty = (health?.failureStreak || 0) * 1000;
    const latencyPenalty = Math.min(health?.latencyMs || 0, 2000);
    const gatewayPenalty = url === originalUrl && isRedirectGatewayUrl(url)
      ? 120
      : 0;

    return cooldown * 10 + failurePenalty + latencyPenalty + gatewayPenalty;
  }

  function orderRequestCandidates(urls, originalUrl) {
    return uniqueUrls(urls).sort((left, right) => {
      const scoreDifference =
        routeScore(left, originalUrl) - routeScore(right, originalUrl);

      if (scoreDifference !== 0) {
        return scoreDifference;
      }

      if (left === originalUrl) {
        return 1;
      }

      if (right === originalUrl) {
        return -1;
      }

      return 0;
    });
  }

  function getSegmentRequestCandidates(url, preferResolved = true) {
    const resolvedUrl = getResolvedSegmentUrl(url);

    if (!resolvedUrl) {
      return [url];
    }

    return preferResolved
      ? orderRequestCandidates([resolvedUrl, url], url)
      : uniqueUrls([url, resolvedUrl]);
  }

  function throwIfAborted(signal) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException("操作已取消", "AbortError");
    }
  }

  function sleep(milliseconds, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, milliseconds);

      if (!signal) {
        return;
      }

      const onAbort = () => {
        clearTimeout(timer);
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new DOMException("操作已取消", "AbortError")
        );
      };

      if (signal.aborted) {
        onAbort();
        return;
      }

      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  function retryDelay(attemptIndex, retryAfterValue, options = {}) {
    const retryAfterSeconds = Number(retryAfterValue);

    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
      return Math.min(retryAfterSeconds * 1000, 5000);
    }

    let delays;

    if (options.switchingRoute) {
      // 已经拿到新的最终域名时立即切线，不额外等待。
      delays = [35, 90, 220];
    } else if (options.urgent) {
      // 播放头附近的关键分片优先恢复，避免 502 直接造成卡顿。
      delays = [120, 320, 760];
    } else {
      // 远端预取可以稍微退避，避免多个并发同时轰击故障节点。
      delays = [220, 650, 1450];
    }

    return delays[Math.min(attemptIndex, delays.length - 1)] +
      Math.floor(Math.random() * (options.switchingRoute ? 35 : 120));
  }

  function isPng(bytes) {
    return (
      bytes.length >= PNG_SIGNATURE.length &&
      PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
    );
  }

  function readAscii(bytes, offset, length) {
    if (offset < 0 || offset + length > bytes.length) {
      return "";
    }

    let result = "";

    for (let index = 0; index < length; index += 1) {
      result += String.fromCharCode(bytes[offset + index]);
    }

    return result;
  }

  function findPngEnd(bytes) {
    if (!isPng(bytes)) {
      return -1;
    }

    const view = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength
    );
    let offset = PNG_SIGNATURE.length;

    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset, false);
      const chunkType = readAscii(bytes, offset + 4, 4);
      const chunkEnd = offset + 12 + length;

      if (chunkEnd > bytes.length) {
        return -1;
      }

      if (chunkType === "IEND") {
        return chunkEnd;
      }

      offset = chunkEnd;
    }

    return -1;
  }

  function findTsOffset(bytes, start = 0, scanLimit = bytes.length) {
    const lastPossible = Math.min(
      bytes.length - TS_PACKET_SIZE * TS_SYNC_CHECKS,
      scanLimit
    );

    for (let offset = Math.max(0, start); offset <= lastPossible; offset += 1) {
      let matches = 0;

      for (let index = 0; index < TS_SYNC_CHECKS; index += 1) {
        if (bytes[offset + index * TS_PACKET_SIZE] === 0x47) {
          matches += 1;
        }
      }

      if (matches === TS_SYNC_CHECKS) {
        return offset;
      }
    }

    return -1;
  }

  function findMp4Offset(bytes, start = 0, scanLength = 4096) {
    const end = Math.min(bytes.length - 8, start + scanLength);

    for (let offset = Math.max(0, start); offset <= end; offset += 1) {
      const boxType = readAscii(bytes, offset + 4, 4);

      if (
        boxType === "ftyp" ||
        boxType === "styp" ||
        boxType === "moof"
      ) {
        return offset;
      }
    }

    return -1;
  }

  function inspectMediaBytes(input) {
    const bytes = input instanceof Uint8Array
      ? input
      : new Uint8Array(input);
    const directTsOffset = findTsOffset(bytes, 0, 1);

    if (directTsOffset === 0) {
      return {
        kind: "direct-ts",
        wrapped: false,
        mediaOffset: 0,
        mimeType: "video/mp2t",
        bytes
      };
    }

    const directMp4Offset = findMp4Offset(bytes, 0, 32);

    if (directMp4Offset === 0) {
      return {
        kind: "direct-fmp4",
        wrapped: false,
        mediaOffset: 0,
        mimeType: "video/mp4",
        bytes
      };
    }

    const pngEnd = findPngEnd(bytes);

    if (pngEnd >= 0 && pngEnd < bytes.length) {
      const scanEnd = Math.min(bytes.length, pngEnd + 8192);
      const tsOffset = findTsOffset(bytes, pngEnd, scanEnd);

      if (tsOffset >= 0) {
        return {
          kind: "png-ts",
          wrapped: true,
          pngEnd,
          mediaOffset: tsOffset,
          mimeType: "video/mp2t",
          bytes: bytes.subarray(tsOffset)
        };
      }

      const mp4Offset = findMp4Offset(bytes, pngEnd, 8192);

      if (mp4Offset >= 0) {
        return {
          kind: "png-fmp4",
          wrapped: true,
          pngEnd,
          mediaOffset: mp4Offset,
          mimeType: "video/mp4",
          bytes: bytes.subarray(mp4Offset)
        };
      }

      return {
        kind: "png-without-media",
        wrapped: false,
        pngEnd,
        mediaOffset: -1,
        mimeType: "image/png",
        bytes
      };
    }

    return {
      kind: "unknown",
      wrapped: false,
      mediaOffset: 0,
      mimeType: "application/octet-stream",
      bytes
    };
  }

  function createAttemptSignal(parentSignal, timeoutMs) {
    const controller = new AbortController();
    let timer = null;

    const onParentAbort = () => {
      controller.abort(
        parentSignal.reason instanceof Error
          ? parentSignal.reason
          : new DOMException("操作已取消", "AbortError")
      );
    };

    if (parentSignal) {
      if (parentSignal.aborted) {
        onParentAbort();
      } else {
        parentSignal.addEventListener("abort", onParentAbort, { once: true });
      }
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        controller.abort(
          new DOMException("服务器响应超时", "TimeoutError")
        );
      }, timeoutMs);
    }

    return {
      signal: controller.signal,
      dispose() {
        if (timer !== null) {
          clearTimeout(timer);
        }

        parentSignal?.removeEventListener("abort", onParentAbort);
      }
    };
  }

  async function fetchResponse(url, options = {}) {
    let lastError = null;
    let lastStatus = 0;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      throwIfAborted(options.signal);
      const attemptSignal = createAttemptSignal(
        options.signal,
        options.timeoutMs ?? FETCH_HEADER_TIMEOUT_MS
      );

      try {
        const response = await fetch(url, {
          method: "GET",
          cache: options.cache || "default",
          credentials: "omit",
          redirect: "follow",
          referrerPolicy: "no-referrer",
          signal: attemptSignal.signal,
          headers: options.headers
        });

        attemptSignal.dispose();
        lastStatus = response.status;

        if (response.ok) {
          return response;
        }

        await response.body?.cancel().catch(() => {});
        const retryable = RETRYABLE_STATUS.has(response.status);

        if (!retryable) {
          throw Object.assign(
            new Error(`请求失败：HTTP ${response.status} ${url}`),
            { nonRetryable: true }
          );
        }

        if (attempt === MAX_RETRIES) {
          break;
        }

        const delay = retryDelay(
          attempt,
          response.headers.get("retry-after")
        );

        options.onRetry?.({
          url,
          attempt: attempt + 1,
          maxRetries: MAX_RETRIES,
          status: response.status,
          delay
        });
        await sleep(delay, options.signal);
      } catch (error) {
        attemptSignal.dispose();

        if (options.signal?.aborted) {
          throw options.signal.reason || error;
        }

        lastError = error;

        if (error?.nonRetryable) {
          throw error;
        }

        if (attempt === MAX_RETRIES) {
          break;
        }

        const delay = retryDelay(attempt, null);
        options.onRetry?.({
          url,
          attempt: attempt + 1,
          maxRetries: MAX_RETRIES,
          status: lastStatus,
          delay
        });
        await sleep(delay, options.signal);
      }
    }

    const suffix = lastStatus ? `，最后状态 HTTP ${lastStatus}` : "";
    throw new Error(
      `请求连续失败 ${MAX_RETRIES + 1} 次${suffix}：${url}`,
      { cause: lastError }
    );
  }

  function createSegmentRequestHeaders(inputHeaders) {
    const headers = new Headers(inputHeaders || {});

    if (!headers.has("Accept")) {
      // 目标可能是任意图片 CDN；按图片请求发送 Accept，兼容性通常比 */* 更好。
      headers.set(
        "Accept",
        "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
      );
    }

    return headers;
  }

  async function fetchArrayBuffer(url, options = {}) {
    let lastError = null;
    let lastStatus = 0;
    let lastRequestUrl = url;
    let forcedNextUrl = null;
    let forceNoStore = false;
    let hardMissingGatewayRefreshes = 0;
    let routeLearned = false;
    let candidates = orderRequestCandidates(
      uniqueUrls([
        ...(options.candidateUrls?.length ? options.candidateUrls : []),
        getResolvedSegmentUrl(url),
        url
      ]),
      url
    );

    const addCandidate = candidateUrl => {
      if (!isHttpUrl(candidateUrl)) {
        return false;
      }

      const previousLength = candidates.length;
      candidates = orderRequestCandidates(
        uniqueUrls([candidateUrl, ...candidates, url]),
        url
      );
      return candidates.length !== previousLength;
    };

    const getAlternateUrl = currentUrl => {
      candidates = orderRequestCandidates(candidates, url);
      return candidates.find(candidate => candidate !== currentUrl) || currentUrl;
    };

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      throwIfAborted(options.signal);
      candidates = orderRequestCandidates(candidates, url);
      const requestUrl = forcedNextUrl ||
        candidates[attempt % Math.max(candidates.length, 1)] ||
        url;
      forcedNextUrl = null;
      lastRequestUrl = requestUrl;
      const attemptStartedAt = performance.now();
      const attemptSignal = createAttemptSignal(
        options.signal,
        options.timeoutMs ?? SEGMENT_TIMEOUT_MS
      );

      try {
        const requestCache = forceNoStore
          ? "no-store"
          : (options.cache || "default");
        forceNoStore = false;

        const response = await fetch(requestUrl, {
          method: "GET",
          // 正常播放允许复用缓存；仅在刷新失效的 404/410 跳转时使用 no-store。
          cache: requestCache,
          credentials: "omit",
          redirect: "follow",
          referrerPolicy: "no-referrer",
          signal: attemptSignal.signal,
          headers: createSegmentRequestHeaders(options.headers),
          priority: options.priority || (options.urgent ? "high" : "low")
        });
        const responseUrl = response.url || requestUrl;
        const retryable = RETRYABLE_STATUS.has(response.status);
        const hardMissing = HARD_MISSING_STATUS.has(response.status);

        // 只缓存成功地址或可恢复的 5xx 地址。404/410 通常是已经失效的
        // 临时图片 URL，绝不能写入路由缓存。
        const learnedThisAttempt = (response.ok || retryable)
          ? rememberResolvedRoute(url, responseUrl)
          : false;

        if (learnedThisAttempt) {
          routeLearned = true;
        }

        if (responseUrl !== requestUrl && (response.ok || retryable)) {
          addCandidate(responseUrl);
        }

        lastStatus = response.status;

        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          markRouteFailure(responseUrl, response.status);

          if (hardMissing) {
            // 删除失效的直连地址，并最多回到 cdn.hls.one 强制刷新一次跳转。
            // 避免把同一个 404 图片 URL 重新加入候选列表。
            forgetResolvedRoute(url);
            candidates = candidates.filter(candidate => (
              candidate !== requestUrl &&
              candidate !== responseUrl
            ));
            addCandidate(url);

            if (
              hardMissingGatewayRefreshes < HARD_MISSING_GATEWAY_REFRESHES &&
              attempt < MAX_RETRIES
            ) {
              hardMissingGatewayRefreshes += 1;
              forcedNextUrl = url;
              forceNoStore = true;
              const delay = options.urgent ? 80 : 180;
              attemptSignal.dispose();
              options.onRetry?.({
                url,
                requestUrl,
                responseUrl,
                nextUrl: url,
                routeLearned: false,
                hardMissing: true,
                attempt: attempt + 1,
                maxRetries: MAX_RETRIES,
                status: response.status,
                delay
              });
              await sleep(delay, options.signal);
              continue;
            }

            throw Object.assign(
              new Error(`媒体分片不存在：HTTP ${response.status} ${responseUrl}`),
              {
                nonRetryable: true,
                alreadyMarked: true,
                hardMissing: true,
                httpStatus: response.status,
                responseUrl
              }
            );
          }

          const canRefreshResolvedRoute =
            requestUrl !== url && candidates.includes(url);

          if (!retryable && !canRefreshResolvedRoute) {
            throw Object.assign(
              new Error(`请求失败：HTTP ${response.status} ${requestUrl}`),
              {
                nonRetryable: true,
                alreadyMarked: true,
                httpStatus: response.status
              }
            );
          }

          if (canRefreshResolvedRoute && !retryable) {
            // 已缓存的最终地址可能过期或被 CDN 换掉；回到 cdn.hls.one 刷新跳转。
            forgetResolvedRoute(url, requestUrl);
            candidates = candidates.filter(candidate => candidate !== requestUrl);
            addCandidate(url);
          }

          if (attempt === MAX_RETRIES) {
            attemptSignal.dispose();
            break;
          }

          const nextUrl = responseUrl !== requestUrl
            ? responseUrl
            : getAlternateUrl(requestUrl);
          const switchingRoute = nextUrl !== requestUrl;
          forcedNextUrl = nextUrl;
          const delay = retryDelay(
            attempt,
            response.headers.get("retry-after"),
            {
              switchingRoute,
              urgent: Boolean(options.urgent),
              status: response.status
            }
          );
          attemptSignal.dispose();
          options.onRetry?.({
            url,
            requestUrl,
            responseUrl,
            nextUrl,
            routeLearned: learnedThisAttempt,
            attempt: attempt + 1,
            maxRetries: MAX_RETRIES,
            status: response.status,
            delay
          });
          await sleep(delay, options.signal);
          continue;
        }

        const buffer = await response.arrayBuffer();
        attemptSignal.dispose();
        markRouteSuccess(
          responseUrl,
          performance.now() - attemptStartedAt
        );
        return {
          buffer,
          requestedUrl: requestUrl,
          responseUrl,
          contentType: response.headers.get("content-type") || "",
          attempts: attempt + 1,
          routeLearned,
          candidateCount: candidates.length
        };
      } catch (error) {
        attemptSignal.dispose();

        if (options.signal?.aborted) {
          throw options.signal.reason || error;
        }

        lastError = error;

        if (!error?.alreadyMarked) {
          markRouteFailure(requestUrl, lastStatus);
        }

        if (error?.nonRetryable) {
          throw error;
        }

        if (attempt === MAX_RETRIES) {
          break;
        }

        const nextUrl = getAlternateUrl(requestUrl);
        const switchingRoute = nextUrl !== requestUrl;
        forcedNextUrl = nextUrl;
        const delay = retryDelay(attempt, null, {
          switchingRoute,
          urgent: Boolean(options.urgent),
          status: lastStatus
        });
        options.onRetry?.({
          url,
          requestUrl,
          responseUrl: null,
          nextUrl,
          routeLearned: false,
          attempt: attempt + 1,
          maxRetries: MAX_RETRIES,
          status: lastStatus,
          delay
        });
        await sleep(delay, options.signal);
      }
    }

    const suffix = lastStatus ? `，最后状态 HTTP ${lastStatus}` : "";
    throw new Error(
      `请求连续失败 ${MAX_RETRIES + 1} 次${suffix}：${lastRequestUrl}`,
      { cause: lastError }
    );
  }

  async function readResponsePrefix(response, maxBytes, signal) {
    if (!response.body) {
      const buffer = await response.arrayBuffer();
      return new Uint8Array(buffer).subarray(0, maxBytes);
    }

    const reader = response.body.getReader();
    const prefix = new Uint8Array(maxBytes);
    let length = 0;

    try {
      while (length < maxBytes) {
        throwIfAborted(signal);
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        if (!value?.byteLength) {
          continue;
        }

        const copyLength = Math.min(value.byteLength, maxBytes - length);
        prefix.set(value.subarray(0, copyLength), length);
        length += copyLength;

        // 对普通 TS、fMP4 和常见的 116 字节 PNG 外壳，通常一次读取即可完成判断。
        const current = prefix.subarray(0, length);
        const inspection = inspectMediaBytes(current);

        if (
          inspection.kind === "direct-ts" ||
          inspection.kind === "direct-fmp4" ||
          inspection.kind === "png-ts" ||
          inspection.kind === "png-fmp4"
        ) {
          break;
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }

    return prefix.subarray(0, length);
  }


  function looksLikeDirectMediaUrl(url) {
    try {
      const pathname = new URL(url).pathname.toLowerCase();
      return /\.(?:mp4|m4v|webm|mov|mkv|flv|mp3|aac|m4a|ogg|oga|wav)$/.test(
        pathname
      );
    } catch {
      return false;
    }
  }

  function isClearlyNonPlaylistContentType(contentType) {
    const normalized = contentType.toLowerCase();

    if (
      normalized.includes("mpegurl") ||
      normalized.includes("application/vnd.apple.mpegurl")
    ) {
      return false;
    }

    return (
      normalized.startsWith("video/") ||
      normalized.startsWith("audio/") ||
      normalized.includes("application/mp4")
    );
  }

  async function fetchPlaylist(url, options = {}) {
    if (looksLikeDirectMediaUrl(url)) {
      return null;
    }

    const response = await fetchResponse(url, {
      signal: options.signal,
      onRetry: options.onRetry,
      cache: "no-store",
      headers: {
        Accept: [
          "application/vnd.apple.mpegurl",
          "application/x-mpegURL",
          "audio/mpegurl",
          "text/plain",
          "*/*"
        ].join(", ")
      }
    });
    const contentType = response.headers.get("content-type") || "";

    if (isClearlyNonPlaylistContentType(contentType)) {
      await response.body?.cancel();
      return null;
    }

    const contentLength = Number(response.headers.get("content-length"));

    if (Number.isFinite(contentLength) && contentLength > 4 * 1024 * 1024) {
      await response.body?.cancel();
      return null;
    }

    const text = await response.text();

    if (!text.trimStart().startsWith("#EXTM3U")) {
      return null;
    }

    return {
      url: response.url || url,
      text,
      contentType
    };
  }

  function parseAttributeList(text) {
    const attributes = new Map();
    const matcher = /([A-Z0-9-]+)=("(?:[^"\\]|\\.)*"|[^,]*)/gi;
    let match;

    while ((match = matcher.exec(text)) !== null) {
      let value = match[2].trim();

      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }

      attributes.set(match[1].toUpperCase(), value);
    }

    return attributes;
  }

  function getMasterVariants(playlistText, playlistUrl) {
    const lines = playlistText.split(/\r?\n/);
    const variants = [];

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();

      if (!line.startsWith("#EXT-X-STREAM-INF:")) {
        continue;
      }

      const attributes = parseAttributeList(
        line.slice("#EXT-X-STREAM-INF:".length)
      );
      let uri = "";

      for (let uriIndex = index + 1; uriIndex < lines.length; uriIndex += 1) {
        const candidate = lines[uriIndex].trim();

        if (!candidate || candidate.startsWith("#")) {
          continue;
        }

        uri = candidate;
        break;
      }

      if (!uri) {
        continue;
      }

      variants.push({
        url: new URL(uri, playlistUrl).href,
        bandwidth: Number(attributes.get("BANDWIDTH")) || 0
      });
    }

    return variants.sort((left, right) => right.bandwidth - left.bandwidth);
  }

  async function resolveMediaPlaylist(initialPlaylist, options = {}) {
    let current = initialPlaylist;

    for (let depth = 0; depth < 4; depth += 1) {
      const variants = getMasterVariants(current.text, current.url);

      if (variants.length === 0) {
        return current;
      }

      current = await fetchPlaylist(variants[0].url, options);

      if (!current) {
        throw new Error("主播放列表指向的清晰度列表不是有效 M3U8");
      }
    }

    throw new Error("M3U8 主播放列表嵌套层级过深");
  }

  function findFirstSegmentUrl(playlistText, playlistUrl) {
    const lines = playlistText.split(/\r?\n/);

    for (const rawLine of lines) {
      const line = rawLine.trim();

      if (line && !line.startsWith("#")) {
        return new URL(line, playlistUrl).href;
      }
    }

    return null;
  }

  async function inspectSource(url, options = {}) {
    const fetchOptions = {
      signal: options.signal,
      onRetry(info) {
        options.onStatus?.(
          `请求暂时失败，正在重试 ${info.attempt}/${info.maxRetries}……`
        );
      }
    };
    const playlist = await fetchPlaylist(url, fetchOptions);

    if (!playlist) {
      return {
        kind: "direct-media",
        originalUrl: url
      };
    }

    const mediaPlaylist = await resolveMediaPlaylist(
      playlist,
      fetchOptions
    );
    const firstSegmentUrl = findFirstSegmentUrl(
      mediaPlaylist.text,
      mediaPlaylist.url
    );

    if (!firstSegmentUrl) {
      throw new Error("M3U8 中没有找到媒体分片");
    }

    options.onStatus?.("正在快速检查第一个 HLS 分片……");

    let response = null;
    let inspection;
    let firstSegmentContentType = "";
    let inspectionError = null;
    let prefetchedFirstSegment = null;
    let firstSegmentResponseUrl = "";
    const firstSegmentCandidates = getSegmentRequestCandidates(
      firstSegmentUrl,
      true
    );

    try {
      // cdn.hls.one 可能跳到任意图片 CDN，不能再按固定域名推导。
      // 对跳转入口直接完整预取一次，记录 response.url 并复用该分片。
      if (
        isRedirectGatewayUrl(firstSegmentUrl) ||
        firstSegmentCandidates.length > 1
      ) {
        const result = await fetchArrayBuffer(firstSegmentUrl, {
          ...fetchOptions,
          candidateUrls: firstSegmentCandidates,
          cache: "default",
          urgent: true,
          priority: "high"
        });
        firstSegmentContentType = result.contentType;
        firstSegmentResponseUrl = result.responseUrl;
        inspection = inspectMediaBytes(new Uint8Array(result.buffer));
        prefetchedFirstSegment = {
          originalUrl: firstSegmentUrl,
          requestedUrl: result.requestedUrl,
          responseUrl: result.responseUrl,
          contentType: result.contentType,
          buffer: result.buffer
        };
      } else {
        response = await fetchResponse(firstSegmentUrl, {
          ...fetchOptions,
          cache: "default",
          headers: {
            Accept: "*/*",
            Range: `bytes=0-${INSPECTION_PREFIX_BYTES - 1}`
          }
        });
        firstSegmentContentType =
          response.headers.get("content-type") || "";
        const prefix = await readResponsePrefix(
          response,
          INSPECTION_PREFIX_BYTES,
          options.signal
        );
        inspection = inspectMediaBytes(prefix);
      }

      // 某些 CDN 不返回足够长的 Range，但最终 URL 与 MIME 已明确表明是 PNG 包装。
      if (
        inspection.kind === "png-without-media" &&
        (
          firstSegmentContentType.toLowerCase().includes("image/png") ||
          response?.url?.toLowerCase().includes(".png") ||
          firstSegmentResponseUrl.toLowerCase().includes(".png")
        )
      ) {
        inspection = {
          ...inspection,
          kind: "png-media-pending",
          wrapped: true,
          mimeType: "video/mp2t"
        };
      }
    } catch (error) {
      if (options.signal?.aborted) {
        throw error;
      }

      inspectionError = error;
      console.warn(
        "第一个分片连续重试后仍无法预检，改用 MSE 自动兼容路径：",
        error
      );
      inspection = {
        kind: "inspection-failed",
        wrapped: true,
        mediaOffset: -1,
        mimeType: "video/mp2t",
        error: error instanceof Error ? error.message : String(error)
      };
      options.onStatus?.(
        "分片预检暂时失败，正在启用自动兼容播放……"
      );
    }

    if (inspection.kind === "png-without-media") {
      throw new Error(
        "第一个 HLS 分片只是普通 PNG，没有找到附加的视频数据"
      );
    }

    return {
      kind: "hls",
      originalUrl: url,
      rootPlaylist: playlist,
      mediaPlaylist,
      firstSegmentUrl,
      firstSegmentContentType,
      inspection,
      inspectionError,
      prefetchedFirstSegment,
      segmentTransport: isRedirectGatewayUrl(firstSegmentUrl)
        ? "redirect-aware"
        : "original",
      requiresUnwrap: inspection.wrapped
    };
  }

  function parseMediaSegments(playlistText, playlistUrl) {
    const lines = playlistText.split(/\r?\n/);
    const segments = [];
    let pendingDuration = null;
    let currentStart = 0;
    let targetDuration = 10;
    let hasByteRange = false;

    for (const rawLine of lines) {
      const line = rawLine.trim();

      if (!line) {
        continue;
      }

      if (line.startsWith("#EXT-X-TARGETDURATION:")) {
        const value = Number(line.slice("#EXT-X-TARGETDURATION:".length));

        if (Number.isFinite(value) && value > 0) {
          targetDuration = value;
        }
        continue;
      }

      if (line.startsWith("#EXT-X-KEY:")) {
        const attributes = parseAttributeList(
          line.slice("#EXT-X-KEY:".length)
        );
        const method = (attributes.get("METHOD") || "").toUpperCase();

        if (method && method !== "NONE") {
          throw new Error(
            `当前 PNG 解包播放暂不支持加密 HLS（METHOD=${method}）`
          );
        }
        continue;
      }

      if (line.startsWith("#EXT-X-MAP:")) {
        throw new Error("当前 PNG 解包播放仅支持 MPEG-TS 分片，暂不支持 EXT-X-MAP");
      }

      if (line.startsWith("#EXT-X-BYTERANGE:")) {
        hasByteRange = true;
        continue;
      }

      if (line.startsWith("#EXTINF:")) {
        const value = Number(
          line.slice("#EXTINF:".length).split(",", 1)[0]
        );
        pendingDuration = Number.isFinite(value) && value > 0
          ? value
          : targetDuration;
        continue;
      }

      if (line.startsWith("#")) {
        continue;
      }

      if (hasByteRange) {
        throw new Error("当前 PNG 解包播放暂不支持 EXT-X-BYTERANGE 分片");
      }

      const duration = pendingDuration ?? targetDuration;
      const start = currentStart;
      const end = start + duration;

      segments.push({
        index: segments.length,
        url: new URL(line, playlistUrl).href,
        duration,
        start,
        end
      });

      currentStart = end;
      pendingDuration = null;
    }

    if (segments.length === 0) {
      throw new Error("M3U8 中没有可播放的媒体分片");
    }

    return {
      segments,
      duration: currentStart,
      targetDuration
    };
  }

  function copyMediaPayload(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const inspection = inspectMediaBytes(bytes);

    if (
      inspection.kind !== "direct-ts" &&
      inspection.kind !== "png-ts"
    ) {
      throw new Error(
        `分片解包后不是 MPEG-TS（检测结果：${inspection.kind}）`
      );
    }

    const payload = inspection.bytes;

    if (payload.byteLength < TS_PACKET_SIZE) {
      throw new Error("解包后的 MPEG-TS 分片过短");
    }

    const alignedLength = payload.byteLength - (
      payload.byteLength % TS_PACKET_SIZE
    );

    if (alignedLength < TS_PACKET_SIZE) {
      throw new Error("解包后的 MPEG-TS 分片没有完整数据包");
    }

    // appendBuffer 期间浏览器可能继续持有底层内存；复制为独立缓冲区，
    // 避免整个 PNG 响应一直被引用。
    return payload.slice(0, alignedLength).buffer;
  }

  function chooseMseTsMimeType() {
    if (typeof MediaSource === "undefined") {
      return null;
    }

    return MSE_TS_MIME_CANDIDATES.find(type =>
      MediaSource.isTypeSupported(type)
    ) || null;
  }

  function waitForEvent(target, successEvent, errorEvents, signal) {
    return new Promise((resolve, reject) => {
      const failures = Array.isArray(errorEvents)
        ? errorEvents
        : [errorEvents].filter(Boolean);

      const cleanup = () => {
        target.removeEventListener(successEvent, onSuccess);
        failures.forEach(eventName => {
          target.removeEventListener(eventName, onFailure);
        });
        signal?.removeEventListener("abort", onAbort);
      };

      const onSuccess = event => {
        cleanup();
        resolve(event);
      };

      const onFailure = event => {
        cleanup();
        reject(new Error(`${successEvent} 等待期间发生 ${event.type}`));
      };

      const onAbort = () => {
        cleanup();
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new DOMException("操作已取消", "AbortError")
        );
      };

      target.addEventListener(successEvent, onSuccess, { once: true });
      failures.forEach(eventName => {
        target.addEventListener(eventName, onFailure, { once: true });
      });

      if (signal) {
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }
    });
  }

  function getBufferedRangeEnd(video, time = video.currentTime) {
    const ranges = video.buffered;

    for (let index = 0; index < ranges.length; index += 1) {
      if (
        time >= ranges.start(index) - 0.05 &&
        time <= ranges.end(index) + 0.05
      ) {
        return ranges.end(index);
      }
    }

    return time;
  }

  function isTimeBuffered(video, time) {
    const ranges = video.buffered;

    for (let index = 0; index < ranges.length; index += 1) {
      if (
        time >= ranges.start(index) - 0.1 &&
        time <= ranges.end(index) + 0.1
      ) {
        return true;
      }
    }

    return false;
  }

  function findSegmentIndexForTime(segments, time) {
    const target = Math.max(0, Number(time) || 0);
    let low = 0;
    let high = segments.length - 1;

    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const segment = segments[middle];

      if (target < segment.start) {
        high = middle - 1;
      } else if (target >= segment.end) {
        low = middle + 1;
      } else {
        return middle;
      }
    }

    return Math.min(Math.max(low, 0), segments.length - 1);
  }

  function findSegmentIndexAfterTime(segments, time) {
    if (segments.length === 0) {
      return 0;
    }

    const target = Math.max(0, Number(time) || 0);
    const lastSegment = segments[segments.length - 1];

    if (target >= lastSegment.end - SEEK_TIME_EPSILON) {
      return segments.length;
    }

    let index = findSegmentIndexForTime(segments, target);

    while (
      index < segments.length &&
      segments[index].end <= target + SEEK_TIME_EPSILON
    ) {
      index += 1;
    }

    return index;
  }

  async function createMsePlayback(video, analysis, options = {}) {
    if (!(video instanceof HTMLMediaElement)) {
      throw new TypeError("MSE 播放目标必须是 HTMLMediaElement");
    }

    if (analysis?.kind !== "hls") {
      throw new TypeError("只有 HLS 分析结果可以使用 MSE 解包播放");
    }

    if (analysis.inspection.mimeType === "video/mp4") {
      throw new Error("当前 MSE 解包器暂不支持 PNG 包装的 fMP4 分片");
    }

    const mimeType = chooseMseTsMimeType();

    if (!mimeType) {
      throw new Error("当前 browser 不支持通过 MediaSource 追加 MPEG-TS");
    }

    const parsed = parseMediaSegments(
      analysis.mediaPlaylist.text,
      analysis.mediaPlaylist.url
    );
    let prefetchedFirstSegment = analysis.prefetchedFirstSegment || null;
    const mediaSource = new MediaSource();
    const objectUrl = URL.createObjectURL(mediaSource);
    const controller = new AbortController();
    const stats = {
      mode: "mse-concurrent-prefetch",
      mimeType,
      segmentCount: parsed.segments.length,
      loadedSegments: 0,
      downloadedBytes: 0,
      mediaBytes: 0,
      retries: 0,
      retryRounds: 0,
      backgroundFailures: 0,
      maxRetries: MAX_RETRIES,
      maxFailureRounds: MAX_SEGMENT_FAILURE_ROUNDS,
      redirectBypasses: 0,
      learnedRedirects: 0,
      directRouteHits: 0,
      routeSwitches: 0,
      hardMissingResponses: 0,
      prefetchPauses: 0,
      prefetchedSegmentsUsed: 0,
      seekRequests: 0,
      seekRecoveries: 0,
      seekWatchdogKicks: 0,
      sourceBufferStateRetries: 0,
      sourceBufferAbortRecoveries: 0,
      staleOperations: 0,
      totalDuration: parsed.duration,
      prefetchConcurrency: PREFETCH_CONCURRENCY,
      targetBufferSeconds: FORWARD_BUFFER_SECONDS,
      prefetchBufferSeconds: PREFETCH_BUFFER_SECONDS
    };
    let sourceBuffer = null;
    let nextSegmentIndex = 0;
    let pumping = false;
    let destroyed = false;
    let fatalError = null;
    let timer = null;
    let pendingSeek = null;
    let seekRevision = 0;
    let firstAppendResolved = false;
    let resolveFirstAppend;
    let rejectFirstAppend;
    let generation = 0;
    let activeDownloads = 0;
    let networkPenaltyUntil = 0;
    let sourceBufferOperationChain = Promise.resolve();
    let seekWatchdogTimer = null;
    let seekWasPlaying = false;

    const readySegments = new Map();
    const segmentJobs = new Map();
    const segmentFailures = new Map();
    const downloadQueue = [];

    const firstAppend = new Promise((resolve, reject) => {
      resolveFirstAppend = resolve;
      rejectFirstAppend = reject;
    });

    const onParentAbort = () => {
      destroy(
        options.signal?.reason instanceof Error
          ? options.signal.reason
          : new DOMException("操作已取消", "AbortError")
      );
    };

    const snapshotStats = () => ({
      ...stats,
      activeDownloads,
      queuedDownloads: downloadQueue.length,
      readySegments: readySegments.size,
      nextSegmentIndex,
      bufferAhead: Math.max(
        0,
        getBufferedRangeEnd(video) - video.currentTime
      )
    });

    const reportStatus = message => {
      if (!destroyed) {
        options.onStatus?.(message, snapshotStats());
      }
    };

    const fail = error => {
      if (destroyed || error?.name === "AbortError") {
        return;
      }

      fatalError = error instanceof Error ? error : new Error(String(error));
      console.error("MSE HLS 解包播放失败：", fatalError);
      rejectFirstAppend(fatalError);
      options.onError?.(fatalError, snapshotStats());
      reportStatus(`解包播放失败：${fatalError.message}`);
    };

    const makeSeekAbortError = message => (
      new DOMException(message, "AbortError")
    );

    const assertCurrentRevision = revision => {
      if (revision !== seekRevision) {
        stats.staleOperations += 1;
        throw makeSeekAbortError("播放位置已经改变，丢弃旧的分片操作");
      }
    };

    const enqueueSourceBufferOperation = operation => {
      const queued = sourceBufferOperationChain
        .catch(() => {})
        .then(operation);

      // 队列本身始终保持可继续使用；调用方仍会收到本次操作的异常。
      sourceBufferOperationChain = queued.catch(() => {});
      return queued;
    };

    const waitForSourceBufferUpdateEnd = async () => {
      if (!sourceBuffer?.updating) {
        return;
      }

      await waitForEvent(
        sourceBuffer,
        "updateend",
        ["error", "abort"],
        controller.signal
      );
    };

    const appendBuffer = (buffer, revision = seekRevision) => (
      enqueueSourceBufferOperation(async () => {
        throwIfAborted(controller.signal);
        assertCurrentRevision(revision);

        if (!sourceBuffer || mediaSource.readyState !== "open") {
          throw new Error("MediaSource 已关闭，无法追加分片");
        }

        await waitForSourceBufferUpdateEnd();
        assertCurrentRevision(revision);

        const completed = waitForEvent(
          sourceBuffer,
          "updateend",
          ["error", "abort"],
          controller.signal
        );
        sourceBuffer.appendBuffer(buffer);
        await completed;
        assertCurrentRevision(revision);
      })
    );

    const removeBuffer = (start, end, revision = seekRevision) => (
      enqueueSourceBufferOperation(async () => {
        throwIfAborted(controller.signal);
        assertCurrentRevision(revision);

        if (
          !sourceBuffer ||
          mediaSource.readyState !== "open" ||
          end <= start
        ) {
          return;
        }

        await waitForSourceBufferUpdateEnd();
        assertCurrentRevision(revision);

        const completed = waitForEvent(
          sourceBuffer,
          "updateend",
          ["error", "abort"],
          controller.signal
        );
        sourceBuffer.remove(start, end);
        await completed;
        assertCurrentRevision(revision);
      })
    );

    const setTimestampOffset = (
      offset,
      revision = seekRevision
    ) => enqueueSourceBufferOperation(async () => {
      let startedAt = Date.now();
      let abortRecoveryAttempted = false;

      while (true) {
        throwIfAborted(controller.signal);
        assertCurrentRevision(revision);

        if (!sourceBuffer || mediaSource.readyState !== "open") {
          throw new Error("MediaSource 已关闭，无法调整时间轴");
        }

        await waitForSourceBufferUpdateEnd();
        assertCurrentRevision(revision);

        try {
          sourceBuffer.timestampOffset = Math.max(0, offset);
          return;
        } catch (error) {
          const parserStillBusy =
            error?.name === "InvalidStateError" ||
            /PARSING_MEDIA_SEGMENT|append state/i.test(error?.message || "");

          if (!parserStillBusy) {
            throw error;
          }

          stats.sourceBufferStateRetries += 1;

          if (Date.now() - startedAt >= SOURCE_BUFFER_STATE_TIMEOUT_MS) {
            if (!abortRecoveryAttempted) {
              abortRecoveryAttempted = true;
              stats.sourceBufferAbortRecoveries += 1;

              try {
                // 此时队列中没有 append/remove 操作在等待；这是专门针对
                // browser 已触发 updateend、内部解析状态却未释放的恢复手段。
                sourceBuffer.abort();
              } catch (abortError) {
                console.debug("SourceBuffer 解析状态恢复失败：", abortError);
              }

              startedAt = Date.now();
              await sleep(SOURCE_BUFFER_STATE_RETRY_MS, controller.signal);
              continue;
            }

            throw new Error(
              `SourceBuffer 在恢复后仍未退出分片解析状态`,
              { cause: error }
            );
          }

          // browser 偶尔会先触发 updateend，随后才真正退出解析状态。
          // 让出一个宏任务后重试，避免在同一事件循环内连续触发异常。
          await sleep(SOURCE_BUFFER_STATE_RETRY_MS, controller.signal);
        }
      }
    });

    const pruneBackBuffer = async () => {
      if (!sourceBuffer || video.currentTime <= BACK_BUFFER_SECONDS) {
        return;
      }

      const removeEnd = video.currentTime - BACK_BUFFER_SECONDS;

      if (
        sourceBuffer.buffered.length > 0 &&
        sourceBuffer.buffered.start(0) < removeEnd - 1
      ) {
        await removeBuffer(0, removeEnd);
      }
    };

    const getEffectiveConcurrency = () => {
      const normalConcurrency = Date.now() < networkPenaltyUntil
        ? Math.max(2, PREFETCH_CONCURRENCY - 1)
        : PREFETCH_CONCURRENCY;

      // seek 时允许短暂超出普通预取并发。旧请求收到 abort 后可能还要
      // 一个事件循环才释放槽位，不应因此阻塞目标分片。
      return pendingSeek
        ? Math.max(normalConcurrency, SEEK_PREFETCH_CONCURRENCY)
        : normalConcurrency;
    };

    const abortPrefetch = (
      reason = new DOMException("预取任务已取消", "AbortError"),
      clearFailures = true
    ) => {
      generation += 1;

      while (downloadQueue.length > 0) {
        const job = downloadQueue.shift();
        job.controller.abort(reason);
        job.resolve({ ok: false, aborted: true, error: reason });

        if (segmentJobs.get(job.index) === job) {
          segmentJobs.delete(job.index);
        }
      }

      for (const job of segmentJobs.values()) {
        if (job.state === "running") {
          job.controller.abort(reason);
        }
      }

      // 立即解除旧任务占位；旧任务 finally 中有对象身份校验，
      // 不会误删跳转后新建的同索引任务。
      segmentJobs.clear();
      readySegments.clear();

      if (clearFailures) {
        segmentFailures.clear();
      }
    };

    const loadSegment = async (segment, signal, urgent = false) => {
      let result;

      if (
        segment.index === 0 &&
        prefetchedFirstSegment?.buffer instanceof ArrayBuffer
      ) {
        result = {
          buffer: prefetchedFirstSegment.buffer,
          requestedUrl: prefetchedFirstSegment.requestedUrl,
          responseUrl: prefetchedFirstSegment.responseUrl,
          contentType: prefetchedFirstSegment.contentType,
          attempts: 1,
          routeLearned: false,
          candidateCount: 1
        };
        prefetchedFirstSegment = null;
        stats.prefetchedSegmentsUsed += 1;
      } else {
        const candidateUrls = getSegmentRequestCandidates(
          segment.url,
          true
        );

        if (candidateUrls[0] !== segment.url) {
          stats.redirectBypasses += 1;
          stats.directRouteHits += 1;
        }

        result = await fetchArrayBuffer(segment.url, {
          signal,
          timeoutMs: SEGMENT_TIMEOUT_MS,
          candidateUrls,
          cache: "default",
          urgent,
          priority: urgent ? "high" : "low",
          onRetry(info) {
            stats.retries += 1;

            if ([500, 502, 503, 504].includes(info.status)) {
              networkPenaltyUntil = Math.max(
                networkPenaltyUntil,
                Date.now() + 12000
              );
            }

            const switchingRoute =
              info.nextUrl && info.nextUrl !== info.requestUrl;

            if (switchingRoute) {
              stats.routeSwitches += 1;
            }

            reportStatus(
              `分片 ${segment.index + 1}/${parsed.segments.length} 请求失败，` +
              `后台重试 ${info.attempt}/${info.maxRetries}` +
              `${switchingRoute ? "（切换线路）" : ""}`
            );
          }
        });
      }

      if (result.routeLearned) {
        stats.learnedRedirects += 1;
      }

      stats.downloadedBytes += result.buffer.byteLength;
      const mediaBuffer = copyMediaPayload(result.buffer);
      stats.mediaBytes += mediaBuffer.byteLength;
      return mediaBuffer;
    };

    const pausePrefetchAfter = index => {
      const reason = new DOMException(
        `前序分片 ${index + 1} 返回 404/410，暂停后续预取`,
        "AbortError"
      );
      let paused = 0;

      for (let queueIndex = downloadQueue.length - 1; queueIndex >= 0; queueIndex -= 1) {
        const job = downloadQueue[queueIndex];

        if (job.index <= index) {
          continue;
        }

        downloadQueue.splice(queueIndex, 1);
        job.controller.abort(reason);
        job.resolve({ ok: false, aborted: true, error: reason });

        if (segmentJobs.get(job.index) === job) {
          segmentJobs.delete(job.index);
        }

        paused += 1;
      }

      for (const job of segmentJobs.values()) {
        if (job.index > index && job.state === "running") {
          job.controller.abort(reason);
          paused += 1;
        }
      }

      if (paused > 0) {
        stats.prefetchPauses += 1;
      }
    };

    const drainDownloadQueue = () => {
      if (destroyed || controller.signal.aborted) {
        return;
      }

      const concurrency = getEffectiveConcurrency();

      while (
        activeDownloads < concurrency &&
        downloadQueue.length > 0
      ) {
        const job = downloadQueue.shift();

        if (
          job.generation !== generation ||
          job.controller.signal.aborted
        ) {
          job.resolve({
            ok: false,
            aborted: true,
            error: job.controller.signal.reason
          });
          continue;
        }

        job.state = "running";
        activeDownloads += 1;

        const relayAbort = () => {
          job.controller.abort(
            controller.signal.reason instanceof Error
              ? controller.signal.reason
              : new DOMException("操作已取消", "AbortError")
          );
        };

        if (controller.signal.aborted) {
          relayAbort();
        } else {
          controller.signal.addEventListener(
            "abort",
            relayAbort,
            { once: true }
          );
        }

        loadSegment(
          parsed.segments[job.index],
          job.controller.signal,
          Boolean(job.priority)
        )
          .then(buffer => {
            if (
              !destroyed &&
              job.generation === generation &&
              !job.controller.signal.aborted
            ) {
              readySegments.set(job.index, buffer);
              segmentFailures.delete(job.index);
              job.resolve({ ok: true, buffer });
            } else {
              job.resolve({
                ok: false,
                aborted: true,
                error: job.controller.signal.reason
              });
            }
          })
          .catch(error => {
            if (
              error?.name === "AbortError" ||
              job.controller.signal.aborted ||
              job.generation !== generation
            ) {
              job.resolve({ ok: false, aborted: true, error });
              return;
            }

            const previous = segmentFailures.get(job.index);
            const round = (previous?.round || 0) + 1;
            const hardMissing = Boolean(error?.hardMissing);
            const status = Number(error?.httpStatus) || 0;
            const cooldown = hardMissing
              ? HARD_MISSING_RETRY_COOLDOWN_MS
              : Math.min(900 * 2 ** (round - 1), 5000);
            const failure = {
              error,
              round,
              hardMissing,
              status,
              lastFailureAt: Date.now(),
              nextRetryAt: Date.now() + cooldown
            };
            segmentFailures.set(job.index, failure);
            stats.retryRounds += 1;
            stats.backgroundFailures += 1;

            if (hardMissing) {
              stats.hardMissingResponses += 1;

              if (job.index === nextSegmentIndex) {
                pausePrefetchAfter(job.index);
              }
            }

            job.resolve({ ok: false, ...failure });
            reportStatus(
              hardMissing
                ? `分片 ${job.index + 1} 返回 ${status || 404}，` +
                  `暂停后续预取并在 ${Math.floor(cooldown / 1000)} 秒后重试`
                : `分片 ${job.index + 1} 完整重试一轮后仍失败，` +
                  `将在 ${cooldown}ms 后继续预取`
            );
          })
          .finally(() => {
            controller.signal.removeEventListener("abort", relayAbort);
            activeDownloads -= 1;

            if (segmentJobs.get(job.index) === job) {
              segmentJobs.delete(job.index);
            }

            drainDownloadQueue();
            queueMicrotask(() => pump("download-complete"));
          });
      }
    };

    const queueSegment = (index, priority = false, deferDrain = false) => {
      if (
        destroyed ||
        index < 0 ||
        index >= parsed.segments.length ||
        readySegments.has(index)
      ) {
        return null;
      }

      const existing = segmentJobs.get(index);

      if (existing) {
        if (priority) {
          existing.priority = true;
        }

        if (priority && existing.state === "queued") {
          const queueIndex = downloadQueue.indexOf(existing);

          if (queueIndex > 0) {
            downloadQueue.splice(queueIndex, 1);
            downloadQueue.unshift(existing);
          }
        }

        return existing.promise;
      }

      let failure = segmentFailures.get(index);

      // 服务器恢复一段时间后，不沿用旧的连续失败计数。
      if (
        failure &&
        Date.now() - (failure.lastFailureAt || 0) >
          (failure.hardMissing ? 120000 : 30000)
      ) {
        segmentFailures.delete(index);
        failure = null;
      }

      // 高优先级只能改变队列顺序，不能绕过失败冷却。
      // 旧逻辑在这里让 nextSegmentIndex 每 350ms 重排一次，
      // 是控制台出现成千上万条 404 的主要原因。
      if (failure && Date.now() < failure.nextRetryAt) {
        return null;
      }

      if (
        !priority &&
        failure &&
        failure.round >= MAX_SEGMENT_FAILURE_ROUNDS
      ) {
        return null;
      }

      const jobController = new AbortController();
      let resolveJob;
      const promise = new Promise(resolve => {
        resolveJob = resolve;
      });
      const job = {
        index,
        generation,
        controller: jobController,
        state: "queued",
        priority,
        promise,
        resolve: resolveJob
      };

      segmentJobs.set(index, job);

      if (priority && !deferDrain) {
        downloadQueue.unshift(job);
      } else {
        downloadQueue.push(job);

        if (!priority) {
          downloadQueue.sort((left, right) => left.index - right.index);
        }
      }

      if (!deferDrain) {
        drainDownloadQueue();
      }

      return promise;
    };

    const schedulePrefetch = () => {
      if (destroyed || nextSegmentIndex >= parsed.segments.length) {
        return;
      }

      const blockingFailure = segmentFailures.get(nextSegmentIndex);

      if (
        blockingFailure?.hardMissing &&
        Date.now() < blockingFailure.nextRetryAt
      ) {
        return;
      }

      const horizon = Math.max(
        video.currentTime,
        parsed.segments[nextSegmentIndex].start
      ) + PREFETCH_BUFFER_SECONDS;
      let scheduled = 0;

      for (
        let index = nextSegmentIndex;
        index < parsed.segments.length &&
        scheduled < MAX_PREFETCH_SEGMENTS;
        index += 1
      ) {
        const segment = parsed.segments[index];

        if (index > nextSegmentIndex && segment.start >= horizon) {
          break;
        }

        if (
          !readySegments.has(index) &&
          !segmentJobs.has(index)
        ) {
          queueSegment(index, index === nextSegmentIndex);
        }

        scheduled += 1;
      }
    };

    const scheduleSeekPrefetch = startIndex => {
      const lastIndex = Math.min(
        parsed.segments.length - 1,
        startIndex + SEEK_PRIORITY_SEGMENTS - 1
      );

      // 批量入队后再统一启动，确保目标分片严格排在最前面，
      // 不会因为 priority 的 unshift 行为把后续分片反向插队。
      for (let index = startIndex; index <= lastIndex; index += 1) {
        queueSegment(index, true, true);
      }

      drainDownloadQueue();
    };

    const stopSeekWatchdog = () => {
      if (seekWatchdogTimer !== null) {
        clearInterval(seekWatchdogTimer);
        seekWatchdogTimer = null;
      }
    };

    const startSeekWatchdog = revision => {
      stopSeekWatchdog();

      seekWatchdogTimer = setInterval(() => {
        if (
          destroyed ||
          fatalError ||
          revision !== seekRevision ||
          !pendingSeek
        ) {
          stopSeekWatchdog();
          return;
        }

        if (isTimeBuffered(video, pendingSeek.time)) {
          stopSeekWatchdog();
          return;
        }

        stats.seekWatchdogKicks += 1;
        scheduleSeekPrefetch(nextSegmentIndex);
        queueMicrotask(() => pump("seek-watchdog"));
      }, SEEK_WATCHDOG_INTERVAL_MS);
    };

    const waitForSegment = async index => {
      while (!destroyed) {
        throwIfAborted(controller.signal);

        if (readySegments.has(index)) {
          return readySegments.get(index);
        }

        const failure = segmentFailures.get(index);

        const failureLimit = failure?.hardMissing
          ? 2
          : MAX_SEGMENT_FAILURE_ROUNDS;

        if (failure?.round >= failureLimit) {
          const bufferAhead = Math.max(
            0,
            getBufferedRangeEnd(video) - video.currentTime
          );

          // 永久 404/410 使用更长冷却；即使缓冲尚多，也不会高频轰击服务器。
          if (bufferAhead > 15) {
            const cooldown = failure.hardMissing
              ? HARD_MISSING_RETRY_COOLDOWN_MS
              : 6000;
            segmentFailures.set(index, {
              ...failure,
              round: failureLimit - 1,
              nextRetryAt: Date.now() + cooldown
            });
            reportStatus(
              `分片 ${index + 1} 多轮失败，但当前仍有 ` +
              `${Math.floor(bufferAhead)} 秒缓冲，冷却后继续尝试`
            );
            await sleep(cooldown, controller.signal);
            continue;
          }

          throw new Error(
            failure.hardMissing
              ? `第 ${index + 1} 个分片持续返回 ${failure.status || 404}，` +
                `地址可能已经过期：${failure.error.message}`
              : `第 ${index + 1} 个分片连续失败 ` +
                `${MAX_SEGMENT_FAILURE_ROUNDS} 轮：${failure.error.message}`,
            { cause: failure.error }
          );
        }

        if (failure && Date.now() < failure.nextRetryAt) {
          await sleep(
            failure.nextRetryAt - Date.now(),
            controller.signal
          );
        }

        const promise = queueSegment(index, true);

        if (!promise) {
          await sleep(80, controller.signal);
          continue;
        }

        const result = await promise;

        if (result.ok && readySegments.has(index)) {
          return readySegments.get(index);
        }

        if (result.aborted) {
          throw result.error instanceof Error
            ? result.error
            : new DOMException("分片请求已取消", "AbortError");
        }
      }

      throw new DOMException("播放器已销毁", "AbortError");
    };

    const resetForSeek = async seekRequest => {
      const targetTime = seekRequest.time;
      const revision = seekRequest.revision;

      if (revision !== seekRevision) {
        return;
      }

      if (!sourceBuffer || mediaSource.readyState !== "open") {
        pendingSeek = seekRequest;
        return;
      }

      const requestedIndex = findSegmentIndexForTime(
        parsed.segments,
        targetTime
      );
      let targetIndex = Math.max(
        0,
        requestedIndex - SEEK_BACKTRACK_SEGMENTS
      );
      const backtrackTime = Math.max(0, targetTime - SEEK_BACKTRACK_SECONDS);

      while (
        targetIndex > 0 &&
        parsed.segments[targetIndex].start > backtrackTime
      ) {
        targetIndex -= 1;
      }

      abortPrefetch(
        new DOMException("用户跳转到新的时间位置", "AbortError")
      );

      /*
       * 不在 seek 时直接调用 SourceBuffer.abort()。
       * append/remove/timestampOffset 全部进入同一串行队列；旧操作完成后，
       * revision 校验会自动丢弃结果，不会与新的时间轴设置并发。
       */
      if (revision !== seekRevision) {
        return;
      }

      if (isTimeBuffered(video, targetTime)) {
        const bufferedEnd = getBufferedRangeEnd(video, targetTime);
        nextSegmentIndex = findSegmentIndexAfterTime(
          parsed.segments,
          bufferedEnd
        );

        /*
         * sequence 模式会记住上一次追加结束的位置。跳回旧缓存区间后，
         * 必须把下一次追加起点改到该缓存区间末尾，否则新分片可能被错误
         * 地追加到之前的远端 seek 区域之后。
         */
        await setTimestampOffset(bufferedEnd, revision);
        pendingSeek = null;
        stopSeekWatchdog();
        schedulePrefetch();
        queueMicrotask(() => pump("seek-already-buffered"));
        return;
      }

      /*
       * 保留目标位置之前的缓存，但清理目标位置之后可能与新分片重叠的范围。
       * 这比旧实现 remove(0, end) 更温和，也能避免多次 seek 后 sequence 模式
       * 产生重叠时间线或占满 SourceBuffer 配额。
       */
      const targetStart = parsed.segments[targetIndex].start;

      // 网络请求与 SourceBuffer 时间轴整理并行进行，减少 seek 后首帧等待。
      nextSegmentIndex = targetIndex;
      scheduleSeekPrefetch(targetIndex);

      if (sourceBuffer.buffered.length > 0) {
        const lastBufferedEnd = sourceBuffer.buffered.end(
          sourceBuffer.buffered.length - 1
        );

        if (lastBufferedEnd > targetStart + SEEK_TIME_EPSILON) {
          await removeBuffer(targetStart, lastBufferedEnd, revision).catch(error => {
            if (error?.name !== "AbortError") {
              throw error;
            }
          });
          throwIfAborted(controller.signal);
        }
      }

      if (revision !== seekRevision) {
        return;
      }

      await setTimestampOffset(targetStart, revision);
      pendingSeek = {
        ...seekRequest,
        positioned: true
      };
      stats.seekRecoveries += 1;
      reportStatus(`从 ${Math.floor(targetTime)} 秒附近重新缓冲`);
      schedulePrefetch();
      startSeekWatchdog(revision);
      queueMicrotask(() => pump("seek"));
    };

    async function pump(reason = "timer") {
      if (
        destroyed ||
        fatalError ||
        pumping ||
        !sourceBuffer ||
        mediaSource.readyState !== "open"
      ) {
        return;
      }

      pumping = true;
      const pumpRevision = seekRevision;

      try {
        if (
          pendingSeek !== null &&
          !pendingSeek.positioned
        ) {
          await resetForSeek(pendingSeek);
          return;
        }

        schedulePrefetch();

        while (
          !destroyed &&
          nextSegmentIndex < parsed.segments.length
        ) {
          const bufferedEnd = getBufferedRangeEnd(video);
          const bufferAhead = Math.max(0, bufferedEnd - video.currentTime);
          const targetBuffer = firstAppendResolved
            ? FORWARD_BUFFER_SECONDS
            : STARTUP_BUFFER_SECONDS;

          if (bufferAhead >= targetBuffer) {
            break;
          }

          const segment = parsed.segments[nextSegmentIndex];
          reportStatus(
            firstAppendResolved
              ? `后台缓冲分片 ${segment.index + 1}/${parsed.segments.length}`
              : `准备首批分片 ${segment.index + 1}/${parsed.segments.length}`
          );

          const mediaBuffer = await waitForSegment(nextSegmentIndex);

          assertCurrentRevision(pumpRevision);

          if (
            pendingSeek !== null &&
            !pendingSeek.positioned &&
            !isTimeBuffered(video, pendingSeek.time)
          ) {
            return;
          }

          await appendBuffer(mediaBuffer, pumpRevision);
          readySegments.delete(nextSegmentIndex);
          segmentFailures.delete(nextSegmentIndex);
          nextSegmentIndex += 1;
          stats.loadedSegments += 1;

          if (
            pendingSeek?.revision === seekRevision &&
            isTimeBuffered(video, pendingSeek.time)
          ) {
            reportStatus(
              `${Math.floor(pendingSeek.time)} 秒附近已完成缓冲`
            );
            pendingSeek = null;
            stopSeekWatchdog();

            if (seekWasPlaying && video.paused) {
              video.play().catch(() => {});
            }
          }

          if (!firstAppendResolved) {
            firstAppendResolved = true;
            resolveFirstAppend();
            reportStatus("首个视频分片已就绪");
          }

          schedulePrefetch();
          await pruneBackBuffer();
        }

        /*
         * 不调用 endOfStream()：后向缓冲会被定期清理，播放器即使已经下载到
         * 末尾，也仍需要能够重新请求被清理的旧分片并执行反向 seek。
         */
      } catch (error) {
        if (
          error?.name === "AbortError" &&
          !controller.signal.aborted
        ) {
          queueMicrotask(() => pump("operation-retry"));
          return;
        }

        fail(error);
      } finally {
        pumping = false;
        drainDownloadQueue();
      }
    }

    const onSeeking = () => {
      const targetTime = Math.max(
        0,
        Math.min(
          Number(video.currentTime) || 0,
          Math.max(0, parsed.duration - SEEK_TIME_EPSILON)
        )
      );

      seekRevision += 1;
      stats.seekRequests += 1;
      seekWasPlaying = !video.paused;

      if (!isTimeBuffered(video, targetTime)) {
        pendingSeek = {
          time: targetTime,
          revision: seekRevision,
          positioned: false
        };
        abortPrefetch(
          new DOMException("用户跳转到新的时间位置", "AbortError")
        );
        startSeekWatchdog(seekRevision);
        queueMicrotask(() => pump("seeking"));
        return;
      }

      // 用户跳到了仍在缓冲区内的位置：取消可能存在的旧 seek，继续正常预取。
      pendingSeek = {
        time: targetTime,
        revision: seekRevision,
        positioned: false
      };
      abortPrefetch(
        new DOMException("用户跳转到已缓冲位置", "AbortError")
      );
      startSeekWatchdog(seekRevision);
      queueMicrotask(() => pump("buffered-seek"));
    };

    const onNeedData = () => {
      if (
        firstAppendResolved &&
        !pendingSeek &&
        !isTimeBuffered(video, video.currentTime) &&
        Number.isFinite(video.currentTime)
      ) {
        seekRevision += 1;
        stats.seekRequests += 1;
        seekWasPlaying = !video.paused;
        pendingSeek = {
          time: Math.max(
            0,
            Math.min(
              video.currentTime,
              Math.max(0, parsed.duration - SEEK_TIME_EPSILON)
            )
          ),
          revision: seekRevision,
          positioned: false
        };
        abortPrefetch(
          new DOMException("播放位置缺少缓冲，重新定位分片", "AbortError")
        );
        startSeekWatchdog(seekRevision);
      }

      schedulePrefetch();
      queueMicrotask(() => pump("media-event"));
    };

    function destroy(reason = new DOMException("播放器已销毁", "AbortError")) {
      if (destroyed) {
        return;
      }

      destroyed = true;
      controller.abort(reason);
      abortPrefetch(reason);

      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }

      stopSeekWatchdog();

      video.removeEventListener("timeupdate", onNeedData);
      video.removeEventListener("progress", onNeedData);
      video.removeEventListener("waiting", onNeedData);
      video.removeEventListener("stalled", onNeedData);
      video.removeEventListener("play", onNeedData);
      video.removeEventListener("seeking", onSeeking);
      options.signal?.removeEventListener("abort", onParentAbort);

      if (!firstAppendResolved && !fatalError) {
        rejectFirstAppend(reason);
      }

      try {
        if (sourceBuffer && mediaSource.readyState === "open") {
          sourceBuffer.abort();
        }
      } catch {
        // 销毁阶段忽略 SourceBuffer 状态竞争。
      }

      if (video.src === objectUrl) {
        video.removeAttribute("src");
        video.load();
      }

      URL.revokeObjectURL(objectUrl);
    }

    if (options.signal) {
      if (options.signal.aborted) {
        onParentAbort();
      } else {
        options.signal.addEventListener("abort", onParentAbort, { once: true });
      }
    }

    video.addEventListener("timeupdate", onNeedData);
    video.addEventListener("progress", onNeedData);
    video.addEventListener("waiting", onNeedData);
    video.addEventListener("stalled", onNeedData);
    video.addEventListener("play", onNeedData);
    video.addEventListener("seeking", onSeeking);

    const sourceOpen = waitForEvent(
      mediaSource,
      "sourceopen",
      ["sourceclose", "error"],
      controller.signal
    );

    video.src = objectUrl;
    video.load();
    await sourceOpen;

    sourceBuffer = mediaSource.addSourceBuffer(mimeType);
    sourceBuffer.mode = "sequence";

    if (Number.isFinite(parsed.duration) && parsed.duration > 0) {
      try {
        mediaSource.duration = parsed.duration;
      } catch (error) {
        console.debug("暂时无法设置 MediaSource duration：", error);
      }
    }

    timer = setInterval(() => {
      schedulePrefetch();
      pump("interval");
    }, MSE_PUMP_INTERVAL_MS);

    reportStatus(
      `并发预取已启动：${PREFETCH_CONCURRENCY} 路，` +
      `目标前向缓冲 ${FORWARD_BUFFER_SECONDS} 秒`
    );
    schedulePrefetch();
    pump("startup");

    await firstAppend;

    return {
      url: objectUrl,
      stats,
      mediaSource,
      get sourceBuffer() {
        return sourceBuffer;
      },
      getStats: snapshotStats,
      destroy,
      revoke: destroy
    };
  }

  globalThis.NativeHlsDecoder = Object.freeze({
    version: "0.6.4-sourcebuffer-seek-queue",
    inspectMediaBytes,
    inspectSource,
    createMsePlayback,
    parseMediaSegments,
    getHlsOneStorageUrl,
    getSegmentRequestCandidates
  });
})();
