/**
 * TDX 連線診斷。
 *
 * `npm run probe` 只會說「所有取樣皆失敗」，看不出是哪個環節出問題。
 * 這支腳本把每一步拆開單獨測，並印出完整的錯誤內容。
 *
 * 用法：
 *   npm run diagnose
 *
 * 不會印出你的 Client Secret，只印遮罩後的長度資訊。
 */

import { acquireSlot } from '../src/tdx/pacer.ts';

const TOKEN_URL =
  'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';
const BASE_V2 = 'https://tdx.transportdata.tw/api/basic/v2';
const BASE_V3 = 'https://tdx.transportdata.tw/api/basic/v3';

let failures = 0;

/**
 * 帶節流的 fetch。
 *
 * TDX 配額只有每 30 秒 5 次，而本腳本會送出約 11 個資料請求 ——
 * 不節流的話從第 6 個開始全部 429，後面兩段等於沒測。
 *
 * token 請求與根網域的連線測試不走這裡，它們不計入資料 API 配額。
 */
async function pacedFetch(url: string, token: string, timeoutMs = 30_000): Promise<Response> {
  await acquireSlot();
  return fetch(url, {
    headers: { authorization: `Bearer ${token}`, 'accept-encoding': 'gzip' },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function step(name: string): void {
  console.log(`\n${'─'.repeat(58)}\n${name}\n${'─'.repeat(58)}`);
}

function ok(message: string): void {
  console.log(`  ✅ ${message}`);
}

function bad(message: string): void {
  failures++;
  console.log(`  ❌ ${message}`);
}

function info(message: string): void {
  console.log(`     ${message}`);
}

// ── 1. 環境變數 ────────────────────────────────────────────

step('1. 環境變數');

const clientId = process.env.TDX_CLIENT_ID ?? '';
const clientSecret = process.env.TDX_CLIENT_SECRET ?? '';

if (!clientId) {
  bad('TDX_CLIENT_ID 未設定或為空');
  info('請確認 backend/.env 存在，且該行不是 `TDX_CLIENT_ID=`（等號後面沒東西）');
} else {
  ok(`TDX_CLIENT_ID 已設定（${clientId.length} 字元，開頭 ${clientId.slice(0, 6)}…）`);
  if (/\s/.test(clientId)) {
    bad('Client Id 含有空白字元 —— 複製時可能夾帶了空格或換行');
  }
  if (/^["']|["']$/.test(clientId)) {
    bad('Client Id 前後有引號 —— .env 不需要引號，請移除');
  }
}

if (!clientSecret) {
  bad('TDX_CLIENT_SECRET 未設定或為空');
} else {
  ok(`TDX_CLIENT_SECRET 已設定（${clientSecret.length} 字元）`);
  if (/\s/.test(clientSecret)) {
    bad('Client Secret 含有空白字元');
  }
  if (/^["']|["']$/.test(clientSecret)) {
    bad('Client Secret 前後有引號 —— 請移除');
  }
}

if (!clientId || !clientSecret) {
  console.log('\n缺少金鑰，無法繼續後續測試。');
  process.exit(1);
}

// ── 2. 網路可達性 ──────────────────────────────────────────

step('2. 網路可達性');

try {
  const response = await fetch('https://tdx.transportdata.tw/', {
    method: 'HEAD',
    signal: AbortSignal.timeout(10_000),
  });
  ok(`可連線至 tdx.transportdata.tw（HTTP ${response.status}）`);
} catch (error) {
  bad(`無法連線：${(error as Error).message}`);
  info('可能是防火牆、公司網路代理，或需要設定 HTTPS_PROXY 環境變數');
  process.exit(1);
}

// ── 3. OAuth2 認證 ─────────────────────────────────────────

step('3. OAuth2 認證');

let token = '';

try {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const text = await response.text();

  if (!response.ok) {
    bad(`認證失敗（HTTP ${response.status}）`);
    info(`回應：${text.slice(0, 400)}`);
    if (response.status === 401) {
      info('→ Client Id 或 Secret 不正確，請回 TDX 會員中心重新複製');
    }
    if (response.status === 400) {
      info('→ 參數格式問題，通常是金鑰複製時夾帶了空白或換行');
    }
    process.exit(1);
  }

  const json = JSON.parse(text) as { access_token?: string; expires_in?: number };
  if (!json.access_token) {
    bad('認證回應中沒有 access_token');
    info(`回應：${text.slice(0, 400)}`);
    process.exit(1);
  }

  token = json.access_token;
  ok(`取得 token（有效期 ${json.expires_in ?? '?'} 秒）`);
} catch (error) {
  bad(`認證請求失敗：${(error as Error).message}`);
  process.exit(1);
}

// ── 4. 端點探測 ────────────────────────────────────────────

step('4. 端點探測');

info('以下所有請求都會經過節流器排隊（TDX 配額為每 30 秒 5 次）。');
info('本腳本約送出 11 個資料請求，因此整體需要約 90 秒，中途暫停是正常的。');
console.log('');

type Probe = { label: string; url: string };

const probes: Probe[] = [
  { label: 'v2 公車路線（小量）', url: `${BASE_V2}/Bus/Route/City/Taipei?$top=1&$format=JSON` },
  { label: 'v2 公車動態 A1', url: `${BASE_V2}/Bus/RealTimeByFrequency/City/Taipei?$top=1&$format=JSON` },
  { label: 'v2 預估到站 N1', url: `${BASE_V2}/Bus/EstimatedTimeOfArrival/City/Taipei?$top=1&$format=JSON` },
  { label: 'v2 站牌', url: `${BASE_V2}/Bus/Stop/City/Taipei?$top=1&$format=JSON` },
  { label: 'v3 公車路線（比對用）', url: `${BASE_V3}/Bus/Route/City/Taipei?%24top=1&%24format=JSON` },
];

const working: string[] = [];

for (const probe of probes) {
  try {
    const response = await pacedFetch(probe.url, token);
    const text = await response.text();

    if (!response.ok) {
      bad(`${probe.label} → HTTP ${response.status}`);
      info(text.slice(0, 200).replace(/\s+/g, ' '));
      continue;
    }

    const parsed: unknown = JSON.parse(text);
    // v2 直接回陣列；v3 包在 { Routes: [...] } 之類的物件裡
    const records = Array.isArray(parsed)
      ? parsed
      : (Object.values(parsed as Record<string, unknown>).find(Array.isArray) as
          | unknown[]
          | undefined) ?? [];

    ok(`${probe.label} → ${records.length} 筆，${text.length} 字元`);
    working.push(probe.label);

    if (records.length > 0) {
      const keys = Object.keys(records[0] as Record<string, unknown>);
      info(`欄位：${keys.slice(0, 12).join(', ')}${keys.length > 12 ? ' …' : ''}`);
      if (!Array.isArray(parsed)) {
        info('⚠️ 回應是物件而非陣列 —— client.ts 的解析方式需要調整');
      }
    }
  } catch (error) {
    bad(`${probe.label} → ${(error as Error).message}`);
  }
}

// ── 5. 全市查詢（proxy 實際使用的請求）─────────────────────

step('5. 全市查詢（不帶 $top，proxy 實際會送的請求）');

info('DESIGN.md §2.1 標記為待驗證：全市單次回應是否過大而需分區拉取');
info('');

const fullQueries = [
  { label: 'A1 公車動態', path: '/Bus/RealTimeByFrequency/City/Taipei' },
  { label: 'N1 預估到站', path: '/Bus/EstimatedTimeOfArrival/City/Taipei' },
  { label: '站牌', path: '/Bus/Stop/City/Taipei' },
];

for (const query of fullQueries) {
  const started = performance.now();
  try {
    const response = await pacedFetch(`${BASE_V2}${query.path}?$format=JSON`, token, 90_000);
    const text = await response.text();
    const elapsed = Math.round(performance.now() - started);

    if (!response.ok) {
      bad(`${query.label} → HTTP ${response.status}（${elapsed}ms）`);
      info(text.slice(0, 300).replace(/\s+/g, ' '));
      continue;
    }

    const records = JSON.parse(text) as unknown[];
    const mb = Buffer.byteLength(text, 'utf8') / 1024 / 1024;
    ok(`${query.label} → ${records.length} 筆，${mb.toFixed(2)} MB，${elapsed}ms`);

    if (mb > 5) {
      info('⚠️ 超過 5MB，建議改用 $spatialFilter 分區拉取');
    }
  } catch (error) {
    bad(`${query.label} → ${(error as Error).message}`);
    info('若為 timeout，代表全市查詢確實過大，需改用分區拉取');
  }
}

// ── 6. 欄位稽核 ────────────────────────────────────────────

step('6. 欄位稽核（比對 src/tdx/types.ts 的假設）');

info('印出每個欄位的實際出現率。0% 代表 types.ts 的名稱寫錯，');
info('中間值代表該欄位並非每筆都有，程式不可假設它一定存在。');

type Audit = {
  label: string;
  path: string;
  /** 程式碼實際依賴的欄位。缺少會造成功能失效，需特別標示。 */
  critical: string[];
};

const audits: Audit[] = [
  {
    label: '站牌 Bus/Stop',
    path: '/Bus/Stop/City/Taipei?$top=500',
    // 合併規則 1 完全依賴 StationUID —— 若不存在，所有站牌都會走距離分群
    critical: ['StopUID', 'StopName', 'StopPosition', 'StationUID', 'StationID', 'Bearing'],
  },
  {
    label: '路線站序 Bus/StopOfRoute',
    path: '/Bus/StopOfRoute/City/Taipei?$top=50',
    critical: ['RouteUID', 'Direction', 'Stops'],
  },
  {
    label: '線型 Bus/Shape',
    path: '/Bus/Shape/City/Taipei?$top=10',
    critical: ['RouteUID', 'Direction', 'Geometry'],
  },
];

for (const audit of audits) {
  console.log(`\n  ── ${audit.label} ──`);
  try {
    const response = await pacedFetch(`${BASE_V2}${audit.path}&$format=JSON`, token, 60_000);
    if (!response.ok) {
      bad(`HTTP ${response.status}`);
      continue;
    }

    const records = (await response.json()) as Array<Record<string, unknown>>;
    if (records.length === 0) {
      bad('沒有資料');
      continue;
    }

    const counts = new Map<string, number>();
    for (const record of records) {
      for (const [key, value] of Object.entries(record)) {
        if (value === null || value === undefined) continue;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }

    info(`樣本 ${records.length} 筆，共 ${counts.size} 個欄位`);
    console.log('');

    for (const field of audit.critical) {
      const n = counts.get(field) ?? 0;
      const pct = Math.round((n / records.length) * 100);
      const mark = pct === 0 ? '❌' : pct === 100 ? '✅' : '⚠️ ';
      console.log(`     ${mark} ${field.padEnd(16)} ${String(pct).padStart(3)}%  (${n}/${records.length})`);
      if (pct === 0) failures++;
    }

    const others = [...counts.keys()].filter((k) => !audit.critical.includes(k));
    if (others.length > 0) {
      info('');
      info(`其餘欄位：${others.join(', ')}`);
    }
  } catch (error) {
    bad(`${audit.label} → ${(error as Error).message}`);
  }
}

// ── 結論 ──────────────────────────────────────────────────

step('結論');

if (working.length === 0) {
  console.log('  認證成功但所有資料端點都失敗。');
  console.log('  請把上面的 HTTP 狀態碼與回應內容貼出來，據此判斷是路徑改版還是權限問題。');
} else {
  console.log(`  ${working.length}/${probes.length} 個端點可用：`);
  for (const label of working) console.log(`    · ${label}`);
  console.log('\n  若 v2 全數失敗但 v3 可用，代表 API 已改版，需要調整 src/tdx/client.ts。');
}

console.log(`\n  共 ${failures} 項問題。\n`);
