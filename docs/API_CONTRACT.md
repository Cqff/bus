# 後端 API Contract v1

> 版本：v1.0
> 目的：讓 iOS App 與後端**並行開發**。此文件是雙方唯一的介面真實來源。
> 對應設計：`DESIGN.md`

---

## 0. 一個影響全域的取捨：即時端點不做身分驗證

Firebase Hosting CDN **不會快取帶有 `Authorization` 標頭的請求**。而 D1 決策的整個成本模型建立在 CDN 快取上（「100 個使用者看 270 路線 = 1 次回源」）。

因此：

| 端點類型 | 驗證 | 快取 | 理由 |
|---|---|---|---|
| **讀取即時/靜態資料**（`GET /v1/...`）| ❌ 無 | ✅ CDN 15s | 加了驗證 = CDN 失效 = 成本回到 US$95/月。且這些資料本來就是公開的政府開放資料 |
| **寫入回報**（callable）| ✅ App Check + Anonymous Auth | ❌ | 這裡才是濫用會造成實質損害的地方 |

**風險**：有人可以直接爬你的 `GET /v1/live/buses`。
**評估**：可接受——他能拿到的資料，自己去申請 TDX 也拿得到；他省下的只是你的快取。
**若日後被濫用**：加 Cloud Armor 依 IP 限流，或改用「短期簽章 URL」，兩者都不需要改 App 的資料流。

---

## 1. 基本約定

**Base URL**：`https://<your-project>.web.app/v1`
（Firebase Hosting rewrite → Cloud Run，讓 CDN 生效）

**編碼**：UTF-8 JSON
**時間格式**：ISO 8601 UTC，例 `2026-07-31T09:35:12Z`
**座標**：WGS84，`lat` / `lon` 為 double
**版本策略**：破壞性變更升 `/v2`，`/v1` 至少並存 3 個月

### 1.1 共用錯誤格式

所有非 2xx 回應：

```json
{
  "error": {
    "code": "REPORT_TOO_FAR",
    "message": "您距離站牌 412 公尺，請靠近至 150 公尺內再回報",
    "details": { "distanceM": 412, "limitM": 150 }
  }
}
```

`message` 為**繁體中文、可直接顯示給使用者**。App 應優先用 `code` 決定行為，`message` 決定文案。

### 1.2 全域錯誤碼

| HTTP | code | 說明 |
|---|---|---|
| 400 | `INVALID_ARGUMENT` | 參數缺漏或格式錯誤 |
| 404 | `NOT_FOUND` | 指定的 routeUID / stopUID 不存在 |
| 429 | `RATE_LIMITED` | 超過限流，`details.retryAfterSec` |
| 503 | `UPSTREAM_UNAVAILABLE` | TDX 無法連線，`details.lastGoodAt` 為最後一筆好資料時間 |
| 500 | `INTERNAL` | 未預期錯誤 |

> **`UPSTREAM_UNAVAILABLE` 的 App 行為**：不要顯示空地圖。改為顯示最後一次成功的資料並加上「⚠️ 官方資料來源中斷，顯示 N 分鐘前資料」橫幅。

---

## 2. 即時資料端點

### 2.1 `GET /v1/live/buses`

取得公車即時位置。**兩種模式擇一**，同時提供則 `route` 優先。

| 參數 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `route` | string | 模式A | RouteUID，例 `TPE10132` |
| `direction` | 0\|1 | 否 | 僅 `route` 模式有效，不給則兩向都回 |
| `bbox` | string | 模式B | `minLon,minLat,maxLon,maxLat`，最大跨距 0.15 度（約 15km）|
| `limit` | int | 否 | 預設 60，上限 200。僅 `bbox` 模式有效 |

**回應 200**

```json
{
  "serverTime": "2026-07-31T09:35:12Z",
  "buses": [
    {
      "plateNumb": "KKA-1234",
      "routeUID": "TPE10132",
      "routeName": "270",
      "direction": 0,
      "lat": 25.0330,
      "lon": 121.5654,
      "azimuth": 87,
      "speedKph": 18,
      "gpsTime": "2026-07-31T09:34:58Z",
      "ageSec": 14,
      "stale": false,
      "dutyStatus": 0,
      "busStatus": 0
    }
  ],
  "truncated": false,
  "oldestAgeSec": 14,
  "newestAgeSec": 3
}
```

