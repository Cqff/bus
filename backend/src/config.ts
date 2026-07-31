function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `缺少環境變數 ${name}。請複製 .env.example 為 .env 並填入 TDX 金鑰。`,
    );
  }
  return value;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  tdx: {
    clientId: required('TDX_CLIENT_ID'),
    clientSecret: required('TDX_CLIENT_SECRET'),
    tokenUrl:
      'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token',
    baseUrl: 'https://tdx.transportdata.tw/api/basic/v2',
    city: process.env.TDX_CITY ?? 'Taipei',
  },
  port: num('PORT', 8080),
  pollIntervalMs: num('POLL_INTERVAL_MS', 15_000),
  cacheMaxAgeSec: num('CACHE_MAX_AGE_SEC', 15),

  /// 視野模式的預設車輛數上限，與 iOS 端 LiveBusStore.viewportLimit 一致
  defaultViewportLimit: 60,
  maxViewportLimit: 200,

  /// bbox 最大跨距（度），見 API_CONTRACT.md §2.1
  maxBBoxSpanDegrees: 0.15,

  /// 超過此秒數的車輛位置視為訊號中斷
  staleThresholdSec: 90,
} as const;
