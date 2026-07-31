import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from './config.ts';
import { liveCache } from './cache/liveCache.ts';
import { staticStore } from './static/staticStore.ts';
import {
  ApiError,
  parseBBox,
  parseDirection,
  parseLimit,
  sendCacheableJson,
  sendError,
  sendJson,
} from './http.ts';

/**
 * TDX proxy。實作 API_CONTRACT.md §2 的即時資料端點。
 *
 * 刻意零依賴——API 只有 4 個 GET 端點，引入框架只會拖慢 Cloud Run 冷啟動。
 *
 * ⚠️ 這些端點**不做身分驗證**，這是 D1 決策的必要條件：
 * Firebase Hosting CDN 不會快取帶 Authorization 標頭的請求，加了驗證等於
 * CDN 失效、成本回到 US$95/月。回報寫入端（Cloud Functions）才做驗證。
 * 完整理由見 API_CONTRACT.md §0。
 */

const server = createServer((req, res) => {
  handle(req, res).catch((error: unknown) => sendError(res, error));
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-max-age': '86400',
    });
    res.end();
    return;
  }

  if (req.method !== 'GET') {
    throw new ApiError('INVALID_ARGUMENT', '僅支援 GET');
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  switch (url.pathname) {
    case '/healthz':
      return health(res);
    case '/v1/live/buses':
      return liveBuses(url, res);
    case '/v1/live/eta':
      return liveEta(url, res);
    case '/v1/static/manifest':
      return staticManifest(url, res);
  }

  const assetMatch = /^\/v1\/static\/([a-zA-Z]+)$/.exec(url.pathname);
  if (assetMatch?.[1]) {
    return staticAsset(assetMatch[1], res);
  }

  throw new ApiError('NOT_FOUND', `未知的端點 ${url.pathname}`);
}

// MARK: - 端點

function health(res: ServerResponse): void {
  const ready = liveCache.isReady;
  sendJson(res, ready ? 200 : 503, {
    ok: ready,
    live: {
      filledAt: liveCache.filledAt?.toISOString() ?? null,
      lastGoodAt: liveCache.lastGood?.toISOString() ?? null,
      consecutiveFailures: liveCache.failures,
    },
    static: {
      ready: staticStore.isReady,
      version: staticStore.version,
      builtAt: staticStore.builtAt,
    },
  });
}

function requireCache(): void {
  if (liveCache.isReady) return;
  throw new ApiError(
    'UPSTREAM_UNAVAILABLE',
    '官方資料來源中斷',
    { lastGoodAt: liveCache.lastGood?.toISOString() ?? null },
  );
}

/** `GET /v1/live/buses` —— API_CONTRACT.md §2.1 */
function liveBuses(url: URL, res: ServerResponse): void {
  const routeUID = url.searchParams.get('route');
  const bboxRaw = url.searchParams.get('bbox');
  const direction = parseDirection(url.searchParams.get('direction'));
  const serverTime = new Date().toISOString();

  // 參數驗證必須在 requireCache 之前——格式錯誤與上游狀態無關，
  // 回 UPSTREAM_UNAVAILABLE 會誤導客戶端去重試一個永遠不會成功的請求。
  if (!routeUID && !bboxRaw) {
    throw new ApiError('INVALID_ARGUMENT', '必須提供 route 或 bbox 其中之一');
  }
  const bbox = bboxRaw ? parseBBox(bboxRaw) : null;
  const limit = parseLimit(url.searchParams.get('limit'));

  requireCache();

  // 契約規定：兩者同時提供時 route 優先
  if (routeUID) {
    const buses = liveCache.busesByRoute(routeUID, direction);
    sendCacheableJson(res, {
      serverTime,
      buses,
      truncated: false,
      ...ageRange(buses),
    });
    return;
  }

  // 前面已確認 route 與 bbox 至少有一個，走到這裡代表 bbox 存在
  const { buses, truncated } = liveCache.busesInBBox(bbox!, limit);

  sendCacheableJson(res, {
    serverTime,
    buses,
    truncated,
    ...ageRange(buses),
  });
}

/** `GET /v1/live/eta` —— API_CONTRACT.md §2.2 */
function liveEta(url: URL, res: ServerResponse): void {
  const stopUID = url.searchParams.get('stop');
  const stationUID = url.searchParams.get('station');
  const routeUID = url.searchParams.get('route');
  const direction = parseDirection(url.searchParams.get('direction'));

  if (!stopUID && !stationUID && !routeUID) {
    throw new ApiError('INVALID_ARGUMENT', '必須提供 stop、station 或 route 其中之一');
  }

  requireCache();

  let etas;
  if (stopUID) {
    etas = liveCache.etasByStop(stopUID);
  } else if (stationUID) {
    etas = liveCache.etasByStation(stationUID);
  } else {
    etas = liveCache.etasByRoute(routeUID!, direction);
  }

  sendCacheableJson(res, { serverTime: new Date().toISOString(), etas });
}

// MARK: - 靜態資料

/** 靜態資料每日才變一次，快取 1 小時。 */
const STATIC_MAX_AGE_SEC = 3600;

/** `GET /v1/static/manifest` —— API_CONTRACT.md §3.1 */
function staticManifest(url: URL, res: ServerResponse): void {
  const manifest = staticStore.manifest(`${url.protocol}//${url.host}`);
  if (!manifest) {
    throw new ApiError('UPSTREAM_UNAVAILABLE', '靜態資料尚未就緒，請稍後再試');
  }
  sendCacheableJson(res, manifest, STATIC_MAX_AGE_SEC);
}

/**
 * `GET /v1/static/{stations|routes|stopOfRoute|shapes|stopIndex}`
 *
 * 直接供應預先壓縮好的內容。刻意不放 Cloud Storage——整包壓縮後僅 1–3MB，
 * 由記憶體供應可省掉一個服務與一組權限設定，也避免版本不一致。
 */
function staticAsset(name: string, res: ServerResponse): void {
  const asset = staticStore.asset(name);
  if (!asset) {
    throw new ApiError('NOT_FOUND', `未知的靜態資料 ${name}`);
  }
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-encoding': 'gzip',
    'content-length': String(asset.bytes),
    'cache-control': `public, max-age=${STATIC_MAX_AGE_SEC}, s-maxage=${STATIC_MAX_AGE_SEC}`,
    etag: `"${asset.sha256.slice(0, 16)}"`,
    'access-control-allow-origin': '*',
  });
  res.end(asset.gzipped);
}

function ageRange(buses: Array<{ ageSec: number }>): {
  oldestAgeSec: number | null;
  newestAgeSec: number | null;
} {
  if (buses.length === 0) return { oldestAgeSec: null, newestAgeSec: null };
  const ages = buses.map((bus) => bus.ageSec);
  return {
    oldestAgeSec: Math.max(...ages),
    newestAgeSec: Math.min(...ages),
  };
}

// MARK: - 啟動

// 靜態資料先啟動——liveCache 的 stopToStation 對照要靠它填入
staticStore.start();
liveCache.start();

server.listen(config.port, () => {
  console.log(`[server] listening on :${config.port}　city=${config.tdx.city}`);
  console.log(`[server] poll interval ${config.pollIntervalMs}ms　cache ${config.cacheMaxAgeSec}s`);
});

// Cloud Run 送出 SIGTERM 後有 10 秒優雅關閉時間
process.on('SIGTERM', () => {
  console.log('[server] SIGTERM，關閉中');
  liveCache.stop();
  staticStore.stop();
  server.close(() => process.exit(0));
});
