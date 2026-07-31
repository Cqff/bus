/**
 * TDX 呼叫配額實測。
 *
 * 官方文件只公告「每 IP 每秒 50 次」與「未註冊會員 50 次/日」，
 * **沒有公告一般會員的次數配額**，而那正是我們撞到 429 的原因。
 * 論壇上的說法互相矛盾（每分鐘 5 次 vs 每分鐘 20 次），只能實測。
 *
 * 這個數字決定整個架構是否可行：目前設計每 15 秒拉 A1 + N1，
 * 等於每分鐘 8 次呼叫。配額若低於此，設計必須改。
 *
 * 用法：
 *   npm run measure-quota
 *
 * 約需 5 分鐘。過程中會刻意把配額用完，期間其他 TDX 請求都會失敗。
 */

import { getAccessToken } from '../src/tdx/auth.ts';
import { config } from '../src/config.ts';

/** 用最小的端點測試，避免浪費頻寬——我們量的是「次數」不是「資料量」。 */
const PROBE_URL = `${config.tdx.baseUrl}/Bus/Route/City/${config.tdx.city}?$top=1&$format=JSON`;

type Attempt = {
  at: number;
  status: number;
  elapsedMs: number;
};

const attempts: Attempt[] = [];

async function callOnce(token: string): Promise<number> {
  const started = performance.now();
  try {
    const response = await fetch(PROBE_URL, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    // 讀完 body 才算完成，否則連接不會釋放
    await response.text();
    attempts.push({
      at: Date.now(),
      status: response.status,
      elapsedMs: Math.round(performance.now() - started),
    });
    return response.status;
  } catch (error) {
    attempts.push({ at: Date.now(), status: -1, elapsedMs: 0 });
    console.error(`    請求失敗：${(error as Error).message}`);
    return -1;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function line(): void {
  console.log('─'.repeat(58));
}

console.log('\nTDX 呼叫配額實測');
line();

const token = await getAccessToken();
console.log('已取得 token（token 請求本身不計入資料 API 配額）\n');

// ── 階段 1：等待配額重置 ───────────────────────────────────

console.log('階段 1：等待配額重置（先確認目前不在受限狀態）');

let waited = 0;
for (;;) {
  const status = await callOnce(token);
  if (status === 200) {
    console.log(`  ✅ 配額可用（等待了 ${waited} 秒）\n`);
    break;
  }
  if (status === 429) {
    process.stdout.write(`\r  ⏳ 仍在受限中，已等 ${waited} 秒…`);
    await sleep(10_000);
    waited += 10;
    if (waited > 300) {
      console.log('\n  ❌ 等待超過 5 分鐘仍受限，可能是每日配額而非每分鐘配額。');
      console.log('     若是每日配額，建議明天再測，或直接聯絡 TDX 客服確認等級。\n');
      process.exit(1);
    }
    continue;
  }
  console.log(`\n  ❌ 非預期狀態 ${status}，中止。\n`);
  process.exit(1);
}

// ── 階段 2：連續呼叫直到被擋 ───────────────────────────────

console.log('階段 2：連續呼叫，找出配額上限');
console.log('  （每次間隔 1 秒，避開「每秒 50 次」的平行請求限制）\n');

const burstStarted = Date.now();
let successCount = 0;
let blockedAt = -1;

for (let i = 1; i <= 40; i++) {
  const status = await callOnce(token);
  const elapsed = ((Date.now() - burstStarted) / 1000).toFixed(1);

  if (status === 200) {
    successCount++;
    console.log(`  ${String(i).padStart(2)}. ✅ 200      （第 ${elapsed} 秒）`);
  } else if (status === 429) {
    blockedAt = i;
    console.log(`  ${String(i).padStart(2)}. ❌ 429 被擋 （第 ${elapsed} 秒）`);
    break;
  } else {
    console.log(`  ${String(i).padStart(2)}. ⚠️  ${status}      （第 ${elapsed} 秒）`);
  }

  await sleep(1000);
}

if (blockedAt === -1) {
  console.log(`\n  40 次連續呼叫都沒被擋，配額高於 40 次/分鐘。\n`);
  process.exit(0);
}

const burstDurationSec = (Date.now() - burstStarted) / 1000;

// ── 階段 3：測量恢復時間 ───────────────────────────────────

console.log('\n階段 3：測量配額恢復時間\n');

const blockedSince = Date.now();
let recoverySec = -1;

for (let i = 0; i < 40; i++) {
  await sleep(15_000);
  const status = await callOnce(token);
  const elapsed = Math.round((Date.now() - blockedSince) / 1000);

  if (status === 200) {
    recoverySec = elapsed;
    console.log(`  ✅ 第 ${elapsed} 秒恢復`);
    break;
  }
  process.stdout.write(`\r  ⏳ 第 ${elapsed} 秒仍受限…`);
}

// ── 結論 ──────────────────────────────────────────────────

console.log('\n');
line();
console.log('結論');
line();

console.log(`
  可連續成功呼叫次數：${successCount} 次
  用完配額耗時：      ${burstDurationSec.toFixed(0)} 秒
  配額恢復時間：      ${recoverySec === -1 ? '超過 10 分鐘（可能是每日配額）' : `約 ${recoverySec} 秒`}
`);

const windowSec = recoverySec > 0 ? recoverySec : 60;
const perMinute = (successCount / windowSec) * 60;

console.log(`  推估配額：約 ${perMinute.toFixed(1)} 次/分鐘\n`);

line();
console.log('對架構的意義');
line();

// 目前設計每輪拉 A1 + N1 兩個端點
const callsPerRound = 2;
const safeIntervalSec = Math.ceil((callsPerRound / perMinute) * 60 * 1.3); // 留 30% 餘裕

console.log(`
  目前設計每輪拉 A1 + N1 共 ${callsPerRound} 次呼叫。

  在此配額下，安全的輪詢間隔為 **${safeIntervalSec} 秒**（已留 30% 餘裕）。

  目前 .env 的 POLL_INTERVAL_MS = ${config.pollIntervalMs}（${config.pollIntervalMs / 1000} 秒）
  ${
    config.pollIntervalMs / 1000 >= safeIntervalSec
      ? '  ✅ 目前設定在配額內。'
      : `  ❌ 目前設定會超過配額，必須調高至至少 ${safeIntervalSec * 1000}。`
  }

  注意：TDX 動態資料官方更新頻率為每分鐘，因此輪詢間隔在 30–60 秒之間
  並不會實際損失資料新鮮度——真正的瓶頸一直是資料源本身。
  這點與 DESIGN.md §0.1 的判斷一致。
`);

console.log('  完整嘗試紀錄：');
for (const [i, attempt] of attempts.entries()) {
  const rel = i === 0 ? 0 : ((attempt.at - attempts[0]!.at) / 1000).toFixed(1);
  console.log(`    +${String(rel).padStart(6)}s  ${attempt.status}  ${attempt.elapsedMs}ms`);
}
console.log('');
