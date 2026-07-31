/**
 * BigQuery 刪除排程。
 *
 * 消化 `deletionRequests` 佇列，把使用者要求刪除的回報自長期分析資料庫移除。
 *
 * **為什麼需要排程而不能即時刪除**：透過 Firestore→BigQuery 擴充功能寫入的
 * 資料會先進入 streaming buffer，在寫入後最長約 90 分鐘內**無法執行 DML DELETE**。
 * 因此 `deleteReport` 只把請求入列，實際清除由此處每日批次處理。
 *
 * 隱私權政策 §7.1 承諾「24 小時內完成」——**若改變此排程頻率，
 * 必須同步修改政策文字**，否則就是不實陳述。
 *
 * ⚠️ 此檔尚未經編譯或執行驗證（需先 npm install 取得 Firebase 與 BigQuery 套件）。
 */

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { BigQuery } from '@google-cloud/bigquery';

const DATASET = process.env.BQ_DATASET ?? 'busmap';
/** Firestore→BigQuery 擴充功能建立的表名，預設為 `<collection>_raw_changelog` */
const TABLE = process.env.BQ_TABLE ?? 'reports_raw_changelog';

/** 單次執行處理的請求數上限，避免超出 Function 執行時間 */
const BATCH_SIZE = 500;

export const purgeDeletedReports = onSchedule(
  {
    // 每日 03:30 台北時間。挑離峰時段，且早於靜態資料同步的 04:00。
    schedule: '30 3 * * *',
    timeZone: 'Asia/Taipei',
    region: 'asia-east1',
    timeoutSeconds: 540,
  },
  async () => {
    const db = getFirestore();
    const bigquery = new BigQuery();

    const pending = await db
      .collection('deletionRequests')
      .where('status', '==', 'pending')
      .orderBy('requestedAt', 'asc')
      .limit(BATCH_SIZE)
      .get();

    if (pending.empty) {
      console.log('[purge] 沒有待處理的刪除請求');
      return;
    }

    const reportIds = pending.docs.map((doc) => doc.data().reportId as string);
    console.log(`[purge] 處理 ${reportIds.length} 筆刪除請求`);

    try {
      // 參數化查詢，避免 reportId 中的特殊字元造成注入
      await bigquery.query({
        query: `DELETE FROM \`${DATASET}.${TABLE}\` WHERE document_id IN UNNEST(@ids)`,
        params: { ids: reportIds },
        location: process.env.BQ_LOCATION ?? 'asia-east1',
      });
    } catch (error) {
      const message = (error as Error).message;
      console.error(`[purge] BigQuery 刪除失敗：${message}`);

      // streaming buffer 內的資料無法刪除。**保持 pending 讓明天重試**，
      // 不可標為 failed —— 那等於默默放棄使用者的刪除請求。
      if (/streaming buffer/i.test(message)) {
        console.log('[purge] 資料仍在 streaming buffer，維持 pending 待下次重試');
        return;
      }
      throw error;
    }

    const now = Timestamp.now();
    const batch = db.batch();
    for (const doc of pending.docs) {
      batch.update(doc.ref, { status: 'completed', completedAt: now });
    }
    await batch.commit();

    console.log(`[purge] 完成 ${reportIds.length} 筆`);
  },
);

/**
 * 清理已完成的刪除請求紀錄。
 *
 * `deletionRequests` 本身也含 uid，長期堆積沒有意義——保留 30 天供稽核後刪除。
 */
export const pruneDeletionRequests = onSchedule(
  {
    schedule: '0 4 * * 0',
    timeZone: 'Asia/Taipei',
    region: 'asia-east1',
  },
  async () => {
    const db = getFirestore();
    const cutoff = Timestamp.fromMillis(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const old = await db
      .collection('deletionRequests')
      .where('status', '==', 'completed')
      .where('requestedAt', '<', cutoff)
      .limit(BATCH_SIZE)
      .get();

    if (old.empty) return;

    const batch = db.batch();
    for (const doc of old.docs) batch.delete(doc.ref);
    await batch.commit();

    console.log(`[purge] 清理 ${old.size} 筆已完成的刪除請求紀錄`);
  },
);
