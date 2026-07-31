/**
 * Cloud Functions —— 回報的寫入端。
 *
 * ⚠️ **此檔尚未經編譯或執行驗證**（需先 `npm install` 取得 Firebase 套件）。
 * 純邏輯已抽到 `src/core/` 並有測試涵蓋；此處只是 Firebase 的接線。
 *
 * 為什麼寫入不走 Firestore 直寫：150 公尺距離驗證、2 分鐘頻率限制、
 * TDX 交叉比對這些檢查若在客戶端執行，是可以被繞過的。見 DESIGN.md §0.3。
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { setGlobalOptions } from 'firebase-functions/v2';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { createHmac } from 'node:crypto';

import {
  validateShape,
  validateProximity,
  validateNote,
  rateLimitKey,
  checkRateLimit,
  LIMITS,
} from './core/validation.ts';
import type { ReportInput } from './core/validation.ts';
import { crossCheckDelay, pickEstimate } from './core/crossCheck.ts';

initializeApp();
const db = getFirestore();

setGlobalOptions({
  region: 'asia-east1',
  maxInstances: 10,
  // App Check 強制執行——擋掉非官方 client 的請求
  enforceAppCheck: true,
});

/** TDX proxy 的位址。Functions 不自行持有 TDX 金鑰。 */
const PROXY_BASE = process.env.PROXY_BASE_URL ?? '';
/** 裝置識別碼的雜湊金鑰。存 Secret Manager，絕不進版控。 */
const DEVICE_HASH_SECRET = process.env.DEVICE_HASH_SECRET ?? '';

// MARK: - submitReport

export const submitReport = onCall<ReportInput>(async (request) => {
  const uid = requireAuth(request.auth?.uid);
  const input = request.data;

  const shape = validateShape(input);
  if (!shape.ok) throw toHttpsError(shape.failure);

  const note = validateNote(input.note);
  if (!note.ok) throw toHttpsError(note.failure);

  // 站牌座標由每日同步寫入，Functions 不重複解析 TDX 靜態資料
  const stopDoc = await db.collection('stops').doc(input.stopUID).get();
  if (!stopDoc.exists) {
    throw new HttpsError('not-found', '找不到這個站牌，請重新整理後再試');
  }
  const stop = stopDoc.data() as {
    stationUID: string;
    lat: number;
    lon: number;
    name: string;
  };

  const distanceM = haversineM(input.lat, input.lon, stop.lat, stop.lon);
  const proximity = validateProximity(distanceM, input.locationAccuracyM);
  if (!proximity.ok) throw toHttpsError(proximity.failure);

  // 裝置識別碼只以雜湊形式落地，原始 IDFV 不儲存
  const deviceHash = hashDevice(input.deviceId);
  const limitKey = rateLimitKey(deviceHash, input.stopUID, input.routeUID);
  const limitRef = db.collection('rateLimits').doc(limitKey);
  const limitDoc = await limitRef.get();
  const lastAt = limitDoc.exists
    ? (limitDoc.data()?.lastReportAt as Timestamp | undefined)?.toMillis() ?? null
    : null;

  const limit = checkRateLimit(lastAt, Date.now());
  if (!limit.allowed) {
    throw new HttpsError('resource-exhausted', limit.message, {
      code: 'RATE_LIMITED',
      retryAfterSec: limit.retryAfterSec,
    });
  }

  // 交叉比對僅適用誤點回報——擁擠度與站牌異常沒有官方資料可比
  let crossCheck = null;
  if (input.type === 'delay' && input.routeUID) {
    crossCheck = await runCrossCheck(input, stop.stationUID);
  }

  const now = Timestamp.now();
  const expiresAt = Timestamp.fromMillis(now.toMillis() + LIMITS.reportTtlSec * 1000);
  const reportRef = db.collection('reports').doc();

  const batch = db.batch();

  // 公開欄位
  batch.set(reportRef, {
    type: input.type,
    stopUID: input.stopUID,
    stationUID: stop.stationUID,
    routeUID: input.routeUID,
    direction: input.direction,
    plateNumb: input.plateNumb,
    payload: input.payload,
    note: input.note?.trim() || null,
    createdAt: now,
    expiresAt,
    status: 'visible',
    flagCount: 0,
    verdict: crossCheck?.verdict ?? null,
    tdxEstimateSec: crossCheck?.tdxEstimateSec ?? null,
  });

  // 隱私欄位另存——Firestore 規則無法過濾欄位，只能靠集合隔離。
  // 見 API_CONTRACT.md §5.2。
  batch.set(db.collection('reportSecrets').doc(reportRef.id), {
    uid,
    deviceHash,
    reporterGeo: { lat: input.lat, lon: input.lon },
    distanceToStopM: Math.round(distanceM),
    locationAccuracyM: input.locationAccuracyM,
    createdAt: now,
    expiresAt,
  });

  batch.set(limitRef, {
    lastReportAt: now,
    expiresAt: Timestamp.fromMillis(now.toMillis() + LIMITS.rateLimitWindowSec * 2000),
  });

  await batch.commit();

  const summary = await updateAggregate(stop.stationUID);

  return {
    reportId: reportRef.id,
    expiresAt: expiresAt.toDate().toISOString(),
    crossCheck,
    stationSummary: summary,
  };
});

