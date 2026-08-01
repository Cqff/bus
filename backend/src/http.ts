import type { ServerResponse } from 'node:http';
import { config } from './config.ts';

/** API_CONTRACT.md §1.2 的錯誤碼 */
export type ErrorCode =
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  INVALID_ARGUMENT: 400,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  UPSTREAM_UNAVAILABLE: 503,
  INTERNAL: 500,
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
  }
}

/**
 * 回傳可被 CDN 快取的 JSON。
 *
 * ⚠️ **`ageSec` 與 CDN 快取的交互作用**
 *
 * 回應中的 `ageSec` 是**快取填充當下**的值。若這份回應在 CDN 停留了 12 秒才
 * 送給下一位使用者，該使用者看到的 `ageSec` 會少算 12 秒。
 *
 * 正確的修正方式是讓 App 加上 HTTP `Age` 標頭的值：
 *
 *     實際年齡 = 回應中的 ageSec + Age 標頭
 *
 * 這是標準機制、且不受裝置時鐘偏移影響。
 *
 * 🔍 **待驗證**：Firebase Hosting CDN 是否確實回傳 `Age` 標頭。
 * 若否，需改用 `stale-while-revalidate` 較短的設定或縮短 max-age。
 */
export function sendCacheableJson(
  res: ServerResponse,
  payload: unknown,
  maxAgeSec = config.cacheMaxAgeSec,
): void {
  const body = JSON.stringify(payload);
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': `public, max-age=${maxAgeSec}, s-maxage=${maxAgeSec}, stale-while-revalidate=${maxAgeSec * 2}`,
    // 讓 App 能讀到 Age 以校正 ageSec
    'access-control-expose-headers': 'Age',
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(payload));
}

export function sendError(res: ServerResponse, error: unknown): void {
  if (error instanceof ApiError) {
    sendJson(res, STATUS[error.code], {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    });
    return;
  }

  console.error('[http] 未預期錯誤：', error);
  sendJson(res, 500, {
    error: { code: 'INTERNAL', message: '伺服器發生未預期錯誤' },
  });
}

// MARK: - 內容協商

/**
 * 依 RFC 9110 §12.5.3 判斷 client 是否接受 gzip。
 *
 * **標頭不存在時回 true**——RFC 明訂「未帶 Accept-Encoding 即視為接受任何編碼」。
 * 這保留了原本的行為，也涵蓋 CDN 回源與 iOS URLSession（一律送 gzip）這兩個實際路徑。
 * 真正需要 identity 的是明確送出 `identity`、`gzip;q=0` 或空字串的 client。
 */
export function acceptsGzip(header: string | undefined): boolean {
  if (header === undefined) return true;

  let wildcardQ: number | null = null;
  for (const part of header.split(',')) {
    const [rawToken, ...params] = part.split(';');
    const token = rawToken?.trim().toLowerCase();
    if (!token) continue;
    if (token === 'gzip') return qValue(params) > 0;
    if (token === '*') wildcardQ = qValue(params);
  }
  return wildcardQ === null ? false : wildcardQ > 0;
}

/** 取 `;q=` 參數，缺少或格式錯誤時依 RFC 預設為 1。 */
function qValue(params: string[]): number {
  for (const param of params) {
    const [key, value] = param.split('=');
    if (key?.trim().toLowerCase() !== 'q') continue;
    const parsed = Number(value?.trim());
    return Number.isFinite(parsed) ? parsed : 1;
  }
  return 1;
}

// MARK: - 參數解析

export function parseBBox(raw: string): {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
} {
  const parts = raw.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new ApiError(
      'INVALID_ARGUMENT',
      'bbox 格式錯誤，應為 minLon,minLat,maxLon,maxLat',
    );
  }
  const [minLon, minLat, maxLon, maxLat] = parts as [number, number, number, number];

  if (minLon >= maxLon || minLat >= maxLat) {
    throw new ApiError('INVALID_ARGUMENT', 'bbox 的最小值必須小於最大值');
  }

  const span = Math.max(maxLat - minLat, maxLon - minLon);
  if (span > config.maxBBoxSpanDegrees) {
    throw new ApiError(
      'INVALID_ARGUMENT',
      `bbox 跨距過大（上限 ${config.maxBBoxSpanDegrees} 度）`,
      { span, limit: config.maxBBoxSpanDegrees },
    );
  }

  return { minLon, minLat, maxLon, maxLat };
}

export function parseDirection(raw: string | null): 0 | 1 | undefined {
  if (raw === null || raw === '') return undefined;
  if (raw === '0') return 0;
  if (raw === '1') return 1;
  throw new ApiError('INVALID_ARGUMENT', 'direction 只接受 0 或 1');
}

export function parseLimit(raw: string | null): number {
  if (raw === null || raw === '') return config.defaultViewportLimit;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ApiError('INVALID_ARGUMENT', 'limit 必須為正整數');
  }
  return Math.min(parsed, config.maxViewportLimit);
}
