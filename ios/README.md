# BusMap — iOS

SwiftUI + MapKit，最低支援 iOS 18。

> ⚠️ **這批程式碼是在 Windows 上撰寫的，從未編譯過。**
> 第一次在 Xcode 打開時預期會有編譯錯誤要修——這是無 Mac 環境下撰寫的必然代價。
> 見本文件末的〈第一次開啟預期會遇到的問題〉。

## 開啟專案

### 方式 A：XcodeGen（建議，專案結構可進版控）

```bash
brew install xcodegen
cd ios
xcodegen generate
open BusMap.xcodeproj
```

### 方式 B：手動建立

1. Xcode → New Project → iOS App → SwiftUI，最低版本設 iOS 18
2. 刪掉範本產生的 `ContentView.swift` 與 `*App.swift`
3. 把 `ios/BusMap/` 整個資料夾拖進專案（勾 Create groups）
4. Info.plist 加入 `NSLocationWhenInUseUsageDescription`：
   `用於顯示您附近的公車站牌，以及在您回報公車狀況時確認您位於站牌附近。`

## 目前狀態

**全部接 `MockBusAPI`，不需要後端也不需要 TDX 金鑰即可執行。**

Mock 刻意涵蓋 `API_CONTRACT.md` §6 列出的全部邊界情況：

| 邊界情況 | 在哪裡看到 |
|---|---|
| `stale` 車輛（>90s）| 地圖上半透明 + 「訊號中斷」標籤（車牌 KKA-1204）|
| 車況異常 | 「塞車」標籤（車牌 FAB-0912）|
| `truncated` | 把 `LiveBusStore.viewportLimit` 改小即可觸發 |
| `stopStatus` 1–4 | 點台北車站 → 尚未發車／不停靠／末班已過／今日未營運 |
| 上游中斷 | `MockBusAPI().scenario.simulateUpstreamOutage = true` |
| 同站 4+ 站牌 | 台北車站有 6 個 stops |
| `conflicting` | 台北車站的誤點回報，以及送出誤點回報後的結果頁 |
| 距離太遠被拒 | `scenario.simulateTooFar = true` |
| 頻率限制 | `scenario.simulateRateLimit = true` |
| 刪除時所有權驗證失敗 | `scenario.simulateNotOwner = true` |

## 架構

```
BusMap/
├─ App/BusMapApp.swift            進入點，切換 Mock / 正式 API 的唯一位置
├─ Models/                        對應 API_CONTRACT 的資料型別
├─ Services/
│  ├─ BusAPI.swift                protocol —— Mock 與正式實作的共同介面
│  ├─ MockBusAPI.swift            假資料，含全部邊界情況
│  ├─ LiveBusStore.swift          輪詢邏輯的唯一實作點（15s / 退避 / 降級）
│  ├─ MyReportsStore.swift        本機回報索引，永不上傳（刪除權的所有權憑據）
│  └─ LocationService.swift       定位，只申請 When In Use
├─ DesignSystem/Theme.swift       顏色與尺寸常數
├─ Features/
│  ├─ Map/                        主畫面、公車標記、站位標記、狀態列
│  ├─ RouteSearch/                路線搜尋
│  ├─ StationDetail/              站位詳情（到站預估 + 回報列表）
│  ├─ Report/                     回報表單
│  └─ MyReports/                  我的回報（查看與刪除，履行個資法刪除權）
└─ Utils/Polyline.swift           Google encoded polyline 解碼
```

### 三個關鍵設計點

**1. `ageSec` 一律由伺服器提供，App 不自行計算**
裝置時鐘偏移會讓「N 秒前」亂跳。`LiveBus.ageSec` 直接來自後端。

**2. 輪詢邏輯集中在 `LiveBusStore`**
15 秒間隔、連續 3 次失敗退避到 60 秒、進背景立即停止、上游中斷時**保留舊資料不清空**——
全部在同一個檔案，不散落在 View 裡。

**3. 顯示量由縮放層級控制**
SwiftUI 的 `Map` 沒有內建 annotation clustering。視野 > 3km 時隱藏公車、
只留有回報的站位，同時解決效能與畫面雜亂。上限常數在 `MapScreen.busVisibilityMaxSpan`。

## 接上真實後端

後端就緒後：

1. 新增 `Services/LiveBusAPI.swift` 實作 `BusAPI` protocol
2. 改 `BusMapApp.swift` 一行：`MapScreen(api: LiveBusAPI(baseURL: ...))`
3. UI 層完全不用動

`Models/` 的欄位名稱已對齊 `API_CONTRACT.md`，`JSONDecoder` 設
`.dateDecodingStrategy = .iso8601` 即可直接解。

## 第一次開啟預期會遇到的問題

因為這批程式碼未經編譯，以下是最可能需要修的地方：

- **`Annotation("", coordinate:)` 的空字串標題**——若造成版面問題，改用
  `Annotation(coordinate:content:label:)` 並給 `EmptyView()`
- **`@Observable` + `@MainActor` 的並發檢查**——`SWIFT_STRICT_CONCURRENCY: complete`
  下 `LocationService` 的 delegate 回呼可能需要調整 isolation 標註
- **`ForEach` 在 `MapContentBuilder` 內**——需要 iOS 17+，理論上沒問題但值得留意
- **`.tag(RouteOption?.some(option))`** 的 Optional tag 型別推導在 Picker 中偶爾出錯
- **`ContentUnavailableView`** 的 init 多載較多，參數順序可能要調

修好後建議先跑 Preview（每個 View 檔案底部都有 `#Preview`），
再跑模擬器。模擬器需要 Features → Location → Custom Location 設一個台北座標
（25.0465, 121.5175）才能測回報功能的 150 公尺驗證。
