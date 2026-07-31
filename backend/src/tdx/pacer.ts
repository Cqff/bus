/**
 * TDX 呼叫節流器。
 *
 * 本模組**刻意不 import `config`**——`config` 在缺少環境變數時會拋錯，
 * 而 `scripts/diagnose-tdx.ts` 需要在還沒驗證環境變數前就載入節流器。
 * 需要設定值的函式改為由呼叫端傳入。
 *
 * ## 為什麼需要這個
 *
 * 實測（2026-07-31）顯示 TDX 一般會員的配額是 **每 30 秒 5 次**：
 *
 * ```
 * +0.0s 200  +0.1s 200  +1.1s 200  +2.2s 200  +3.3s 200   ← 5 次成功
 * +4.3s 429  +19.7s 429                                    ← 被擋
 * +35.4s 200                                               ← 窗口重置後恢復
 * ```
 *
 * 這個額度低到「請每個呼叫端自己記得節流」是不可靠的做法——
 * 只要有人多寫一個 `Promise.all`，就會瞬間吃掉整個窗口。
 * 因此在**唯一的出口**強制排隊。
 *
 * ## 實作
 *
 * 固定窗口計數：記錄窗口內已用次數，用完就等到窗口重置。
 * 不用權杖桶，因為實測顯示 TDX 是固定窗口而非漸進補充——
 * 用權杖桶模型會在窗口邊界估算錯誤。
 *
 * 保守起見容量設為實測值減一，留一次餘裕給重試。
 */

/** 實測配額：每 30 秒 5 次。容量取 4，留一次餘裕。 */
const WINDOW_MS = 30_000;
const CAPACITY = 4;

let windowStartMs = 0;
let usedInWindow = 0;
let queue: Promise<void> = Promise.resolve();

/** 統計，供 /healthz 觀察節流狀況。 */
export const pacerStats = {
  totalCalls: 0,
  totalWaitMs: 0,
  maxWaitMs: 0,
};

/**
 * 取得一個呼叫額度。必要時等待到下個窗口。
 *
 * 所有請求串成單一佇列——並行呼叫會自動被排開，
 * 呼叫端不需要知道節流的存在。
 */
export function acquireSlot(): Promise<void> {
  const result = queue.then(() => waitForSlot());
  // 佇列本身不因單次失敗而中斷
  queue = result.catch(() => undefined);
  return result;
}

async function waitForSlot(): Promise<void> {
  const now = Date.now();

  if (now - windowStartMs >= WINDOW_MS) {
    windowStartMs = now;
    usedInWindow = 0;
  }

  if (usedInWindow < CAPACITY) {
    usedInWindow++;
    pacerStats.totalCalls++;
    return;
  }

  const waitMs = windowStartMs + WINDOW_MS - now;
  pacerStats.totalWaitMs += waitMs;
  pacerStats.maxWaitMs = Math.max(pacerStats.maxWaitMs, waitMs);

  console.log(`[pacer] 配額用盡，等待 ${(waitMs / 1000).toFixed(1)} 秒後重試`);
  await sleep(waitMs);

  windowStartMs = Date.now();
  usedInWindow = 1;
  pacerStats.totalCalls++;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 每輪輪詢消耗的呼叫數（A1 + N1）。
 * 用於在啟動時檢查 `POLL_INTERVAL_MS` 是否會超出配額。
 */
const CALLS_PER_POLL = 2;

/**
 * 檢查目前設定是否會撞上配額，若會則印出警告。
 *
 * 在啟動時就講清楚，比等到線上一直 429 才發現好。
 */
export function warnIfPollTooFast(pollIntervalMs: number): void {
  // 30 秒窗口內最多會出現幾輪輪詢。取上界（+1）是刻意保守——
  // 窗口與輪詢節奏未必對齊，寧可提早警告也不要線上才發現。
  const roundsPerWindow = Math.floor(WINDOW_MS / pollIntervalMs) + 1;
  const callsPerWindow = roundsPerWindow * CALLS_PER_POLL;

  if (callsPerWindow > CAPACITY) {
    console.warn(
      `\n[pacer] ⚠️  POLL_INTERVAL_MS=${pollIntervalMs}（${pollIntervalMs / 1000} 秒）` +
        `在 30 秒窗口內最壞情況會產生 ${callsPerWindow} 次呼叫，` +
        `超過安全容量 ${CAPACITY} 次。\n` +
        `        節流器會自動排隊，但實際輪詢間隔將被拉長且不穩定，\n` +
        `        且每日靜態同步（4 次呼叫）插入時會明顯塞車。\n` +
        `        建議把 POLL_INTERVAL_MS 設為 30000。\n` +
        `        TDX 動態資料本來就每分鐘才更新，30 秒輪詢不會損失新鮮度。\n`,
    );
  }
}
