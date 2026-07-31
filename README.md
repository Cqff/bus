# 台北市公車即時回報地圖 App

iOS App，在地圖上呈現台北市公車即時動態，並讓使用者匿名回報公車狀況。

**核心價值**：當使用者回報「車還沒來」而官方預估說「即將進站」時，App 會標示 **⚠️ 與官方資料不符** ——
這是官方 App 與 Google Maps 都給不了的資訊。

## 現況

📐 **設計階段**，尚未開始實作。

## 文件

| 文件 | 內容 |
|---|---|
| [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) | 需求規格、決策紀錄、MVP 範圍與排除項目 |
| [docs/DESIGN.md](docs/DESIGN.md) | 系統架構、資料模型、成本估算、時程風險 |
| [docs/API_CONTRACT.md](docs/API_CONTRACT.md) | 後端 API 契約（App 與後端並行開發的依據）|

**建議閱讀順序**：README → REQUIREMENTS → DESIGN §0（三個硬事實）→ API_CONTRACT

## 技術架構

```
iOS (SwiftUI + MapKit, iOS 18+)
   ├─ 即時公車位置 ──→ Firebase Hosting CDN ──→ Cloud Run (TDX Proxy) ──→ TDX API
   ├─ 使用者回報讀取 ─→ Firestore (10 分鐘熱資料)
   └─ 使用者回報寫入 ─→ Cloud Functions (伺服器端驗證) ──→ Firestore ──→ BigQuery (永久留存)
```

| 層 | 技術 |
|---|---|
| iOS | SwiftUI、MapKit、iOS 18+ |
| 後端 | Cloud Run（TDX proxy）、Cloud Functions、Firestore、BigQuery |
| 驗證 | Firebase Anonymous Auth + App Check |
| 資料源 | [交通部 TDX 運輸資料流通服務](https://tdx.transportdata.tw/) |

預估營運成本 **約 US$5–14/月**（日活躍 500 人）。

## 三個必須先知道的限制

1. **「即時」有物理上限**：TDX 動態資料官方更新頻率為每分鐘，端到端誤差最壞情況會超過 30 秒。
   本專案的做法是**誠實顯示每筆資料的時間戳**（「N 秒前」），而非假裝更即時。
2. **TDX 金鑰不得打包進 App**：所有 TDX 存取必須經過自家後端代理。
3. **「免登入」不等於「免驗證」**：使用者看不到登入畫面，但技術上使用 Firebase Anonymous Auth，
   否則所有防濫用機制（150m 距離、2 分鐘限流）都會被繞過。

詳見 [DESIGN.md §0](docs/DESIGN.md)。

## 進度

- [x] 需求訪談
- [x] 系統設計
- [x] API contract
- [ ] 申請 Apple Developer Program ← **最優先**（App Check 的 App Attest 需要它才能設定）
- [ ] 申請 TDX API 金鑰
- [ ] 實測 TDX A1 實際更新頻率與資料量
- [ ] 隱私權政策
- [ ] Firebase 專案 + Cloud Run 骨架
- [ ] iOS 專案骨架

## 授權

未定。
