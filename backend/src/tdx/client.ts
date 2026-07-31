import { config } from '../config.ts';
import { getAccessToken, resetToken } from './auth.ts';
import type {
  TDXRealTimeByFrequency,
  TDXEstimatedTimeOfArrival,
  TDXStop,
  TDXRoute,
  TDXStopOfRoute,
  TDXShape,
} from './types.ts';

export type FetchStats = {
  /** 未壓縮的回應位元組數 */
  bytes: number;
  /** 回應中的紀錄筆數 */
  count: number;
  /** 送出到收完的毫秒數 */
  elapsedMs: number;
};

export type TDXResult<T> = {
  data: T[];
  stats: FetchStats;
};

/**
 * 呼叫 TDX 並回傳資料與統計。
 *
 * 統計數據是刻意保留的——`scripts/probe-tdx.ts` 用它來實測資料量與延遲，
 * 這是 DESIGN.md §2.1 標為「取得金鑰後第一週務必實測」的項目。
 */
async function get<T>(path: string, params?: Record<string, string>): Promise<TDXResult<T>> {
  const url = new URL(buildUrl(path, params));

  const started = performance.now();
  let response = await authorizedFetch(url);

  // token 可能在有效期內被撤銷，重試一次再放棄
  if (response.status === 401) {
    resetToken();
    response = await authorizedFetch(url);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new TDXError(response.status, `${path} → ${response.status}: ${text.slice(0, 200)}`);
  }

  const text = await response.text();
  const elapsedMs = performance.now() - started;
  const parsed = JSON.parse(text) as T[];
  const data = Array.isArray(parsed) ? parsed : [];

  return {
    data,
    stats: {
      bytes: Buffer.byteLength(text, 'utf8'),
      count: data.length,
      elapsedMs: Math.round(elapsedMs),
    },
  };
}

/**
 * 組出查詢字串。
 *
 * ⚠️ **不能用 `URLSearchParams`。** 它會依 form-urlencoded 規則把 `$`
 * 編碼成 `%24`，而 TDX 的 OData 參數（`$format`、`$top`、`$filter`…）
 * 需要字面的 `$` —— 送出 `%24format=JSON` 會讓請求失敗。
 *
 * 因此參數名保持原樣，只對「值」做編碼。
 */
function buildUrl(path: string, params?: Record<string, string>): string {
  const query = ['$format=JSON'];
  for (const [key, value] of Object.entries(params ?? {})) {
    query.push(`${key}=${encodeURIComponent(value)}`);
  }
  return `${config.tdx.baseUrl}${path}?${query.join('&')}`;
}

async function authorizedFetch(url: URL): Promise<Response> {
  const token = await getAccessToken();
  return fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      // TDX 支援 gzip，可大幅降低全市資料的傳輸量
      'accept-encoding': 'gzip',
    },
  });
}

export class TDXError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'TDXError';
    this.status = status;
  }
}

const city = () => config.tdx.city;

// MARK: - 動態資料（官方更新頻率：每分鐘）

/** A1 公車動態定時資料——全市 */
export const fetchRealTimeByFrequency = () =>
  get<TDXRealTimeByFrequency>(`/Bus/RealTimeByFrequency/City/${city()}`);

/** N1 公車預估到站資料——全市 */
export const fetchEstimatedTimeOfArrival = () =>
  get<TDXEstimatedTimeOfArrival>(`/Bus/EstimatedTimeOfArrival/City/${city()}`);

/** A1 單一路線（探測腳本用，資料量小很多） */
export const fetchRealTimeByRoute = (routeName: string) =>
  get<TDXRealTimeByFrequency>(
    `/Bus/RealTimeByFrequency/City/${city()}/${encodeURIComponent(routeName)}`,
  );

// MARK: - 靜態資料（官方更新頻率：每日）

export const fetchStops = () => get<TDXStop>(`/Bus/Stop/City/${city()}`);
export const fetchRoutes = () => get<TDXRoute>(`/Bus/Route/City/${city()}`);
export const fetchStopOfRoute = () => get<TDXStopOfRoute>(`/Bus/StopOfRoute/City/${city()}`);
export const fetchShapes = () => get<TDXShape>(`/Bus/Shape/City/${city()}`);
