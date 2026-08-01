// xcode: set sdk=iOS

import SwiftUI

@main
struct BusMapApp: App {
    var body: some Scene {
        WindowGroup {
            MapScreen(api: Self.makeAPI())
        }
    }

    /// 預設接 `MockBusAPI`——沒有後端也能開發 UI，且 mock 的公車現在會沿著
    /// 合成線型移動，推算邏輯照樣測得到。
    ///
    /// 要接真實後端，在 Xcode 的 Scheme → Run → Arguments → Environment
    /// Variables 加上：
    ///
    ///     BUSMAP_API_BASE_URL = http://localhost:8080
    ///
    /// 並先在另一個終端機跑 `cd backend && npm run dev`。
    /// 模擬器連 localhost 需要 Info.plist 的 `NSAllowsLocalNetworking`
    /// （已在 project.yml 設定），因為 iOS 預設封鎖明文 HTTP。
    ///
    /// 正式環境請填 Firebase Hosting 的網域而非 Cloud Run 直連網址，
    /// 否則 CDN 快取不會生效，成本會從 ~US$14/月 回到 ~US$95/月。
    private static func makeAPI() -> BusAPI {
        guard let raw = ProcessInfo.processInfo.environment["BUSMAP_API_BASE_URL"],
              !raw.isEmpty,
              let url = URL(string: raw) else {
            return MockBusAPI()
        }
        return LiveBusAPI(baseURL: url)
    }
}