| 欄位 | 說明 |
|---|---|
| `ageSec` | `serverTime - gpsTime`。**App 的「N 秒前」直接用這個值**，不要自己算（避免裝置時鐘偏移）|
| `stale` | `ageSec > 90`。App 據此顯示「訊號中斷」樣式 |
| `azimuth` | 0–359，正北為 0。App 用於旋轉方向箭頭 |
| `dutyStatus` | TDX 原值：0=正常 1=非營運 2=開往起點站 |
| `busStatus` | TDX 原值：0=正常 1=車禍 2=故障 3=塞車 4=緊急 5=加油 … |
| `truncated` | 為 true 表示結果被 `limit` 截斷，App 應提示「放大以查看更多」|

**快取標頭**
```
Cache-Control: public, max-age=15, s-maxage=15, stale-while-revalidate=30
```

> **`stale-while-revalidate=30`** 讓 TDX 短暫抖動時 CDN 仍能回舊資料，避免使用者看到空地圖。

**App 輪詢規則（必須遵守）**
- 前景每 **15 秒**；`scenePhase != .active` **立即停止**（省電 + 省流量）
- 回到前景**立即**打一次
- 連續 3 次失敗改為 60 秒退避，成功後恢復 15 秒
- 地圖平移中不觸發，平移停止 500ms 後才發請求（debounce）

---

### 2.2 `GET /v1/live/eta`

取得預估到站（TDX N1）。

| 參數 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `stop` | string | 模式A | StopUID，回傳該站所有路線 |
| `station` | string | 模式A' | StationUID，回傳該**站位**所有站牌所有路線（合併顯示用）|
| `route` | string | 模式B | RouteUID，回傳該路線所有站 |
| `direction` | 0\|1 | 否 | — |

**回應 200**

```json
{
  "serverTime": "2026-07-31T09:35:12Z",
  "etas": [
    {
      "stopUID": "TPE50629",
      "stationUID": "TPE9800",
      "routeUID": "TPE10132",
      "routeName": "270",
      "direction": 0,
      "estimateSec": 180,
      "stopStatus": 0,
      "plateNumb": "KKA-1234",
      "isLastBus": false,
      "srcUpdateTime": "2026-07-31T09:34:40Z",
      "ageSec": 32
    }
  ]
}
```

| `stopStatus` | 意義 | App 顯示 |
|---|---|---|
| 0 | 正常 | 依 `estimateSec` 顯示「約 N 分」/「將到站」|
| 1 | 尚未發車 | 「尚未發車」 |
| 2 | 交管不停靠 | 「不停靠」 |
| 3 | 末班車已過 | 「末班已過」 |
| 4 | 今日未營運 | 「今日未營運」 |

`estimateSec` 為 `null` 時一律看 `stopStatus`。

快取同 2.1。

---

## 3. 靜態資料

靜態資料**不走 API 逐次查詢**，而是每日打包成檔案由 App 下載快取（見 `DESIGN.md` §3.4）。

### 3.1 `GET /v1/static/manifest`

```json
{
  "version": "2026-07-31T04:00:00Z",
  "minAppBuild": 1,
  "files": {
    "stations":    { "url": "https://.../stations.v20260731.json.gz",    "sha256": "ab3f…", "bytes": 486211 },
    "routes":      { "url": "https://.../routes.v20260731.json.gz",      "sha256": "7c19…", "bytes": 91234 },
    "stopOfRoute": { "url": "https://.../stopOfRoute.v20260731.json.gz", "sha256": "d4e0…", "bytes": 1512345 },
    "shapes":      { "url": "https://.../shapes.v20260731.json.gz",      "sha256": "91aa…", "bytes": 2412345 }
  }
}
```

**Cache-Control**: `public, max-age=3600`

**App 流程**：啟動時取 manifest → `version` 與本機不同才下載 → 驗 `sha256` → 原子性替換本機快取。
`minAppBuild` 高於當前 build 時提示使用者更新 App（保留給未來破壞性資料格式變更）。

### 3.2 `stations.json` — **站位（已合併同站不同業者的站牌）**

