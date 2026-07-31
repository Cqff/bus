/**
 * 站牌索引。向 TDX proxy 取得，快取於 Function 實例記憶體。
 *
 * **為什麼不讓 Functions 自己解析 TDX 靜態資料**：那需要第二份 TDX 金鑰，
 * 而且站牌合併邏輯會出現兩份實作，遲早分歧——屆時 App 顯示的站位與
 * 回報驗證用的站位會對不上，是最難查的那種 bug。
 *
 * 合併邏輯只存在 `backend/src/static/merge.ts` 一處，Functions 消費結果。
 */

export type StopIndexEntry = {
  stopUID: string;
  stationUID: string;
  lat: number;
  lon: number;
  name: string;
};

/** 冷啟動時載入一次，之後整個實例存活期間重用。 */
let cache: Map<string, StopIndexEntry> | null = null;
let loadedAt = 0;
let inFlight: Promise<Map<string, StopIndexEntry>> | null = null;

/** 靜態資料每日才變一次，快取 6 小時已足夠。 */
const TTL_MS = 6 * 60 * 60 * 1000;

export async function lookupStop(
  stopUID: string,
  proxyBaseUrl: string,
): Promise<StopIndexEntry | null> {
  const index = await loadIndex(proxyBaseUrl);
  return index.get(stopUID) ?? null;
}

async function loadIndex(proxyBaseUrl: string): Promise<Map<string, StopIndexEntry>> {
  if (cache && Date.now() - loadedAt < TTL_MS) return cache;
  if (inFlight) return inFlight;

  inFlight = fetchIndex(proxyBaseUrl)
    .then((index) => {
      cache = index;
      loadedAt = Date.now();
      inFlight = null;
      return index;
    })
    .catch((error: unknown) => {
      inFlight = null;
      // 有舊快取就先用舊的——站牌位置一天內不會變，
      // 讓回報功能因為索引更新失敗而全面停擺並不合理
      if (cache) return cache;
      throw error;
    });

  return inFlight;
}

async function fetchIndex(proxyBaseUrl: string): Promise<Map<string, StopIndexEntry>> {
  if (!proxyBaseUrl) {
    throw new Error('未設定 PROXY_BASE_URL');
  }

  const response = await fetch(`${proxyBaseUrl}/v1/static/stopIndex`);
  if (!response.ok) {
    throw new Error(`載入站牌索引失敗 (${response.status})`);
  }

  const entries = (await response.json()) as StopIndexEntry[];
  const index = new Map<string, StopIndexEntry>();
  for (const entry of entries) index.set(entry.stopUID, entry);

  console.log(`[stopIndex] 載入 ${index.size} 筆`);
  return index;
}

/** 測試用。 */
export function resetStopIndexCache(): void {
  cache = null;
  loadedAt = 0;
  inFlight = null;
}