// MARK: - flagReport

export const flagReport = onCall<{ reportId: string; deviceId: string; reason: string }>(
  async (request) => {
    requireAuth(request.auth?.uid);
    const { reportId, deviceId } = request.data;
    if (!reportId || !deviceId) {
      throw new HttpsError('invalid-argument', '缺少必要參數');
    }

    const deviceHash = hashDevice(deviceId);
    const flagRef = db.collection('flags').doc(`${reportId}|${deviceHash}`);
    const reportRef = db.collection('reports').doc(reportId);

    return db.runTransaction(async (tx) => {
      const [flagDoc, reportDoc] = await Promise.all([tx.get(flagRef), tx.get(reportRef)]);

      if (!reportDoc.exists) {
        throw new HttpsError('not-found', '這筆回報已不存在');
      }
      if (flagDoc.exists) {
        throw new HttpsError('already-exists', '您已檢舉過這筆回報');
      }

      const flagCount = ((reportDoc.data()?.flagCount as number | undefined) ?? 0) + 1;
      const hidden = flagCount >= LIMITS.flagThreshold;

      tx.set(flagRef, {
        reportId,
        reason: request.data.reason ?? 'other',
        createdAt: Timestamp.now(),
      });
      tx.update(reportRef, {
        flagCount,
        ...(hidden ? { status: 'hidden' } : {}),
      });

      return { ok: true, hidden };
    });
  },
);

// MARK: - deleteReport

/**
 * 刪除自己送出的回報。
 *
 * **不是同步刪除**：Firestore 熱資料可即時刪，但 BigQuery 的 streaming buffer
 * 在寫入後最長約 90 分鐘內無法 DELETE，故改以佇列 + 每日排程處理。
 * 回應中的文案必須是「已受理」而非「已刪除」。見 API_CONTRACT.md §4.3。
 */
export const deleteReport = onCall<{ reportId: string }>(async (request) => {
  const uid = requireAuth(request.auth?.uid);
  const { reportId } = request.data;
  if (!reportId) throw new HttpsError('invalid-argument', '缺少 reportId');

  // 所有權以 reportSecrets 的 uid 比對——client 全程接觸不到此值
  const secretRef = db.collection('reportSecrets').doc(reportId);
  const secretDoc = await secretRef.get();

  if (secretDoc.exists && secretDoc.data()?.uid !== uid) {
    throw new HttpsError(
      'permission-denied',
      '無法確認這筆回報屬於您。若您曾重新安裝 App，先前的回報將無法刪除。',
      { code: 'NOT_OWNER' },
    );
  }

  const existingRequest = await db
    .collection('deletionRequests')
    .where('reportId', '==', reportId)
    .where('status', '==', 'pending')
    .limit(1)
    .get();

  if (!existingRequest.empty) {
    throw new HttpsError('already-exists', '這筆回報已在刪除處理中', {
      code: 'ALREADY_REQUESTED',
    });
  }

  const reportRef = db.collection('reports').doc(reportId);
  const reportDoc = await reportRef.get();
  const firestoreDeleted = reportDoc.exists;

  // 熱資料若已被 TTL 清掉就沒得刪，這是正常情況而非錯誤
  const batch = db.batch();
  if (firestoreDeleted) batch.delete(reportRef);
  if (secretDoc.exists) batch.delete(secretRef);

  const purgeAt = Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1000);
  batch.set(db.collection('deletionRequests').doc(), {
    reportId,
    uid,
    requestedAt: Timestamp.now(),
    status: 'pending',
    completedAt: null,
  });

  await batch.commit();

  return {
    ok: true,
    firestoreDeleted,
    analyticsPurgeAt: purgeAt.toDate().toISOString(),
  };
});