> 這份檔案就是 `DESIGN.md` §2.3 標記的高風險項目的產物。
> **合併邏輯完全在後端**，App 只消費結果——這是把該風險隔離在單一位置的關鍵。

```json
[
  {
    "stationUID": "TPE9800",
    "name": "臺北車站",
    "nameEn": "Taipei Main Station",
    "lat": 25.0465,
    "lon": 121.5175,
    "stops": [
      { "stopUID": "TPE50629", "routeUID": "TPE10132", "direction": 0, "operatorID": "10012", "bearing": "S" },
      { "stopUID": "TPE50630", "routeUID": "TPE10132", "direction": 1, "operatorID": "10012", "bearing": "N" }
    ]
  }
]
```

**合併規則**（後端實作，記錄於此以利對照）：

1. **以 `CityCode + StationID` 分組**（實測 100% 提供，如 `TPE` + `9800` → `TPE9800`）
2. 無官方分組者，才以「站名完全相同 **且** 距離 < 50m」分群，
   `stationUID` 為 `SYN-<群組內字典序最小的 StopUID>`
3. 合併結果的 `lat`/`lon` 取成員站牌的重心

> ⚠️ **本規則曾經寫錯，且是靜默失效的那種錯。**
> 原設計規則 1 依賴 `StationUID`，但實測（2026-07-31，500 筆樣本）顯示
> 臺北市 `Bus/Stop` 的 `StationUID` 出現率為 **0%**，只有 `StationID` 是 100%。
> 照原設計執行不會拋任何錯誤，只是規則 1 永遠不觸發、全部站牌落入距離分群——
> 等於用推測取代 TDX 的權威分組。
>
> 前綴 `CityCode` 是為了日後擴充雙北時 `StationID` 不會跨城市碰撞。

### 3.3 `routes.json`

```json
[
  {
    "routeUID": "TPE10132",
    "routeName": "270",
    "nameEn": "270",
    "departureStop": "捷運景安站",
    "destinationStop": "松山車站",
    "operatorIDs": ["10012"],
    "busRouteType": 11
  }
]
```

### 3.4 `stopOfRoute.json`

```json
[
  {
    "routeUID": "TPE10132",
    "direction": 0,
    "stops": [
      { "stopUID": "TPE50629", "stationUID": "TPE9800", "sequence": 1, "lat": 25.0465, "lon": 121.5175, "name": "臺北車站" }
    ]
  }
]
```

### 3.5 `shapes.json`

```json
[
  { "routeUID": "TPE10132", "direction": 0, "encodedPolyline": "yzkwCkkxdV…" }
]
```

使用 Google Encoded Polyline Algorithm（precision 5）壓縮。App 端解碼後餵給 `MapPolyline`。

---

## 4. 回報（Cloud Functions Callable）

以下**不是** REST 端點，是 Firebase callable functions，App 用 `Functions.functions().httpsCallable(...)` 呼叫。
自動附帶 Anonymous Auth token 與 App Check token。

### 4.1 `submitReport`

**Request**

```ts
{
  type: "delay" | "crowding" | "stopIssue",

  stopUID: string,              // 必填
  routeUID: string | null,      // delay/crowding 必填；stopIssue 可 null
  direction: 0 | 1 | null,
  plateNumb: string | null,     // crowding 選填，綁定特定車輛

  payload: {
    crowdLevel?: "seat" | "stand" | "packed",   // type=crowding 必填
    reportedWaitMinutes?: number,                // type=delay 必填，1–60
    issueKind?: "signWrong" | "construction"
              | "inaccessible" | "other",        // type=stopIssue 必填
  },

  note: string | null,          // 選填，≤ 100 字

  deviceId: string,             // IDFV。伺服器 HMAC 後才存，原值不落地
  lat: number,                  // 回報當下使用者座標
  lon: number,
  locationAccuracyM: number,    // CLLocation.horizontalAccuracy
}
```

**Response（成功）**

```ts
{
  reportId: string,
  expiresAt: string,            // ISO8601
  crossCheck: {                 // 僅 type=delay 有值
    verdict: "consistent" | "conflicting" | "unavailable",
    tdxEstimateSec: number | null,
    message: string,            // 可直接顯示，例「⚠️ 官方預估 3 分鐘內到站，但已有 4 人回報未出現」
  } | null,
  stationSummary: {             // 送出後該站位的最新聚合，供 App 立即更新 UI
    delayCount: number,
    crowdingBreakdown: { seat: number, stand: number, packed: number },
    stopIssueCount: number,
  }
}
```

