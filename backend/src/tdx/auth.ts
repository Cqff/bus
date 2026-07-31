import { config } from '../config.ts';

type TokenResponse = {
  access_token: string;
  expires_in: number;
};

let cachedToken: string | null = null;
let expiresAtMs = 0;
let inFlight: Promise<string> | null = null;

/** 到期前提早更新的緩衝時間。 */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * 取得 TDX access token。
 *
 * token 有效期約 24 小時，因此快取於記憶體，到期前 5 分鐘才更新。
 * 並行呼叫共用同一個 in-flight promise，避免啟動瞬間打出多次 token 請求。
 */
export async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < expiresAtMs) {
    return cachedToken;
  }
  if (inFlight) {
    return inFlight;
  }

  inFlight = fetchToken()
    .then((token) => {
      inFlight = null;
      return token;
    })
    .catch((error: unknown) => {
      inFlight = null;
      throw error;
    });

  return inFlight;
}

async function fetchToken(): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.tdx.clientId,
    client_secret: config.tdx.clientSecret,
  });

  const response = await fetch(config.tdx.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `TDX 認證失敗 (${response.status})：${text.slice(0, 200)}`,
    );
  }

  const json = (await response.json()) as TokenResponse;
  cachedToken = json.access_token;
  expiresAtMs = Date.now() + json.expires_in * 1000 - REFRESH_MARGIN_MS;
  return cachedToken;
}

/** 測試與探測腳本用：強制下次取用時重新認證。 */
export function resetToken(): void {
  cachedToken = null;
  expiresAtMs = 0;
}
