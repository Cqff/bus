# BusMap Functions — 回報寫入端

Cloud Functions（Firebase v2），實作 `docs/API_CONTRACT.md` §4 的三支 callable。

## 為什麼寫入不走 Firestore 直寫

150 公尺距離驗證、2 分鐘頻率限制、TDX 交叉比對這些檢查若在客戶端執行，
**是可以被繞過的**——任何人拿反編譯出的 Firebase config 就能用腳本直接寫資料庫。

因此 `firestore.rules` 對所有集合設 `allow write: if false`，寫入一律經過這裡。

## 核心邏輯不依賴 Firebase

`src/core/` 刻意**不 import 任何 Firebase 套件**，因此不需要 `npm install`
就能驗證：

```bash
node --test tests/core.test.ts
```

26 項測試涵蓋欄位驗證、距離與精度、文字過濾、頻率限制、以及交叉比對判定。

`src/index.ts` 只是 Firebase 的接線，**尚未經編譯或執行驗證**（需先安裝套件）。

## 匯出的 Functions

| 名稱 | 類型 | 用途 |
|---|---|---|
| `submitReport` | callable | 送出回報。驗證 → 交叉比對 → 寫入 → 更新聚合 |
| `flagReport` | callable | 檢舉。達 3 次自動隱藏 |
| `deleteReport` | callable | 刪除自己的回報。履行個資法當事人權利 |
| `purgeDeletedReports` | 每日 03:30 | 消化刪除佇列，自 BigQuery 移除 |
| `pruneDeletionRequests` | 每週日 04:00 | 清理 30 天前已完成的刪除請求紀錄 |

> ⚠️ `purgeDeletedReports` 的排程頻率與隱私權政策 §7.1 的「24 小時內完成」
> 直接綁定。**改頻率就必須同步改政策文字**，否則是不實陳述。

## 站牌座標從哪裡來

`submitReport` 要驗證 150 公尺距離，需要站牌座標。**Functions 不自行解析 TDX**
——那需要第二份金鑰，而且站牌合併邏輯會出現兩份實作終將分歧，
屆時 App 顯示的站位與驗證用的站位會對不上，是最難查的那種 bug。

改為向 proxy 取 `/v1/static/stopIndex`，冷啟動載入一次後快取 6 小時。
合併邏輯只存在 `backend/src/static/merge.ts` 一處。

**proxy 無法連線時 `submitReport` 會失敗**，這是刻意的：沒有座標就無法驗證
距離規則，略過檢查等同開後門。寧可暫時無法回報。

## 兩個容易踩雷的設計點

### 1. 隱私欄位必須拆集合，不能靠規則過濾

Firestore 的安全規則是**文件層級的全有全無**，無法指定「這份文件只回傳某些欄位」。

因此資料拆成兩份：

- `reports/{id}` —— 公開欄位，匿名使用者可讀
- `reportSecrets/{id}` —— `uid` / `deviceHash` / `reporterGeo` / `distanceToStopM`，**完全封鎖**

用相同的 document ID 關聯。BigQuery 串流只掛在 `reports` 上——
歷史分析不需要原始座標與裝置雜湊，少存一份也減少個資風險。

### 2. 刪除不是同步完成的

BigQuery 的 streaming buffer 在寫入後最長約 90 分鐘內**無法執行 DELETE**。
因此 `deleteReport` 只做兩件事：

1. 立即刪除 Firestore 熱資料（若還在 10 分鐘 TTL 內）
2. 寫入 `deletionRequests` 佇列，由每日排程批次清除 BigQuery

回應與 App 文案必須是「已受理刪除，24 小時內完成」——寫「已刪除」是不實陳述。

## 環境變數

| 變數 | 說明 |
|---|---|
| `PROXY_BASE_URL` | TDX proxy 位址。Functions **不自行持有 TDX 金鑰** |
| `DEVICE_HASH_SECRET` | IDFV 雜湊金鑰。存 Secret Manager，絕不進版控 |
| `BQ_DATASET` | BigQuery dataset，預設 `busmap` |
| `BQ_TABLE` | 表名，預設 `reports_raw_changelog`（擴充功能的預設命名）|
| `BQ_LOCATION` | 預設 `asia-east1`，須與 dataset 實際位置一致 |

```bash
firebase functions:secrets:set DEVICE_HASH_SECRET
```

> ⚠️ `DEVICE_HASH_SECRET` 一旦更換，所有既有的 `deviceHash` 都會對不上，
> 等同重置全部頻率限制紀錄。除非確定要這麼做，否則不要輪替。

## 部署

```bash
npm install
firebase deploy --only functions,firestore:rules,firestore:indexes
```

部署後還需在 Firebase Console 手動完成：

1. **啟用 TTL 政策** —— `reports.expiresAt`、`reportSecrets.expiresAt`、`rateLimits.expiresAt`
   （`firestore.indexes.json` 已宣告，但 TTL 需在 Console 確認啟用）
2. **啟用 Anonymous Authentication**
3. **啟用 App Check** 並註冊 App Attest（需要 Apple Developer 帳號）
4. **安裝 Stream Firestore to BigQuery 擴充功能**，來源集合設 `reports`

## 已知的未驗證項目

- `src/index.ts`、`src/purge.ts`、`src/stopIndex.ts` **尚未編譯或執行過**
  （需先 `npm install`）。純邏輯已抽到 `src/core/` 並有 26 項測試涵蓋。
- Firestore rules 與索引尚未以 emulator 驗證。
- `purgeDeletedReports` 依賴 Firestore→BigQuery 擴充功能的表名慣例
  （`reports_raw_changelog`），安裝擴充功能後請確認實際表名並調整 `BQ_TABLE`。