**錯誤碼**

| code | HTTP 對應 | 說明 | App 建議行為 |
|---|---|---|---|
| `UNAUTHENTICATED` | 401 | 無 Anonymous Auth token | 重新初始化 Auth 後重試一次 |
| `APP_CHECK_FAILED` | 403 | App Check 驗證失敗 | 顯示「無法驗證裝置，請重新啟動 App」|
| `REPORT_TOO_FAR` | 400 | 距站牌 > 150m，`details.distanceM` | 顯示距離並提示靠近 |
| `LOCATION_TOO_INACCURATE` | 400 | `locationAccuracyM > 100` | 提示「定位精度不足，請至空曠處」|
| `RATE_LIMITED` | 429 | 同裝置同站牌路線 120s 內已回報，`details.retryAfterSec` | 顯示倒數 |
| `NOTE_REJECTED` | 400 | 文字未通過過濾 | 提示修改 |
| `NOT_FOUND` | 404 | stopUID / routeUID 不存在 | 提示重新整理靜態資料 |

> **`REPORT_TOO_FAR` 的 UX 要求**：必須顯示實際距離（`details.distanceM`），否則使用者不知道要走多近。

### 4.2 `flagReport`

**Request**
```ts
{ reportId: string, deviceId: string, reason: "spam" | "offensive" | "inaccurate" | "other" }
```

**Response**
```ts
{ ok: true, hidden: boolean }   // hidden=true 表示此次檢舉已使該回報達門檻被隱藏
```

門檻：`flagCount >= 3` 自動 `status = "hidden"`。同裝置對同一 report 僅計一次。

**錯誤碼**：`ALREADY_FLAGGED`、`NOT_FOUND`、`UNAUTHENTICATED`、`APP_CHECK_FAILED`

### 4.3 `deleteReport`

供使用者刪除**自己送出**的回報，用於履行個資法的當事人刪除權。

**所有權如何驗證**：App 在本機保存自己送出的 `reportId` 清單（不上傳），
伺服器則比對 `reports.uid`／BigQuery 的 `uid` 欄位是否等於呼叫者的 Firebase 匿名 uid。
兩者皆符合才執行——這是在無帳號系統下唯一可靠的所有權證明。

**Request**
```ts
{ reportId: string }
```

**Response**
```ts
{
  ok: true,
  firestoreDeleted: boolean,   // 熱資料是否還在（10 分鐘內送出的才會是 true）
  analyticsPurgeAt: string,    // ISO8601，分析資料庫預計完成刪除的時間
}
```

**⚠️ 這支不是同步刪除，實作必須分兩段**

| 資料位置 | 刪除方式 | 時效 |
|---|---|---|
| Firestore `reports/` | 立即刪除 | 同步。超過 10 分鐘則已被 TTL 清除，回 `firestoreDeleted: false` |
| **BigQuery 歷史表** | **寫入 `deletionRequests` 佇列，由每日排程批次 DELETE** | 非同步，24 小時內 |

BigQuery 的 streaming buffer 在寫入後最長約 90 分鐘內**無法執行 DELETE**，
因此不能承諾即時刪除。App 的文案必須寫「已受理，將於 24 小時內完成」，
不可寫「已刪除」——後者是不實陳述。

**`deletionRequests/{requestId}`**（Firestore，排程作業的輸入）
```ts
{
  reportId: string,
  uid: string,          // 已驗證的請求者
  requestedAt: Timestamp,
  status: "pending" | "completed" | "failed",
  completedAt: Timestamp | null,
}
```

**錯誤碼**

| code | 說明 |
|---|---|
| `NOT_FOUND` | reportId 不存在於熱資料與歷史資料 |
| `NOT_OWNER` | 呼叫者 uid 與該回報的 uid 不符 |
| `ALREADY_REQUESTED` | 已有相同 reportId 的待處理刪除請求 |
| `UNAUTHENTICATED` / `APP_CHECK_FAILED` | 同前 |

