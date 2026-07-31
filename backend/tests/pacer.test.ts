/**
 * 節流器測試。
 *
 * TDX 實測配額是每 30 秒 5 次 —— 低到「請每個呼叫端自己記得節流」
 * 是不可靠的做法。這裡驗證節流器確實能擋住突發流量。
 *
 * 為了不讓測試跑 30 秒，這裡不直接測 pacer 模組（它的窗口是寫死的常數），
 * 而是測同一套演算法在可注入時間的版本上的行為。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

/** 與 src/tdx/pacer.ts 相同的固定窗口演算法，但時間與參數可注入。 */
function createPacer(windowMs: number, capacity: number) {
  let windowStart = 0;
  let used = 0;
  let queue: Promise<void> = Promise.resolve();
  const waits: number[] = [];

  /** 虛擬時鐘，避免測試真的等待 */
  let now = 0;

  async function waitForSlot(): Promise<void> {
    if (now - windowStart >= windowMs) {
      windowStart = now;
      used = 0;
    }
    if (used < capacity) {
      used++;
      waits.push(0);
      return;
    }
    const waitMs = windowStart + windowMs - now;
    waits.push(waitMs);
    now += waitMs; // 模擬睡眠
    windowStart = now;
    used = 1;
  }

  return {
    acquire(): Promise<void> {
      const result = queue.then(() => waitForSlot());
      queue = result.catch(() => undefined);
      return result;
    },
    advance(ms: number): void {
      now += ms;
    },
    get waits(): number[] {
      return waits;
    },
    get clock(): number {
      return now;
    },
  };
}

test('容量內的呼叫不需等待', async () => {
  const pacer = createPacer(30_000, 4);
  for (let i = 0; i < 4; i++) await pacer.acquire();

  assert.deepEqual(pacer.waits, [0, 0, 0, 0]);
  assert.equal(pacer.clock, 0);
});

test('超出容量的呼叫被排到下個窗口', async () => {
  const pacer = createPacer(30_000, 4);
  for (let i = 0; i < 5; i++) await pacer.acquire();

  assert.deepEqual(pacer.waits.slice(0, 4), [0, 0, 0, 0]);
  assert.equal(pacer.waits[4], 30_000, '第 5 次應等到下個窗口');
});

test('並發突發被串成佇列，不會同時衝出去', async () => {
  // 這正是原本 staticStore 的 Promise.all 造成的問題：
  // 4 個請求同時送出，瞬間吃掉整個窗口
  const pacer = createPacer(30_000, 4);
  const order: number[] = [];

  await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      pacer.acquire().then(() => order.push(i)),
    ),
  );

  assert.deepEqual(order, [0, 1, 2, 3, 4, 5], '順序必須維持');
  // 第 5 次等到下個窗口；窗口重置後第 6 次即可通行，因此只有 1 次等待
  assert.equal(pacer.waits.filter((w) => w > 0).length, 1);
  assert.equal(pacer.clock, 30_000, '6 次呼叫必須跨越一個窗口，不能瞬間送完');
});

test('窗口過期後額度重置', async () => {
  const pacer = createPacer(30_000, 4);
  for (let i = 0; i < 4; i++) await pacer.acquire();

  pacer.advance(30_000);

  for (let i = 0; i < 4; i++) await pacer.acquire();
  assert.equal(pacer.waits.filter((w) => w > 0).length, 0, '重置後不該再等待');
});

test('實際輪詢節奏（30 秒間隔、每輪 2 次）永不觸發等待', async () => {
  // 這是 POLL_INTERVAL_MS=30000 的穩態行為，必須完全不撞配額
  const pacer = createPacer(30_000, 4);

  for (let round = 0; round < 20; round++) {
    await pacer.acquire(); // A1
    await pacer.acquire(); // N1
    pacer.advance(30_000);
  }

  assert.equal(
    pacer.waits.filter((w) => w > 0).length,
    0,
    '30 秒間隔在配額內，不該產生任何等待',
  );
});

test('15 秒間隔本身在配額內，但完全沒有餘裕', async () => {
  // 修正一個先前的誤判：15 秒間隔並不會「必然」超標。
  // 任一 30 秒窗口內最多只有 2 輪輪詢 = 4 次呼叫，剛好等於容量。
  const pacer = createPacer(30_000, 4);

  for (let round = 0; round < 10; round++) {
    await pacer.acquire();
    await pacer.acquire();
    pacer.advance(15_000);
  }

  assert.equal(
    pacer.waits.filter((w) => w > 0).length,
    0,
    '純輪詢情境下 15 秒不會被擋',
  );
});

test('15 秒間隔遇上靜態同步就會塞車', async () => {
  // 這才是選 30 秒的真正理由：15 秒把配額用到零餘裕，
  // 每日靜態同步的 4 次呼叫一插進來就會把輪詢推遲。
  const fast = createPacer(30_000, 4);
  for (let round = 0; round < 4; round++) {
    await fast.acquire();
    await fast.acquire();
    if (round === 1) {
      // 靜態同步：Stop / Route / StopOfRoute / Shape
      for (let i = 0; i < 4; i++) await fast.acquire();
    }
    fast.advance(15_000);
  }
  const fastWaits = fast.waits.filter((w) => w > 0).length;

  const slow = createPacer(30_000, 4);
  for (let round = 0; round < 4; round++) {
    await slow.acquire();
    await slow.acquire();
    if (round === 1) {
      for (let i = 0; i < 4; i++) await slow.acquire();
    }
    slow.advance(30_000);
  }
  const slowWaits = slow.waits.filter((w) => w > 0).length;

  assert.ok(fastWaits > 0, '15 秒間隔加上靜態同步必然塞車');
  assert.ok(
    slowWaits < fastWaits,
    `30 秒間隔應該塞得比較少（30s=${slowWaits}, 15s=${fastWaits}）`,
  );
});
