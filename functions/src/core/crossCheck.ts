/**
 * 誤點回報與 TDX 官方預估的交叉比對。
 *
 * **這是整個 App 唯一官方管道給不了的東西。** 其餘功能（地圖、到站預估、
 * 路線搜尋）官方 App 都有；只有「多位使用者回報與官方預估不符」是本服務獨有。
 * 見 DESIGN.md §4.2。
 *
 * 純函式，不 import 任何 Firebase 套件，可用 `node --test` 直接驗證。
 */

export type Verdict = 'consistent' | 'conflicting' | 'unavailable';

export type CrossCheckResult = {
  verdict: Verdict;
  tdxEstimateSec: number | null;
  /** 繁體中文，可直接顯示給使用者 */
  message: string;
};

/**
 * 判定門檻。
 *
 * ⚠️ **這些數值是推估值，尚未經真實資料驗證。**
 * 上線後應以實際回報樣本檢視誤判率再調整——過於寬鬆會讓 `conflicting`
 * 警示氾濫而失去意義，過於嚴格則抓不到真正的異常。
 */
export const THRESHOLDS = {
  /** TDX 預估在此秒數內視為「官方認為即將到站」 */
  imminentSec: 180,
  /** 單筆回報要能獨立構成衝突所需的等候分鐘數 */
  soloWaitMinutes: 10,
  /** 多筆回報構成衝突所需的筆數（含本次） */
  corroborationCount: 3,
} as const;

export type CrossCheckInput = {
  /** TDX N1 對該站該路線的預估秒數。null 表示官方無資料 */
  tdxEstimateSec: number | null;
  /** 本次回報的等候分鐘數 */
  reportedWaitMinutes: number;
  /** 同站同路線在顯示時效內、**含本次**的誤點回報總數 */
  recentDelayReportCount: number;
};

/**
 * 判定本次誤點回報與官方資料是否衝突。
 *
 * 邏輯：
 *   - 官方無資料 → `unavailable`（無從比對，不是衝突）
 *   - 官方顯示即將到站，但已有多人回報未出現 → `conflicting`
 *   - 官方顯示即將到站，但單一使用者已等很久 → `conflicting`
 *   - 其餘 → `consistent`
 *
 * 為什麼需要「多人佐證」而非單筆就判定衝突：等 5 分鐘、官方說 3 分鐘後到，
 * 對 10 分鐘班距的路線是**完全正常**的。單筆回報的訊號太弱，
 * 只有在多人獨立回報、或單人等候時間明顯異常時才構成有意義的矛盾。
 */
export function crossCheckDelay(input: CrossCheckInput): CrossCheckResult {
  const { tdxEstimateSec, reportedWaitMinutes, recentDelayReportCount } = input;

  if (tdxEstimateSec === null || !Number.isFinite(tdxEstimateSec)) {
    return {
      verdict: 'unavailable',
      tdxEstimateSec: null,
      message: '官方目前沒有這班車的預估資料',
    };
  }

  const officialSaysImminent = tdxEstimateSec <= THRESHOLDS.imminentSec;

  if (!officialSaysImminent) {
    return {
      verdict: 'consistent',
      tdxEstimateSec,
      message: `官方預估約 ${Math.round(tdxEstimateSec / 60)} 分鐘後到站，與您的回報一致`,
    };
  }

  const corroborated = recentDelayReportCount >= THRESHOLDS.corroborationCount;
  const waitedTooLong = reportedWaitMinutes >= THRESHOLDS.soloWaitMinutes;

  if (corroborated) {
    return {
      verdict: 'conflicting',
      tdxEstimateSec,
      message:
        `⚠️ 官方預估 ${minutesText(tdxEstimateSec)}到站，` +
        `但已有 ${recentDelayReportCount} 人回報未出現`,
    };
  }

  if (waitedTooLong) {
    return {
      verdict: 'conflicting',
      tdxEstimateSec,
      message:
        `⚠️ 官方預估 ${minutesText(tdxEstimateSec)}到站，` +
        `但您已等候 ${reportedWaitMinutes} 分鐘`,
    };
  }

  return {
    verdict: 'consistent',
    tdxEstimateSec,
    message: `官方預估 ${minutesText(tdxEstimateSec)}到站`,
  };
}

function minutesText(sec: number): string {
  if (sec < 60) return '即將';
  return `${Math.round(sec / 60)} 分鐘內`;
}

/**
 * 自 N1 資料中挑出該站該路線的預估秒數。
 *
 * N1 可能對同一站同一路線回多筆（不同班次），取**最近的一班**——
 * 使用者在等的就是下一班車。
 */
export function pickEstimate(
  etas: Array<{
    stopUID: string;
    routeUID: string;
    direction: number;
    estimateSec: number | null;
    stopStatus: number;
  }>,
  stopUID: string,
  routeUID: string,
  direction: 0 | 1 | null,
): number | null {
  const candidates = etas.filter(
    (eta) =>
      eta.stopUID === stopUID &&
      eta.routeUID === routeUID &&
      (direction === null || eta.direction === direction) &&
      // stopStatus 非 0 代表未發車／不停靠／末班已過，這些不是「即將到站」
      eta.stopStatus === 0 &&
      typeof eta.estimateSec === 'number',
  );

  if (candidates.length === 0) return null;
  return Math.min(...candidates.map((eta) => eta.estimateSec as number));
}
