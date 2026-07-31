# 台北市公車即時回報地圖 App — 系統設計

> 版本：v0.2
> 對應需求：`docs/REQUIREMENTS.md`
> 狀態：**架構已定案**（D1–D5 五項決策皆已確認）

---

## 0. 設計前提中的三個硬事實

在進入架構前，先列出查證後發現、且**改變了原始規劃**的三件事。

### 0.1 「誤差 30 秒」受限於資料源，不受限於你的後端

TDX 官方文件（[公車資料入門指引](https://motc-ptx.gitbook.io/tdx-zi-liao-shi-yong-kui-hua-bao-dian/ling-yu-zi-liao-ru-men-zhi-yin/gong-ju-zi-liao-ru-men-zhi-yin.md)）明載動態資料（A1/A2/N1）**更新頻率為每分鐘**。

端到端延遲的組成：

```
真實車輛位置
  └─ 車機回傳延遲          （不可控）
      └─ TDX 資料更新週期   ≤ 60s   ← 瓶頸在這裡，不可控
          └─ 後端拉取週期    15s    ← 只有這段可控
              └─ App 輪詢週期 15s
```

**結論**：後端 15 秒拉取是合理的（確保 TDX 一有新資料就在 15 秒內取得），但 **App 上顯示的位置對「真實世界」的誤差最壞情況仍會超過 30 秒。這是資料源的物理限制，不是實作問題。**

**設計對策**（誠實面對，而非隱藏）：
- 每個公車標記顯示 **`GPSTime` 的相對時間**（「12 秒前」／「48 秒前」）
- 資料超過 90 秒未更新的車輛，標記轉半透明並標示「訊號中斷」
- 這反而是相對官方 App 的差異化優勢：多數 App 不告訴你資料有多舊

> ⚠️ **待實測**：台北市 A1 實際推送頻率可能優於文件所述（PTX 時代台北市 A1 約 20 秒）。
> 取得金鑰後第一件事就是實測連續 10 分鐘的 `GPSTime` 分布，再回頭校準參數與 UI 文案。

### 0.2 TDX API 金鑰絕對不能放進 iOS App

TDX 使用 OAuth2 client credentials。任何打包進 App 的字串都可被反編譯取出，金鑰外洩會導致配額被盜用、帳號被停權。

**結論**：iOS App **一律不直接呼叫 TDX**，所有 TDX 存取經過自家後端代理。這不是可選項。

### 0.3 「免登入」≠「免驗證」

若 App 直接用 Firebase SDK 寫 Firestore，由於沒有身分驗證，任何人拿 App 內的 Firebase config（同樣可反編譯取得）就能用腳本無限灌爆資料庫——「2 分鐘限一次」「150 公尺內」通通會被繞過，因為那些檢查都在被繞過的客戶端裡。

**結論**（決策 D3）：
- **Firebase Anonymous Authentication**：App 啟動時自動取得匿名 uid，使用者**完全無感、零輸入**
- **Firebase App Check**（App Attest）：擋掉非官方 client
- **所有回報走 Cloud Functions callable，禁止 client 直接寫 Firestore**。距離驗證、頻率限制、TDX 比對全部在伺服器端執行

### 0.4 ⚠️ TDX 呼叫配額可能限制整個輪詢設計（2026-07-31 實測發現）

實測時僅送出 5 個小請求就收到 `429 API rate limit exceeded`，且是 39ms 內
由閘道層直接拒絕。

官方文件**只公告**：

| 限制 | 數值 | 錯誤碼 |
|---|---|---|
| 每秒平行請求 | 50 次/秒（每 IP）| 423 |
| 並行連接 | 60 個（每 IP）| 416 |
| 未註冊會員 | 50 次/日 | — |
| **一般會員的呼叫次數配額** | **未公告** | **429** |

論壇上的說法互相矛盾（每把金鑰每分鐘 5 次 vs 每 IP 每分鐘 20 次）。

**這直接威脅現行設計**：每 15 秒拉一次 A1 + N1 等於**每分鐘 8 次呼叫**。
配額若為 5 次/分鐘，設計不成立。

**因應**：

1. `npm run measure-quota` 實測真實配額與恢復時間，據此設定 `POLL_INTERVAL_MS`
2. `liveCache` 已內建 429 指數退避（間隔加倍，上限 5 分鐘；成功後以 1.5 倍逐步收回），
   但那是保險而非常態——正解是把間隔直接設在配額內
3. 若配額過低，可考慮申請 TDX 進階服務提高額度

**一個緩解此問題的既有設計**：D1 決策的 CDN 快取讓 TDX 呼叫量與**使用者人數無關**
——100 人或 10,000 人同時使用，對 TDX 的呼叫次數完全相同。
在配額如此吃緊的情況下，這個設計從「省成本」升級為「可行性的必要條件」。

**與 §0.1 的關係**：TDX 動態資料本來就每分鐘才更新，因此把輪詢間隔拉到
30–60 秒**不會實際損失資料新鮮度**。配額限制與資料源限制指向同一個結論——
「誤差 30 秒」做不到，而 App 顯示資料時間戳的設計因此更顯必要。

---

## 1. 系統架構

```
┌─────────────────────────────────────────────────────────────┐
│  iOS App (SwiftUI + MapKit, iOS 18+)                        │
│                                                              │
│  ├─ 靜態資料：站牌/路線/站序  → 本機快取，每日檢查更新       │
│  ├─ 公車即時位置              → HTTPS 輪詢（15s）  [D1]      │
│  └─ 使用者回報                → Firestore listener（即時）   │
└───────────┬──────────────────────────┬──────────────────────┘
            │ ① 讀即時位置              │ ② 讀回報   ③ 送出回報
            │   HTTPS GET               │  listener    callable
            ▼                           ▼              ▼
┌───────────────────────┐   ┌──────────────────────────────────┐
│ Firebase Hosting CDN  │   │ Firestore          Cloud Functions│
│  快取 15s（關鍵成本點）│   │  reports/          submitReport() │
└───────────┬───────────┘   │  stopAggregates/   flagReport()   │
            │ 快取未命中才回源│   │  (TTL 10 min)      syncStatic()   │
            ▼               └──────────┬───────────────────────┘
┌───────────────────────────────────┐  │ Firestore→BigQuery Extension
│ Cloud Run: TDX Proxy              │  ▼
│  ├─ 每 15s 拉 TDX A1/A2/N1（全市）│ ┌──────────────────┐
│  ├─ 記憶體快取 + 空間索引         │ │ BigQuery         │
│  └─ 提供 /live 查詢端點           │ │ 歷史回報永久留存  │
└───────────┬───────────────────────┘ │ （未來 AI 分析）  │
            ▼                          └──────────────────┘
┌───────────────────────────────────┐
│ TDX API（交通部運輸資料流通服務） │
│  https://tdx.transportdata.tw     │
└───────────────────────────────────┘
```

### 1.1 為什麼即時位置**不走** Firestore（決策 D1）

訪談初步構想是「後端寫入 Firestore → App 用 snapshot listener 即時更新」。實際估算成本後不可行：

| 方案 | 寫入量估算 | 每月成本（粗估）|
|---|---|---|
| A. 每台車一份 document | 全市約 3,000 台 × 4 次/分 = 720 萬 writes/天 | 💸 約 US$390/月 |
| B. 按路線聚合寫 Firestore | 約 300 路線 × 4 次/分 = 173 萬 writes/天 | 💸 約 US$95/月 |
| **C. HTTP 端點 + CDN 快取（採用）** | 0 Firestore writes | ✅ 約 US$5–14/月 |

**理由**：
1. TDX 本身只有分鐘級更新，「即時推送」相對「15 秒輪詢」在使用者感知上**沒有差別**——為感知不到的差異付 20 倍成本不合理
2. CDN 快取讓「100 個使用者同時看 270 路線」只產生 **1 次**回源請求
3. Firestore 仍用在**真正需要即時同步、且寫入量小**的地方：使用者回報

### 1.2 Cloud Run vs Cloud Functions

TDX Proxy 用 **Cloud Run（min-instances=1）**，因為它需要**常駐記憶體快取**全市公車位置與空間索引。Cloud Functions 實例會被回收，每次冷啟動都要重新拉全量資料。

`min-instances=1` 約 US$5–8/月，是本架構的主要固定成本。

---

## 2. TDX 整合

### 2.1 端點

Base URL：`https://tdx.transportdata.tw/api/basic/v2/` ／ City 參數：`Taipei`

| 用途 | 端點 | 更新頻率 | 使用方式 |
|---|---|---|---|
| 公車即時位置（A1）| `Bus/RealTimeByFrequency/City/Taipei` | 每分鐘 | Cloud Run 每 15s 拉全市 |
| 到離站事件（A2）| `Bus/RealTimeNearStop/City/Taipei` | 每分鐘 | 每 15s，判定「已到站」|
| 預估到站（N1）| `Bus/EstimatedTimeOfArrival/City/Taipei` | 每分鐘 | 每 15s，**誤點比對基準** |
| 路線基本資料 | `Bus/Route/City/Taipei` | 每日 | 每日 04:00 同步 |
| 站牌資料 | `Bus/Stop/City/Taipei` | 每日 | 每日 04:00 同步 |
| 路線站序 | `Bus/StopOfRoute/City/Taipei` | 每日 | 每日 04:00 同步 |
| 路線線型 | `Bus/Shape/City/Taipei` | 每日 | 每日 04:00 同步（畫路線用）|

> **實測進度（2026-07-31）**
>
> | 項目 | 狀態 |
> |---|---|
> | v2 端點是否仍可用 | ✅ Route / A1 / N1 / Stop 全部正常，無改版 |
> | 欄位名稱 | ✅ 已核對並修正（`Bearing` 非 `StopBearing`；Bus/Stop 無 `RouteUID`）|
> | **呼叫配額** | ❌ **5 個請求即 429**，見 §0.4——最高優先待解 |
> | 全市單次回應資料量 | ⏳ 未測成（被配額擋住），待配額問題解決後重測 |
> | A1 實際更新頻率 | ⏳ 同上 |
>
> 資料量若過大（數 MB），改用空間篩選（`$spatialFilter`）分區拉取——
> 但注意分區會**增加呼叫次數**，在配額吃緊時反而更糟，兩者需一併考量。

### 2.2 認證

OAuth2 client credentials，token 有效期約 24 小時。Cloud Run 快取 token，到期前 5 分鐘自動更新。
credentials 存 **Secret Manager**，不進版控。

### 2.3 關鍵識別碼

| 欄位 | 說明 | 注意事項 |
|---|---|---|
| `RouteUID` | 路線唯一碼（如 `TPE10132`）| 跨縣市唯一，**用它當 key，不要用 RouteName** |
| `StopUID` | 站牌唯一碼（如 `TPE50629`）| 同一實體站位、不同業者/方向會有**不同 StopUID** |
| `StationUID` | 站位唯一碼 | 聚合同名站牌用 |
| `PlateNumb` | 車牌 | 車輛的實務主鍵 |
| `Direction` | 0=去程 1=返程 | 回報必須帶方向，否則語意不清 |

> ⚠️ TDX 文件特別提醒：「同一站牌會因為分屬不同的客運業者而有不同的 StopID」。
> **站牌合併顯示**需用 `StationUID` 或座標鄰近性做群組——這是最容易被低估的工作量，請預留時間。

---

## 3. 資料模型

### 3.1 `reports/{reportId}` — 使用者回報（Firestore，TTL 10 分鐘）

```ts
{
  type: "delay" | "crowding" | "stopIssue",

  // 位置錨點
  stopUID: string,
  stationUID: string,          // 同站群組查詢用
  routeUID: string | null,     // stopIssue 可為 null
  direction: 0 | 1 | null,
  plateNumb: string | null,    // 擁擠度回報可綁定特定車輛

  // 依 type 而異的內容
  payload: {
    crowdLevel?: "seat" | "stand" | "packed",       // crowding
    reportedWaitMinutes?: number,                    // delay
    issueKind?: "signWrong" | "construction"
              | "inaccessible" | "other",            // stopIssue
  },

  note: string | null,          // 選填文字，≤ 100 字

  // 防濫用 / 稽核（不回傳給 client）
  deviceHash: string,           // HMAC-SHA256(IDFV, serverSecret)，不存原值
  uid: string,                  // Firebase 匿名 uid
  reporterGeo: GeoPoint,        // 回報當下使用者座標
  distanceToStopM: number,      // 伺服器算出的距離，稽核用

  // 官方資料交叉比對（僅 delay 類型）
  tdxCrossCheck: {
    checkedAt: Timestamp,
    tdxEstimateSec: number | null,
    verdict: "consistent" | "conflicting" | "unavailable",
  } | null,

  // 生命週期
  createdAt: Timestamp,
  expiresAt: Timestamp,         // createdAt + 10min，Firestore TTL 設於此欄
  status: "visible" | "hidden", // 檢舉達門檻 → hidden
  flagCount: number,

  geohash: string,              // reporterGeo 的 geohash（precision 7）
}
```

> v1.1 將新增：`photoPath`、`photoStatus`（照片功能延後，決策 D5）

### 3.2 歷史留存（決策 D2）

Firestore TTL 會**真的刪除**文件，因此不能靠它留存歷史。

**設計**：透過 Firebase Extension「Stream Firestore to BigQuery」，每筆 `reports/` 寫入時自動複寫一份到 BigQuery。

- **Firestore**：只留 10 分鐘熱資料 → 即時查詢層，成本受控
- **BigQuery**：永久留存 → 分析層，SQL 適合做「尖峰誤點熱區」等統計，未來接 AI 分析走這條路

比「Firestore 永久留存」便宜非常多，且 BigQuery 本來就是分析的正確工具。

### 3.3 `stopAggregates/{stationUID}` — 站位聚合（讀取優化）

App 若直接 query `reports/` 顯示「哪些站有回報」，會讀取大量文件。改由 Cloud Function 在回報寫入時更新聚合文件：

```ts
{
  stationUID: string,
  location: GeoPoint,
  geohash: string,
  updatedAt: Timestamp,
  active: {   // 10 分鐘內的有效回報摘要
    delay:     { count: number, latestAt: Timestamp,
                 conflictingCount: number },      // 與官方不符的筆數
    crowding:  { count: number, latestAt: Timestamp,
                 breakdown: { seat: number, stand: number, packed: number } },
    stopIssue: { count: number, latestAt: Timestamp },
  }
}
```

App 地圖只監聽視野內的聚合文件（geohash 前綴 range query），點擊站牌才載入該站詳細 `reports/`。

### 3.4 靜態資料

站牌／路線／站序／線型**不放 Firestore**——每日才變一次，放 Firestore 浪費讀取配額。

**設計**：Cloud Run 每日 04:00 同步後，產生壓縮 JSON 上傳 Cloud Storage，附 `version` 字串。
App 啟動時比對 version，有更新才下載，存入本機（SwiftData 或直接存檔）。

台北市站牌約 5,000 筆、路線約 300 條，壓縮後預估 1–3 MB，完全可接受。

---

## 4. 關鍵流程

### 4.1 送出回報（`submitReport` callable）

伺服器端依序驗證，**任一關卡失敗即拒絕**：

```
1. App Check token 有效？                    → 否則 403
2. Firebase Anonymous Auth uid 存在？        → 否則 401
3. haversine(reporterGeo, stop.location)
   ≤ 150m？                                  → 否則「請靠近站牌再回報」
4. deviceHash + stopUID + routeUID
   在 120 秒內已有回報？                     → 否則「請稍後再回報」
5. note 長度 ≤ 100 且通過文字過濾？
6. type == "delay" → 查當下 TDX N1 做交叉比對
7. 寫入 reports/，設 expiresAt = now + 10min
8. 觸發 stopAggregates 更新
9. Extension 自動同步至 BigQuery
```

> **注意**：第 3 步座標由客戶端提供，理論上可偽造（越獄裝置或模擬器）。
> 伺服器端驗證擋掉的是「隨手亂點」與腳本濫用，擋不了決心作假的攻擊者。
> MVP 這個強度足夠；若日後濫用嚴重，再加入「回報前需連續定位 N 秒且軌跡合理」的檢查。

### 4.2 誤點回報與 TDX 交叉比對（核心價值）

```
使用者回報「270 在 XX 站尚未出現，已等 12 分鐘」
  ↓
伺服器查 TDX N1（該站該路線的 EstimateTime）
  ↓
┌ TDX 顯示「即將進站」但多人回報未出現 → verdict: "conflicting"
│   → UI 顯示「⚠️ 多位使用者回報與官方預估不符」  ← 本 App 的核心價值
├ TDX 也顯示無班次/長時間              → verdict: "consistent"
│   → UI 顯示「官方資料一致」
└ TDX 無資料                            → verdict: "unavailable"
```

**`conflicting` 是這個 App 最有價值的輸出**——正是官方 App 給不了的資訊。UI 上應讓這類警示最顯眼。

### 4.3 檢舉

使用者可檢舉不當的文字回報 → `flagReport` callable → `flagCount++`
達門檻（建議 3）自動設 `status = "hidden"`，同一裝置對同一回報僅能檢舉一次。

### 4.4 「我的回報」與刪除權（決策 D6）

匿名設計與個資法的當事人權利互相衝突：沒有帳號就無法驗證身分，
無法驗證身分就無法安全地受理刪除請求（否則任何人都能刪掉別人的回報）。

**解法**：以「本機清單 + 匿名 uid」雙重驗證取代帳號。

```
送出回報成功
  └─ App 將 reportId 等摘要寫入本機，不上傳
      └─ 「我的回報」畫面讀本機清單顯示
          └─ 使用者按刪除 → deleteReport(reportId)
              └─ 伺服器比對 report.uid == 呼叫者 uid
                  ├─ Firestore：立即刪除（若尚未被 TTL 清掉）
                  └─ BigQuery：寫入 deletionRequests 佇列
                      └─ 每日排程批次 DELETE（24 小時內完成）
```

**為什麼不能即時刪 BigQuery**：streaming insert 後最長約 90 分鐘位於 streaming buffer，
期間 DML DELETE 無法作用。因此 App 文案必須是「已受理刪除，24 小時內完成」，
**不可寫「已刪除」**——那是不實陳述。

**本機清單保留期限**：**不隨回報失效而刪除**。
回報在地圖上 10 分鐘後消失，但 BigQuery 那份是永久保存的——
使用者要能刪的正是那一份，所以本機索引必須一直留著。

**已知限制**：匿名 uid 存於 keychain，刪除 App 後重裝會取得新 uid，
先前送出的回報將無法再刪除。此限制必須據實寫入隱私權政策。

---

## 5. iOS App 設計

### 5.1 模組

```
BusMap/
├─ App/
│   └─ BusMapApp.swift
├─ Core/
│   ├─ BusAPIClient.swift        // 打自家後端，不碰 TDX
│   ├─ LiveBusStore.swift        // @Observable，15s 輪詢 + 生命週期管理
│   ├─ StaticDataStore.swift     // 站牌/路線本機快取 + 每日更新檢查
│   ├─ ReportService.swift       // Firebase callable
│   ├─ LocationService.swift     // CoreLocation
│   └─ DeviceIdentity.swift      // IDFV 取得
├─ Features/
│   ├─ Map/
│   │   ├─ MapScreen.swift
│   │   ├─ BusAnnotation.swift       // 路線號碼標籤 + 時效指示
│   │   └─ StopAnnotation.swift
│   ├─ RouteSearch/
│   │   └─ RouteSearchSheet.swift
│   ├─ StopDetail/
│   │   └─ StopDetailSheet.swift
│   └─ Report/
│       └─ ReportSheet.swift
└─ Resources/
```

### 5.2 地圖顯示策略（決策 D4）

iOS 18 的 SwiftUI `Map` **沒有內建 annotation clustering**（UIKit `MKMapView` 才有 `clusteringIdentifier`），因此顯示量必須按縮放層級控制。

| 狀態 | 顯示內容 |
|---|---|
| **預設（未選路線，視野 ≤ 3km）** | 附近所有路線公車，小型路線號碼標籤，**上限 60 台**；加站牌 |
| 未選路線，視野 > 3km | 隱藏公車，只留有回報的站位聚合標記 |
| **已選路線** | 只顯示該路線公車 + 站牌 + 路線線型（乾淨模式）← 主要使用情境 |

台北市約 3,000 台公車分布在 272 km²，1 平方公里平均十餘台，預設縮放層級下 SwiftUI Map 可負擔。
「已選路線」情境單條路線通常 10–40 台車，毫無壓力。

若日後需要 clustering，再用 `UIViewRepresentable` 包 `MKMapView`。

### 5.3 公車標記設計

每個標記包含：路線號碼（主體）、行進方向（箭頭）、**資料時效**。

- ≤ 30 秒：正常顯示
- 30–90 秒：標籤下方顯示「N 秒前」
- \> 90 秒：半透明 + 「訊號中斷」

### 5.4 定位權限

`Info.plist`（需與隱私政策一致）：

```
NSLocationWhenInUseUsageDescription
= 用於顯示您附近的公車站牌，以及在您回報公車狀況時確認您位於站牌附近。
```

**只用 When In Use，不申請 Always**（MVP 無背景功能，申請 Always 會提高審核風險與使用者疑慮）。

---

## 6. 成本估算（MVP，假設日活躍 500 人）

| 項目 | 估算 | 月成本 |
|---|---|---|
| Cloud Run（min-instances=1）| 常駐 1 實例 | US$5–8 |
| Firebase Hosting CDN | 流量為主 | US$0–3 |
| Firestore（回報讀寫）| 量小 | US$0–2（多在免費額度內）|
| BigQuery（歷史留存）| 小量 | US$0–1 |
| **合計** | | **約 US$5–14/月** |
| Apple Developer Program | 年費 | US$99/年 |

TDX API 本身免費（需註冊）。
> 照片延後（D5）後，Cloud Storage 與 Cloud Vision 兩項成本歸零——後者原本是**唯一可能失控**的帳單項目。

---

## 7. 時程與風險

一人開發、iOS + 後端全包：

| 工作項 | 預估 | 風險 |
|---|---|---|
| TDX 串接 + Cloud Run proxy | 1.5 週 | 🟡 資料量與頻率限制未知 |
| 靜態資料同步 + 站牌合併邏輯 | 1 週 | 🔴 **最容易被低估**（同站不同 StopUID）|
| SwiftUI 地圖 + 即時公車顯示 | 1.5 週 | 🟢 |
| 路線搜尋 + 路線篩選 | 0.5 週 | 🟢 |
| 回報流程（三型 + 選填文字）| 1 週 | 🟢 |
| 防濫用（Auth/AppCheck/rate limit/距離）| 0.5 週 | 🟢 |
| 誤點 TDX 交叉比對 | 0.5 週 | 🟡 |
| 「我的回報」+ deleteReport + BigQuery 清除排程（D6）| 0.5 週 | 🟡 BigQuery streaming buffer 限制 |
| 隱私政策 + 上架審核往返 | 1 週 | 🟡 首次上架常被退件（砍掉 UGC 後風險已降低）|
| **合計** | **約 8 週** | 緩衝約 0.7 週 ⚠️ |

**判斷**：砍掉照片後落在 2 個月內，但緩衝仍薄。備妥下一輪砍功能順序：

1. **站牌異常回報**（三型減為兩型，省 0.3 週）
2. **未選路線時的附近公車顯示**（只保留「搜尋路線」單一入口，省 0.5 週且大幅降低效能風險）
3. **誤點 TDX 交叉比對**——⚠️ **最後才砍**，這是產品的核心價值，砍了 App 就退化成普通公車 App

---

## 8. 下一步

1. 申請 **Apple Developer Program**（審核需數日，且 App Attest 要等帳號才能設定 → **最優先**）
2. 申請 **TDX 帳號** → 第一週務必實測 A1 實際更新頻率與資料量（會反過來影響 §0.1、§2.1 的參數）
3. 撰寫**隱私權政策**草稿
4. 建立 Firebase 專案 + Cloud Run 骨架
5. 定義後端 **API contract**（App 與後端可並行開發）
