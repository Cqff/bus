import Foundation
import CoreLocation

/// 單一車輛的即時位置。對應 `GET /v1/live/buses` 的 `buses[]`。
struct LiveBus: Identifiable, Decodable, Hashable {
    let plateNumb: String
    let routeUID: String
    let routeName: String
    let direction: Direction
    let lat: Double
    let lon: Double
    let azimuth: Double
    let speedKph: Double?
    let gpsTime: Date

    /// 由**伺服器**計算的資料年齡。App 不得自行以本機時鐘計算，
    /// 否則裝置時鐘偏移會讓「N 秒前」亂跳。見 API_CONTRACT.md §2.1。
    let ageSec: Int

    /// 伺服器判定 `ageSec > 90`。
    let stale: Bool

    let dutyStatus: DutyStatus
    let busStatus: BusStatus

    var id: String { plateNumb }

    var coordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: lat, longitude: lon)
    }

    /// 資料新鮮度，決定標記樣式。
    var freshness: Freshness {
        if stale { return .lost }
        return ageSec <= 30 ? .fresh : .aging
    }

    enum Freshness {
        case fresh   // ≤ 30s，正常顯示
        case aging   // 30–90s，顯示「N 秒前」
        case lost    // > 90s，半透明 +「訊號中斷」
    }
}

struct LiveBusesResponse: Decodable {
    let serverTime: Date
    let buses: [LiveBus]
    let truncated: Bool
    let oldestAgeSec: Int?
    let newestAgeSec: Int?
}

/// 單筆預估到站。對應 `GET /v1/live/eta` 的 `etas[]`。
struct BusETA: Identifiable, Decodable, Hashable {
    let stopUID: String
    let stationUID: String
    let routeUID: String
    let routeName: String
    let direction: Direction
    let estimateSec: Int?
    let stopStatus: StopStatus
    let plateNumb: String?
    let isLastBus: Bool
    let ageSec: Int

    var id: String { "\(stopUID)-\(routeUID)-\(direction.rawValue)" }

    /// 可直接顯示的到站文字。優先採用 `stopStatus` 的覆寫。
    var displayText: String {
        if let override = stopStatus.overrideLabel { return override }
        guard let sec = estimateSec else { return "－" }
        if sec < 30  { return "進站中" }
        if sec < 60  { return "將到站" }
        return "\(sec / 60) 分"
    }

    var isImminent: Bool {
        stopStatus == .normal && (estimateSec ?? .max) < 120
    }
}

struct LiveETAResponse: Decodable {
    let serverTime: Date
    let etas: [BusETA]
}
