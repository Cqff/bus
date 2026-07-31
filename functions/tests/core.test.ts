/**
 * 回報核心邏輯的測試。
 *
 * `src/core/` 刻意不 import 任何 Firebase 套件，因此**不需要 npm install**
 * 就能執行：
 *
 *   node --test tests/core.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateShape,
  validateProximity,
  validateNote,
  rateLimitKey,
  checkRateLimit,
  LIMITS,
} from '../src/core/validation.ts';
import type { ReportInput } from '../src/core/validation.ts';
import {
  crossCheckDelay,
  pickEstimate,
  THRESHOLDS,
} from '../src/core/crossCheck.ts';

function input(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    type: 'delay',
    stopUID: 'TPE50629',
    routeUID: 'TPE10132',
    direction: 0,
    plateNumb: null,
    payload: { reportedWaitMinutes: 12 },
    note: null,
    deviceId: 'IDFV-1234',
    lat: 25.0465,
    lon: 121.5175,
    locationAccuracyM: 15,
    ...overrides,
  };
}

// MARK: - 欄位驗證

test('合法的誤點回報通過', () => {
  assert.equal(validateShape(input()).ok, true);
});

test('誤點回報缺少路線被拒', () => {
  const result = validateShape(input({ routeUID: null }));
  assert.equal(result.ok, false);
  assert.match((result as { failure: { message: string } }).failure.message, /路線/);
});

test('等候分鐘數超出範圍被拒', () => {
  assert.equal(validateShape(input({ payload: { reportedWaitMinutes: 0 } })).ok, false);
  assert.equal(validateShape(input({ payload: { reportedWaitMinutes: 61 } })).ok, false);
  assert.equal(validateShape(input({ payload: { reportedWaitMinutes: 12.5 } })).ok, false);
  assert.equal(validateShape(input({ payload: {} })).ok, false);
});

test('擁擠度回報需要合法的 crowdLevel', () => {
  assert.equal(
    validateShape(input({ type: 'crowding', payload: { crowdLevel: 'packed' } })).ok,
    true,
  );
  assert.equal(
    validateShape(input({ type: 'crowding', payload: { crowdLevel: 'full' as never } })).ok,
    false,
  );
});

test('站牌異常回報不需要路線', () => {
  assert.equal(
    validateShape(
      input({ type: 'stopIssue', routeUID: null, payload: { issueKind: 'construction' } }),
    ).ok,
    true,
  );
});

test('未知類型被拒', () => {
  assert.equal(validateShape(input({ type: 'whatever' as never })).ok, false);
});

// MARK: - 距離與精度

test('站牌 150 公尺內可回報', () => {
  assert.equal(validateProximity(0, 10).ok, true);
  assert.equal(validateProximity(149, 10).ok, true);
  assert.equal(validateProximity(150, 10).ok, true);
});

test('超過 150 公尺被拒，且錯誤訊息含實際距離', () => {
  const result = validateProximity(412, 10);
  assert.equal(result.ok, false);
  const failure = (result as { failure: { message: string; details?: Record<string, unknown> } })
    .failure;
  // 使用者必須知道要走多近，否則不知道該怎麼辦
  assert.match(failure.message, /412 公尺/);
  assert.equal(failure.details?.distanceM, 412);
  assert.equal(failure.details?.limitM, LIMITS.reportRadiusM);
});

test('定位精度不足被拒', () => {
  assert.equal(validateProximity(10, 250).ok, false);
  assert.equal(validateProximity(10, 0).ok, false);
  assert.equal(validateProximity(10, -1).ok, false);
  assert.equal(validateProximity(10, NaN).ok, false);
});

// MARK: - 文字

test('空白或 null 的補充說明通過', () => {
  assert.equal(validateNote(null).ok, true);
  assert.equal(validateNote('   ').ok, true);
});

test('超長文字被拒', () => {
  assert.equal(validateNote('字'.repeat(100)).ok, true);
  assert.equal(validateNote('字'.repeat(101)).ok, false);
});

test('含網址或帳號的文字被拒', () => {
  assert.equal(validateNote('去 https://spam.example 看看').ok, false);
  assert.equal(validateNote('加我 www.example.com').ok, false);
  assert.equal(validateNote('加 line.me/ti/p/xxx').ok, false);
  assert.equal(validateNote('找 @spamaccount').ok, false);
  // 正常回報不該被誤擋
  assert.equal(validateNote('等了 15 分鐘還沒看到車，站牌顯示 3 分鐘').ok, true);
});

// MARK: - 頻率限制

test('同站牌不同路線不互相阻擋', () => {
  const a = rateLimitKey('hash1', 'TPE50629', 'TPE10132');
  const b = rateLimitKey('hash1', 'TPE50629', 'TPE10874');
  assert.notEqual(a, b);
});

test('不同裝置不互相阻擋', () => {
  assert.notEqual(
    rateLimitKey('hash1', 'TPE50629', 'TPE10132'),
    rateLimitKey('hash2', 'TPE50629', 'TPE10132'),
  );
});

test('首次回報一律放行', () => {
  assert.equal(checkRateLimit(null, Date.now()).allowed, true);
});

test('120 秒內重複回報被擋，並回傳剩餘秒數', () => {
  const now = Date.now();
  const result = checkRateLimit(now - 42_000, now);
  assert.equal(result.allowed, false);
  assert.equal((result as { retryAfterSec: number }).retryAfterSec, 78);
});

test('超過 120 秒後放行', () => {
  const now = Date.now();
  assert.equal(checkRateLimit(now - 120_000, now).allowed, true);
  assert.equal(checkRateLimit(now - 200_000, now).allowed, true);
});

// MARK: - 交叉比對（產品核心價值）

test('官方無資料時為 unavailable，不是衝突', () => {
  const result = crossCheckDelay({
    tdxEstimateSec: null,
    reportedWaitMinutes: 20,
    recentDelayReportCount: 5,
  });
  assert.equal(result.verdict, 'unavailable');
});

test('官方顯示還很久時為 consistent', () => {
  const result = crossCheckDelay({
    tdxEstimateSec: 900,
    reportedWaitMinutes: 12,
    recentDelayReportCount: 4,
  });
  assert.equal(result.verdict, 'consistent');
});

test('單筆回報 + 等候時間正常 → consistent（避免警示氾濫）', () => {
  // 等 5 分鐘、官方說 3 分鐘後到，對 10 分鐘班距是完全正常的
  const result = crossCheckDelay({
    tdxEstimateSec: 150,
    reportedWaitMinutes: 5,
    recentDelayReportCount: 1,
  });
  assert.equal(result.verdict, 'consistent');
});

test('多人佐證 + 官方說即將到站 → conflicting', () => {
  const result = crossCheckDelay({
    tdxEstimateSec: 120,
    reportedWaitMinutes: 6,
    recentDelayReportCount: THRESHOLDS.corroborationCount,
  });
  assert.equal(result.verdict, 'conflicting');
  assert.match(result.message, /3 人回報未出現/);
});

test('單人等候異常久 + 官方說即將到站 → conflicting', () => {
  const result = crossCheckDelay({
    tdxEstimateSec: 60,
    reportedWaitMinutes: THRESHOLDS.soloWaitMinutes,
    recentDelayReportCount: 1,
  });
  assert.equal(result.verdict, 'conflicting');
  assert.match(result.message, /等候 10 分鐘/);
});

// MARK: - 挑選預估值

const etas = [
  { stopUID: 'S1', routeUID: 'R1', direction: 0, estimateSec: 300, stopStatus: 0 },
  { stopUID: 'S1', routeUID: 'R1', direction: 0, estimateSec: 120, stopStatus: 0 },
  { stopUID: 'S1', routeUID: 'R1', direction: 1, estimateSec: 30, stopStatus: 0 },
  { stopUID: 'S1', routeUID: 'R2', direction: 0, estimateSec: 45, stopStatus: 0 },
  { stopUID: 'S2', routeUID: 'R1', direction: 0, estimateSec: 15, stopStatus: 0 },
];

test('取同站同路線同方向中最近的一班', () => {
  assert.equal(pickEstimate(etas, 'S1', 'R1', 0), 120);
});

test('方向不符者不納入', () => {
  assert.equal(pickEstimate(etas, 'S1', 'R1', 1), 30);
});

test('查無資料時回 null', () => {
  assert.equal(pickEstimate(etas, 'S9', 'R1', 0), null);
});

test('stopStatus 非 0 者不視為即將到站', () => {
  // 末班已過（3）不該被當成「官方說即將到站」而觸發衝突警示
  const withStatus = [
    { stopUID: 'S1', routeUID: 'R1', direction: 0, estimateSec: 10, stopStatus: 3 },
  ];
  assert.equal(pickEstimate(withStatus, 'S1', 'R1', 0), null);
});
