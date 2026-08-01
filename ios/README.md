# BusMap — iOS

SwiftUI + MapKit，最低支援 iOS 18。

> ⚠️ **這批程式碼是在 Windows 上撰寫的，從未編譯過。**
> 第一次在 Xcode 打開時預期會有編譯錯誤要修——這是無 Mac 環境下撰寫的必然代價。
> 見本文件末的〈第一次開啟預期會遇到的問題〉。

## 開啟專案

**`.xcodeproj` 與 `BusMap/Info.plist` 都不進版控**，兩者皆由 `project.yml`
產生。clone 後第一件事：

```bash
brew install xcodegen
cd ios
xcodegen generate
open BusMap.xcodeproj
```

`project.yml` 是專案結構的唯一真實來源。新增檔案不需要改它——`sources`
指的是整個 `BusMap/` 目錄，遞迴納入。

### 為什麼不把 .xcodeproj 與 Info.plist 進版控

兩者都是 `project.yml` 的產物，同時維護兩份必然分歧。`project.pbxproj`
更是難以合併的機器產生檔，而且 Xcode 會把開發者個人的 `DEVELOPMENT_TEAM`
寫進去，下次 `xcodegen generate` 又洗掉，來回衝突。

改 Info.plist 的內容請改 `project.yml` 的 `targets.BusMap.info.properties`，
不要直接編輯產生出來的檔案——那份改動會在下次 generate 時消失。

### 設定簽章

`project.yml` 的 `DEVELOPMENT_TEAM` 留空。產生專案後在 Xcode 的
Signing & Capabilities 選一次自己的 team 即可（該設定寫在不進版控的
`.xcodeproj` 裡，所以不會影響其他人）。

### 不想用 XcodeGen 的話

1. Xcode → New Project → iOS App → SwiftUI，最低版本設 iOS 18
2. 刪掉範本產生的 `ContentView.swift` 與 `*App.swift`
3. 把 `ios/BusMap/` 整個資料夾拖進專案（勾 Create groups）
4. 自行建立 Info.plist，內容依 `project.yml` 的 `info.properties` 補齊
   （該檔不在版控裡）。其中 `NSLocationWhenInUseUsageDescription` 與
   `NSAppTransportSecurity`（本機後端需要）不可漏

## 目前狀態

**預設接 `MockBusAPI`，不需要後端也不需要 TDX 金鑰即可執行。**
要改接真實後端見〈接上真實後端〉。

Mock 的公車**會沿著合成線型移動**，不是寫死的座標——因此不接後端也測得到
位置推算與動畫。

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
│  ├─ MockBusAPI.swift            假資料，含全部邊界情況；公車沿合成線型移動
│  ├─ LiveBusAPI.swift            正式實作，打 Cloud Run proxy
│  ├─ LiveBusStore.swift          輪詢邏輯的唯一實作點（15s / 退避 / 降級）
│  ├─ BusPositionEstimator.swift  兩次定位之間的位置推算
│  ├─ MyReportsStore.swift        本機回報索引，永不上傳（刪除權的所有權憑據）
│  └─ LocationService.swift       定位，只申請 When In Use
├─ DesignSystem/Theme.swift       顏色與尺寸常數
├─ Features/
│  ├─ Map/                        主畫面、公車標記、站位標記、狀態列
│  ├─ RouteSearch/                路線搜尋
│  ├─ StationDetail/              站位詳情（到站預估 + 回報列表）
│  ├─ Report/                     回報表單
│  └─ MyReports/                  我的回報（查看與刪除，履行個資法刪除權）
└─ Utils/
   ├─ Polyline.swift              Google encoded polyline 解碼
   └─ RoutePath.swift             線型幾何：投影到線上、沿線推進
