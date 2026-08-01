// xcode: set sdk=iOS

import SwiftUI

@main
struct BusMapApp: App {
    var body: some Scene {
        WindowGroup {
            // 目前接 MockBusAPI。後端就緒後改為 LiveBusAPI(baseURL:)，
            // 介面由 BusAPI protocol 固定，UI 層不需改動。
            MapScreen(api: MockBusAPI())
        }
    }
}
