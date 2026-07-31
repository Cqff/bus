import Foundation
import CoreLocation

/// 站位——**已由後端合併**同一實體站點下不同業者、不同方向的站牌。
///
/// 合併邏輯完全在後端（見 API_CONTRACT.md §3.2），App 只消費結果。
/// 這是刻意把 DESIGN.md 標為最高風險的項目隔離在單一位置。
struct Station: Identifiable, Decodable, Hashable {
    let stationUID: String
    let name: String
    let nameEn: String?
    let lat: Double
    let lon: Double
    let stops: [StopRef]

    var id: String { stationUID }

    var coordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: lat, longitude: lon)
    }

    /// 此站位停靠的所有路線 UID（去重）。
    var routeUIDs: [String] {
        var seen = Set<String>()
        return stops.compactMap { seen.insert($0.routeUID).inserted ? $0.routeUID : nil }
    }
}

struct StopRef: Decodable, Hashable {
    let stopUID: String
    let routeUID: String
    let direction: Direction
    let operatorID: String?
    let bearing: String?
}

struct BusRoute: Identifiable, Decodable, Hashable {
    let routeUID: String
    let routeName: String
    let nameEn: String?
    let departureStop: String
    let destinationStop: String

    var id: String { routeUID }

    var subtitle: String { "\(departureStop) — \(destinationStop)" }

    /// 路線號碼排序用：數字優先且以數值比較，其餘按字典序。
    /// 讓 "8" 排在 "小12" 前、"270" 排在 "1032" 前。
    var sortKey: (Int, String) {
        if let n = Int(routeName.prefix(while: \.isNumber)), routeName.first?.isNumber == true {
            return (n, routeName)
        }
        return (Int.max, routeName)
    }
}

/// 路線站序，用於「已選路線」模式畫出沿線站牌。
struct RouteStops: Decodable, Hashable {
    let routeUID: String
    let direction: Direction
    let stops: [SequencedStop]
}

struct SequencedStop: Identifiable, Decodable, Hashable {
    let stopUID: String
    let stationUID: String
    let sequence: Int
    let lat: Double
    let lon: Double
    let name: String

    var id: String { stopUID }

    var coordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: lat, longitude: lon)
    }
}

struct RouteShape: Decodable, Hashable {
    let routeUID: String
    let direction: Direction
    let encodedPolyline: String
}

/// App 本機快取的靜態資料整包。啟動時比對 manifest `version` 才重新下載。
struct StaticBundle {
    let version: String
    let stations: [Station]
    let routes: [BusRoute]
    let routeStops: [RouteStops]
    let shapes: [RouteShape]

    func stations(near coordinate: CLLocationCoordinate2D, radiusM: Double) -> [Station] {
        let origin = CLLocation(latitude: coordinate.latitude, longitude: coordinate.longitude)
        return stations.filter {
            CLLocation(latitude: $0.lat, longitude: $0.lon).distance(from: origin) <= radiusM
        }
    }

    func shape(routeUID: String, direction: Direction) -> RouteShape? {
        shapes.first { $0.routeUID == routeUID && $0.direction == direction }
    }

    func routeStops(routeUID: String, direction: Direction) -> RouteStops? {
        routeStops.first { $0.routeUID == routeUID && $0.direction == direction }
    }
}