> **已知限制（需寫入隱私權政策）**：Firebase 匿名 uid 存於 keychain，
> 正常情況下跨啟動保存，但**使用者刪除 App 後重裝會取得新的 uid**，
> 屆時將無法再刪除先前送出的回報。這是無帳號設計的必然結果。

---

## 5. Firestore 直接讀取契約

回報的**讀取**不走 HTTP，App 直接用 Firestore SDK 監聽（低延遲、省 Cloud Functions 呼叫）。
**寫入一律禁止**，由 Security Rules 強制。

### 5.1 `stopAggregates/{stationUID}` — 地圖標記用

App 依地圖視野以 `geohash` 前綴做 range query：

```swift
db.collection("stopAggregates")
  .whereField("geohash", isGreaterThanOrEqualTo: prefix)
  .whereField("geohash", isLessThan: prefix + "\u{f8ff}")
```

文件結構見 `DESIGN.md` §3.3。

> `active.*.count` 已由後端排除過期回報。App **不需要**自己過濾時間。

### 5.2 `reports/{reportId}` — 站牌詳情用

僅在使用者點開某站位時查詢：

```swift
db.collection("reports")
  .whereField("stationUID", isEqualTo: stationUID)
  .whereField("status", isEqualTo: "visible")
  .order(by: "createdAt", descending: true)
  .limit(to: 20)
```

**⚠️ 隱私欄位必須拆到另一個集合，不能靠 Security Rules 過濾**

Firestore 的安全規則是**文件層級的全有全無**——無法指定「這份文件只回傳某些欄位」。
若把 `deviceHash`、`reporterGeo` 存在 `reports/{id}` 裡，任何能讀取該文件的
client 就能讀到它們，規則擋不住。

因此資料拆為兩個集合：

| 集合 | 內容 | Client 權限 |
|---|---|---|
| `reports/{reportId}` | 公開欄位：`type, stopUID, stationUID, routeUID, routeName, direction, plateNumb, payload, note, createdAt, expiresAt, status, flagCount, verdict, tdxEstimateSec` | 可讀，**不可寫** |
| `reportSecrets/{reportId}` | 隱私欄位：`deviceHash, uid, reporterGeo, distanceToStopM, locationAccuracyM` | **完全不可讀寫**，僅 Admin SDK |

`reportSecrets` 使用與 `reports` 相同的 document ID，方便伺服器端關聯。
BigQuery 串流只掛在 `reports` 上——歷史分析不需要原始座標與裝置雜湊，
少存一份也減少個資風險。

> `deleteReport` 驗證所有權時由 Cloud Function 以 Admin SDK 讀取
> `reportSecrets/{reportId}.uid` 比對，client 全程接觸不到該值。

### 5.3 必要索引

需在 `firestore.indexes.json` 宣告：

| Collection | 欄位 |
|---|---|
| `reports` | `stationUID ASC, status ASC, createdAt DESC` |
| `reports` | `routeUID ASC, status ASC, createdAt DESC` |
| `stopAggregates` | `geohash ASC` |

---

## 6. 開發用 Mock

後端完成前，App 端可對 `GET /v1/live/buses` 與 `/v1/static/manifest` 使用固定 fixture 並行開發。

建議 fixture 置於 `mocks/`，內容需涵蓋以下**邊界情況**（這些是最容易漏測的）：

- `stale: true` 的車輛（驗證「訊號中斷」樣式）
- `truncated: true`（驗證「放大以查看更多」提示）
- `stopStatus` 為 1–4 的各種非正常狀態
- `UPSTREAM_UNAVAILABLE` 錯誤（驗證降級橫幅）
- 同一 `stationUID` 下有 4 個以上 `stops`（驗證站牌合併 UI）
- `crossCheck.verdict == "conflicting"`（驗證核心價值的呈現）

---

## 7. 尚未定案 / 待實測後補

| 項目 | 阻塞於 | 影響 |
|---|---|---|
| `bbox` 模式的實際效能上限 | TDX 全市 A1 資料量實測 | 可能需調整 `limit` 預設值 |
| 是否需要 `/v1/live/alerts`（營運通阻）| 產品決策 | v1.1 候選 |
| `note` 文字過濾規則 | 尚未選定方案 | 目前僅規劃長度 + 關鍵字黑名單 |
| Cloud Run 區域選擇 | — | 建議 `asia-east1`（台灣），延遲最低 |
