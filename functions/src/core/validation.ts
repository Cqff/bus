/**
 * 回報的驗證邏輯。
 *
 * **刻意不 import 任何 Firebase 套件**——純函式才能在沒有 node_modules
 * 的情況下用 `node --test` 直接驗證。Firebase 相關的部分關在 `../index.ts`。
 *
 * 這裡的每一條檢查都必須在**伺服器端**執行。客戶端也有同樣的檢查，
 * 但那只是為了提前給使用者回饋——客戶端是可以被繞過的，
 * 真正擋住濫用的是這裡。見 DESIGN.md §0.3。
 */

export const LIMITS = {
  /** 回報者與站牌的距離上限（公尺）。REQUIREMENTS.md §4.4 */
  reportRadiusM: 150,
  /** 定位精度門檻（公尺）。超過此值代表定位不可信 */
  maxAccuracyM: 100,
  /** 同裝置對同站牌路線的最小間隔（秒） */
  rateLimitWindowSec: 120,
  /** 選填文字長度上限 */
  noteMaxLength: 100,
  /** 誤點回報的等候分鐘數合理範圍 */
  waitMinutesMin: 1,
  waitMinutesMax: 60,
  /** 回報在地圖上的顯示時效（秒） */
  reportTtlSec: 600,
  /** 檢舉達此數量自動隱藏 */
  flagThreshold: 3,
} as const;

export type ReportType = 'delay' | 'crowding' | 'stopIssue';
export type CrowdLevel = 'seat' | 'stand' | 'packed';
export type IssueKind = 'signWrong' | 'construction' | 'inaccessible' | 'other';

export type ReportInput = {
  type: ReportType;
  stopUID: string;
  routeUID: string | null;
  direction: 0 | 1 | null;
  plateNumb: string | null;
  payload: {
    crowdLevel?: CrowdLevel;
    reportedWaitMinutes?: number;
    issueKind?: IssueKind;
  };
  note: string | null;
  deviceId: string;
  lat: number;
  lon: number;
  locationAccuracyM: number;
};

export type ValidationFailure = {
  code:
    | 'INVALID_ARGUMENT'
    | 'REPORT_TOO_FAR'
    | 'LOCATION_TOO_INACCURATE'
    | 'NOTE_REJECTED';
  message: string;
  details?: Record<string, unknown>;
};

export type ValidationResult =
  | { ok: true }
  | { ok: false; failure: ValidationFailure };

const fail = (
  code: ValidationFailure['code'],
  message: string,
  details?: Record<string, unknown>,
): ValidationResult => ({ ok: false, failure: { code, message, details } });

const OK: ValidationResult = { ok: true };

/** 檢查必填欄位與型別。 */
export function validateShape(input: ReportInput): ValidationResult {
  if (!input.stopUID) {
    return fail('INVALID_ARGUMENT', '缺少站牌代碼');
  }
  if (!input.deviceId) {
    return fail('INVALID_ARGUMENT', '缺少裝置識別碼');
  }
  if (!Number.isFinite(input.lat) || !Number.isFinite(input.lon)) {
    return fail('INVALID_ARGUMENT', '座標格式錯誤');
  }

  switch (input.type) {
    case 'delay': {
      if (!input.routeUID) return fail('INVALID_ARGUMENT', '誤點回報必須指定路線');
      const minutes = input.payload.reportedWaitMinutes;
      if (
        typeof minutes !== 'number' ||
        !Number.isInteger(minutes) ||
        minutes < LIMITS.waitMinutesMin ||
        minutes > LIMITS.waitMinutesMax
      ) {
        return fail(
          'INVALID_ARGUMENT',
          `等候時間必須為 ${LIMITS.waitMinutesMin}–${LIMITS.waitMinutesMax} 之間的整數分鐘`,
        );
      }
      return OK;
    }

    case 'crowding': {
      if (!input.routeUID) return fail('INVALID_ARGUMENT', '擁擠度回報必須指定路線');
      const level = input.payload.crowdLevel;
      if (level !== 'seat' && level !== 'stand' && level !== 'packed') {
        return fail('INVALID_ARGUMENT', '擁擠度數值不正確');
      }
      return OK;
    }

    case 'stopIssue': {
      const kind = input.payload.issueKind;
      if (
        kind !== 'signWrong' &&
        kind !== 'construction' &&
        kind !== 'inaccessible' &&
        kind !== 'other'
      ) {
        return fail('INVALID_ARGUMENT', '異常類型不正確');
      }
      return OK;
    }

    default:
      return fail('INVALID_ARGUMENT', '未知的回報類型');
  }
}