```

### 四個關鍵設計點

**1. `ageSec` 一律由伺服器提供，App 不自行計算**
裝置時鐘偏移會讓「N 秒前」亂跳。`LiveBus.ageSec` 直接來自後端。

**2. 輪詢邏輯集中在 `LiveBusStore`**
15 秒間隔、連續 3 次失敗退避到 60 秒、進背景立即停止、上游中斷時**保留舊資料不清空**——
全部在同一個檔案，不散落在 View 裡。

**3. 顯示量由縮放層級控制**
SwiftUI 的 `Map` 沒有內建 annotation clustering。視野 > 3km 時隱藏公車、
只留有回報的站位，同時解決效能與畫面雜亂。上限常數在 `MapScreen.busVisibilityMaxSpan`。

**4. 兩次定位之間沿路線線型推算位置**
TDX 每分鐘才更新、後端每 30 秒輪詢，不推算的話車就是每 30 秒瞬移一次。
`BusPositionEstimator` 把車投影到它所屬路線的 polyline 上，再沿線前進
`速度 × 經過秒數`，每 0.5 秒重算一次。

沿**線型**而非沿方位角是關鍵。以真實 TDX 資料實測（2026-08-01，3 條路線、
18 台車、5 分鐘、78 組連續定位配對，間隔中位數 33 秒），比對推算位置與該車
下一筆真實定位的距離：

| 做法 | 中位數誤差 | p90 | 平均 |
|---|---|---|---|
| 不推算（標記停在原地） | 140.9m | 296.6m | 152.4m |
| **沿線型推算** | **81.7m** | 251.9m | 105.4m |
| 沿方位角直線 | 106.7m | 254.1m | 130.5m |

中位數誤差改善 42%，78 組中有 53 組（68%）更接近真實位置。

**剩下的 32% 會變更差**，這是航位推算的本質——公車會臨停、等紅燈、靠站，
這些都無法從速度與方位角預測。這也是為什麼「N 秒前」標籤必須保留：
推算讓畫面連續，時間戳才是誠實的來源。

這件事與 `DESIGN.md` §0.1「不假裝更即時」的張力，靠三道防線化解：

| 防線 | 作用 |
|---|---|
| `maxOffsetM = 60` | 定位點離線型太遠（停總站、繞道、GPS 飄移）就不推算 |
| `maxExtrapolationSec = 90` | 超過就凍結，不讓車無限往前滑 |
| 「N 秒前」照實顯示 | 資料年齡仍來自伺服器，不因推算而變新 |

推算用的經過時間是 `伺服器給的 ageSec + 本機自收到回應後經過的時間`，
只拿本機時鐘量**差值**，因此不受裝置時鐘偏移影響。

## 接上真實後端

`Services/LiveBusAPI.swift` 已實作完成。切換方式是設環境變數
（Xcode → Scheme → Run → Arguments → Environment Variables）：

```
BUSMAP_API_BASE_URL = http://localhost:8080
```

未設或設為空字串時退回 `MockBusAPI`。先在另一個終端機跑後端：

```bash
cd backend && npm run dev
```

模擬器連 `http://localhost:8080` 需要 `NSAllowsLocalNetworking`
（已在 `project.yml` 設定），因為 iOS 預設封鎖明文 HTTP。
正式環境請填 **Firebase Hosting 的網域**而非 Cloud Run 直連網址，
否則 CDN 快取不會生效。

### 尚未接上的部分

回報相關功能走 Cloud Functions，而那些函式尚未部署。`LiveBusAPI` 的處理方式：

- `reports` / `aggregates` → 回空集合，地圖與即時公車完全可用
- `submitReport` / `deleteReport` → 明確拋錯（假裝成功會讓使用者以為自己回報了）

另外 `staticBundle()` 目前**每次啟動都重新下載**，尚未依 manifest 的
`version` 做本機快取，也還沒驗 `sha256`。檔案裡有對應的 TODO。

## 第一次開啟預期會遇到的問題

因為這批程式碼未經編譯，以下是最可能需要修的地方：

- **`Annotation("", coordinate:)` 的空字串標題**——若造成版面問題，改用
  `Annotation(coordinate:content:label:)` 並給 `EmptyView()`
- **`@Observable` + `@MainActor` 的並發檢查**——`SWIFT_STRICT_CONCURRENCY: complete`
  下 `LocationService` 的 delegate 回呼可能需要調整 isolation 標註
- **`ForEach` 在 `MapContentBuilder` 內**——需要 iOS 17+，理論上沒問題但值得留意
- **`.tag(RouteOption?.some(option))`** 的 Optional tag 型別推導在 Picker 中偶爾出錯
- **`ContentUnavailableView`** 的 init 多載較多，參數順序可能要調
- **`MapContentBuilder` 內的區域 `let`**——`MapScreen` 的公車 `ForEach` 裡有一行
  `let position = estimator.position(...)`。result builder 支援區域變數宣告，
  但若編譯器抱怨，改成把運算收進一個回傳 `some MapContent` 的小函式
- **`Task.detached` 捕獲 `[RouteShape]`**——`BusPositionEstimator.loadShapes` 在背景
  解碼線型。`RouteShape` 應為隱式 `Sendable`（同模組、成員皆 Sendable），
  若嚴格併發檢查不同意，明確加上 `: Sendable`

修好後建議先跑 Preview（每個 View 檔案底部都有 `#Preview`），
再跑模擬器。模擬器需要 Features → Location → Custom Location 設一個台北座標
（25.0465, 121.5175）才能測回報功能的 150 公尺驗證。
