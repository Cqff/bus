# BusMap Backend — TDX Proxy

Cloud Run 服務，代理交通部 TDX 公車動態資料給 iOS App。

**零依賴**：Node 24 原生支援 TypeScript 與 `fetch`，API 只有 4 個 GET 端點，
引入框架只會拖慢 Cloud Run 冷啟動。不需要 `npm install`，也沒有建置步驟。

## 為什麼需要這一層

1. **TDX 金鑰不能放進 App** —— 任何打包進 App 的字串都可被反編譯取出。
2. **CDN 快取** —— 100 個使用者同時看 270 路線，只會產生 1 次 TDX 回源請求。
3. **`ageSec` 由伺服器計算** —— 裝置時鐘偏移會讓 App 上的「N 秒前」亂跳。

## 快速開始

```bash
cd backend
cp .env.example .env      # 填入 TDX_CLIENT_ID / TDX_CLIENT_SECRET
npm run dev
```

沒有 TDX 金鑰的話，先去 https://tdx.transportdata.tw/ 註冊會員 →
會員中心 → 資料服務 → 取得 API 金鑰。免費。

## ⚠️ 拿到金鑰後第一件事：跑實測

```bash
npm run probe
```

這支腳本觀測 10 分鐘，回答三個目前仍未知、且**會回頭改變設計**的問題：

| 問題 | 影響 |
|---|---|
| A1 **實際**多久更新一次？ | 決定「誤差 30 秒」能否達成、`POLL_INTERVAL_MS` 該設多少 |
| 全市單次回應多大？ | 若過大需改用 `$spatialFilter` 分區拉取，proxy 架構要改 |
| `src/tdx/types.ts` 的欄位名稱對嗎？ | 那份型別是依慣例寫的，**未經任何驗證** |

產出：

- `probe-output/report.md` —— 實測報告，含建議的 `POLL_INTERVAL_MS`
- `probe-output/raw-sample.json` —— 原始回應樣本，用來核對欄位名稱

跑完後請依報告修正 `.env` 的 `POLL_INTERVAL_MS`，並回頭更新 `docs/DESIGN.md` §0.1。

想跑久一點或取樣密一點：

```bash
npm run probe -- 20 10
```

（觀測 20 分鐘、每 10 秒取樣。取樣間隔即為量測解析度上限——
若報告顯示更新間隔恰好等於取樣間隔，代表實際更新更快，要縮小間隔重測。）

## 端點

| 端點 | 說明 |
|---|---|
| `GET /v1/live/buses?route=<RouteUID>[&direction=0\|1]` | 指定路線的即時車輛 |
| `GET /v1/live/buses?bbox=<minLon,minLat,maxLon,maxLat>[&limit=60]` | 視野範圍內的車輛 |
| `GET /v1/live/eta?stop=<StopUID>` | 單一站牌的到站預估 |
| `GET /v1/live/eta?station=<StationUID>` | 站位（合併後）的到站預估 |
| `GET /v1/live/eta?route=<RouteUID>[&direction=]` | 路線全線的到站預估 |
| `GET /healthz` | 存活檢查，快取未就緒時回 503 |

完整契約見 [`docs/API_CONTRACT.md`](../docs/API_CONTRACT.md)。

本機測試：

```bash
curl "http://localhost:8080/v1/live/buses?bbox=121.50,25.03,121.54,25.06" | head -c 2000
```

## 尚未實作

- Cloud Functions：`submitReport` / `flagReport` / `deleteReport`
- BigQuery 刪除排程

兩者程式碼皆已寫好（`functions/src/`），純邏輯部分有 26 項單元測試涵蓋，
但**尚未編譯或部署驗證**——需先 `cd functions && npm install` 取得 Firebase 與 BigQuery 套件。

上表端點、每日靜態同步與站牌合併已於 2026-08-01 接真實 TDX 實機驗證通過。

## 架構筆記

### 為什麼是 Cloud Run 而非 Cloud Functions

`liveCache` 需要**常駐記憶體**保存全市車輛位置。Cloud Functions 的實例會被回收，
每次冷啟動都得重拉全量資料。因此必須 Cloud Run 且 `min-instances=1`
（約 US$5–8/月，是本架構唯一的固定成本）。

### 為什麼端點不做身分驗證

Firebase Hosting CDN **不會快取帶 `Authorization` 標頭的請求**。加了驗證等於
CDN 失效，成本從 ~US$14/月 回到 ~US$95/月。而這些資料本來就是公開的政府開放資料——
別人自己去申請 TDX 也拿得到，他省下的只是你的快取。

驗證擋在**寫入端**（Cloud Functions），那裡才是濫用會造成實質損害的地方。
完整理由見 `docs/API_CONTRACT.md` §0。

### 上游中斷時不清空快取

`liveCache.refresh()` 失敗時**刻意保留舊 snapshot**。寧可回舊資料並讓 App 顯示
「⚠️ 資料來源中斷，顯示 N 分鐘前資料」，也不要讓使用者看到空地圖。

### 🔍 一個待驗證的問題：`ageSec` 與 CDN 快取

回應中的 `ageSec` 是**快取填充當下**的值。若這份回應在 CDN 停留 12 秒才送出，
使用者看到的 `ageSec` 會少算 12 秒。

正確修正方式是 App 加上 HTTP `Age` 標頭：

```
實際年齡 = 回應中的 ageSec + Age 標頭值
```

**待驗證**：Firebase Hosting CDN 是否確實回傳 `Age` 標頭。
若否，需縮短 `max-age` 或改變作法。詳見 `src/http.ts` 的註解。

## 部署

```bash
gcloud run deploy busmap-proxy \
  --source . \
  --region asia-east1 \
  --min-instances 1 \
  --max-instances 3 \
  --memory 512Mi \
  --allow-unauthenticated \
  --set-secrets TDX_CLIENT_ID=tdx-client-id:latest,TDX_CLIENT_SECRET=tdx-client-secret:latest
```

金鑰存 Secret Manager，**不要用 `--set-env-vars` 傳明文**。

部署後在 `firebase.json` 加 rewrite 讓 CDN 生效：

```json
{
  "hosting": {
    "rewrites": [
      { "source": "/v1/**", "run": { "serviceId": "busmap-proxy", "region": "asia-east1" } }
    ]
  }
}
```