// MARK: - Helpers

function requireAuth(uid: string | undefined): string {
  if (!uid) {
    throw new HttpsError('unauthenticated', '請重新啟動 App 後再試');
  }
  return uid;
}

function toHttpsError(failure: {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}): HttpsError {
  const map: Record<string, 'invalid-argument' | 'failed-precondition'> = {
    INVALID_ARGUMENT: 'invalid-argument',
    REPORT_TOO_FAR: 'failed-precondition',
    LOCATION_TOO_INACCURATE: 'failed-precondition',
    NOTE_REJECTED: 'invalid-argument',
  };
  return new HttpsError(map[failure.code] ?? 'invalid-argument', failure.message, {
    code: failure.code,
    ...failure.details,
  });
}

function hashDevice(deviceId: string): string {
  return createHmac('sha256', DEVICE_HASH_SECRET).update(deviceId).digest('hex');
}

/** 向 proxy 取當下的官方預估並判定是否與回報衝突。 */
async function runCrossCheck(input: ReportInput, stationUID: string) {
  try {
    const [etaResponse, recentCount] = await Promise.all([
      fetch(`${PROXY_BASE}/v1/live/eta?stop=${encodeURIComponent(input.stopUID)}`),
      countRecentDelayReports(input.stopUID, input.routeUID!),
    ]);

    if (!etaResponse.ok) return null;
    const body = (await etaResponse.json()) as {
      etas: Array<{
        stopUID: string;
        routeUID: string;
        direction: number;
        estimateSec: number | null;
        stopStatus: number;
      }>;
    };

    const estimate = pickEstimate(
      body.etas,
      input.stopUID,
      input.routeUID!,
      input.direction,
    );

    return crossCheckDelay({
      tdxEstimateSec: estimate,
      reportedWaitMinutes: input.payload.reportedWaitMinutes ?? 0,
      // +1 把本次回報算進去
      recentDelayReportCount: recentCount + 1,
    });
  } catch {
    // 比對失敗不該讓整筆回報送不出去——回報本身仍有價值
    return null;
  }
}

async function countRecentDelayReports(stopUID: string, routeUID: string): Promise<number> {
  const since = Timestamp.fromMillis(Date.now() - LIMITS.reportTtlSec * 1000);
  const snapshot = await db
    .collection('reports')
    .where('stopUID', '==', stopUID)
    .where('routeUID', '==', routeUID)
    .where('type', '==', 'delay')
    .where('createdAt', '>=', since)
    .count()
    .get();
  return snapshot.data().count;
}

/** 重建站位聚合。App 的地圖標記讀這份，不必逐筆掃 reports。 */
async function updateAggregate(stationUID: string) {
  const since = Timestamp.fromMillis(Date.now() - LIMITS.reportTtlSec * 1000);
  const snapshot = await db
    .collection('reports')
    .where('stationUID', '==', stationUID)
    .where('status', '==', 'visible')
    .where('createdAt', '>=', since)
    .get();

  const crowding = { seat: 0, stand: 0, packed: 0 };
  let delayCount = 0;
  let conflictingCount = 0;
  let stopIssueCount = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data();
    switch (data.type) {
      case 'delay':
        delayCount++;
        if (data.verdict === 'conflicting') conflictingCount++;
        break;
      case 'crowding': {
        const level = data.payload?.crowdLevel as keyof typeof crowding | undefined;
        if (level && level in crowding) crowding[level]++;
        break;
      }
      case 'stopIssue':
        stopIssueCount++;
        break;
    }
  }

  const summary = {
    stationUID,
    delayCount,
    conflictingCount,
    crowding,
    stopIssueCount,
    updatedAt: FieldValue.serverTimestamp(),
  };

  await db.collection('stopAggregates').doc(stationUID).set(summary, { merge: true });

  return { stationUID, delayCount, conflictingCount, crowding, stopIssueCount };
}

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