/**
 * 檢查回報者是否在站牌附近。
 *
 * 座標由客戶端提供，理論上可偽造（越獄裝置或模擬器）。此檢查擋掉的是
 * 「隨手亂點」與腳本濫用，擋不了決心作假的攻擊者——這是已知且接受的限制，
 * 見 DESIGN.md §4.1。
 */
export function validateProximity(
  distanceM: number,
  accuracyM: number,
): ValidationResult {
  if (!Number.isFinite(accuracyM) || accuracyM <= 0 || accuracyM > LIMITS.maxAccuracyM) {
    return fail(
      'LOCATION_TOO_INACCURATE',
      '定位精度不足，請至空曠處再試',
      { accuracyM, limitM: LIMITS.maxAccuracyM },
    );
  }
  if (distanceM > LIMITS.reportRadiusM) {
    return fail(
      'REPORT_TOO_FAR',
      // 必須顯示實際距離，否則使用者不知道要走多近。API_CONTRACT.md §4.1
      `您距離站牌 ${Math.round(distanceM)} 公尺，請靠近至 ${LIMITS.reportRadiusM} 公尺內再回報`,
      { distanceM: Math.round(distanceM), limitM: LIMITS.reportRadiusM },
    );
  }
  return OK;
}

/** 檢查選填文字。 */
export function validateNote(note: string | null): ValidationResult {
  if (note === null) return OK;
  const trimmed = note.trim();
  if (trimmed.length === 0) return OK;
  if (trimmed.length > LIMITS.noteMaxLength) {
    return fail(
      'NOTE_REJECTED',
      `補充說明不可超過 ${LIMITS.noteMaxLength} 字`,
      { length: trimmed.length, limit: LIMITS.noteMaxLength },
    );
  }
  // 阻擋常見的聯絡方式灌水。不做內容審查——那是檢舉機制的職責。
  if (/(https?:\/\/|www\.|line\.me|@[a-z0-9_]{4,})/i.test(trimmed)) {
    return fail('NOTE_REJECTED', '補充說明不可包含網址或帳號');
  }
  return OK;
}

/**
 * 頻率限制的鍵。
 *
 * 以「裝置 + 站牌 + 路線」為單位——同一人在同一站牌對**不同路線**回報是
 * 合理的（例如同時等 270 和 307），不該被互相擋住。
 */
export function rateLimitKey(
  deviceHash: string,
  stopUID: string,
  routeUID: string | null,
): string {
  return `${deviceHash}|${stopUID}|${routeUID ?? '-'}`;
}

/** 距上次回報是否已超過限制窗口。 */
export function checkRateLimit(
  lastReportAtMs: number | null,
  nowMs: number,
): { allowed: true } | { allowed: false; retryAfterSec: number; message: string } {
  if (lastReportAtMs === null) return { allowed: true };

  const elapsedSec = (nowMs - lastReportAtMs) / 1000;
  if (elapsedSec >= LIMITS.rateLimitWindowSec) return { allowed: true };

  const retryAfterSec = Math.ceil(LIMITS.rateLimitWindowSec - elapsedSec);
  return {
    allowed: false,
    retryAfterSec,
    message: `您剛剛已回報過這個站牌，請 ${retryAfterSec} 秒後再試`,
  };
}
