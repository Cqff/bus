import Foundation
import CoreLocation

/// 路線線型的幾何運算：把一個座標投影到線上，以及沿著線推進一段距離。
///
/// 這是位置推算的基礎——公車不會沿方位角直線前進，它會沿著路線轉彎。
/// 直線外推在台北車站周邊這種密集路網會直接穿過建築物：時速 40 公里外推
/// 60 秒就是 660 公尺的偏差。
///
/// **座標換算**：路線長度只有數公里，因此用等距長方投影（equirectangular）
/// 換算公尺即可，不需要 Haversine。經度係數取路線中點緯度，台北市範圍內
/// 誤差小於 0.1%，而且省掉每段線段一次三角函數。
struct RoutePath: Sendable {

    /// WGS84 每度緯度的公尺數。台北緯度附近的實際值介於 110.9–111.0 km，
    /// 取 111,320 的誤差對「公車在路線上前進多少公尺」而言可忽略。
    private static let metersPerDegree = 111_320.0

    let coordinates: [CLLocationCoordinate2D]

    /// `cumulative[i]` = 起點沿線走到 `coordinates[i]` 的距離（公尺）。
    /// 預先算好，讓「沿線距離 → 座標」可以用二分搜尋，而不必每次重掃。
    private let cumulative: [Double]

    /// 經度轉公尺的縮放係數 `cos(緯度)`。
    private let lonScale: Double

    var totalLength: Double { cumulative.last ?? 0 }

    /// 少於兩點、或總長為零的線型無法用於推算，一律回 nil。
    init?(coordinates: [CLLocationCoordinate2D]) {
        guard coordinates.count >= 2 else { return nil }

        let scale = cos(coordinates[coordinates.count / 2].latitude * .pi / 180)

        var acc: [Double] = [0]
        acc.reserveCapacity(coordinates.count)
        for i in 1..<coordinates.count {
            let step = Self.planarDistance(coordinates[i - 1], coordinates[i], lonScale: scale)
            acc.append(acc[i - 1] + step)
        }

        guard let total = acc.last, total > 0 else { return nil }

        self.coordinates = coordinates
        self.cumulative = acc
        self.lonScale = scale
    }

    /// 便利建構：直接吃後端的 encoded polyline。
    init?(encodedPolyline: String) {
        self.init(coordinates: Polyline.decode(encodedPolyline))
    }

    // MARK: - 投影

    /// 把座標投影到路線上。
    ///
    /// - Returns: `distanceAlong` 為投影點的沿線距離；`offsetM` 為原座標離
    ///   路線的垂直距離。**呼叫端必須檢查 `offsetM`**——數值過大代表這台車
    ///   根本不在這條線型上（GPS 飄移、繞道、或線型與實際路線不符），
    ///   此時不應該推算，直接用原始座標才誠實。
    func project(_ coordinate: CLLocationCoordinate2D) -> (distanceAlong: Double, offsetM: Double) {
        var bestOffset = Double.greatestFiniteMagnitude
        var bestDistance = 0.0

        for i in 1..<coordinates.count {
            let a = coordinates[i - 1]
            let b = coordinates[i]

            // 以 a 為原點的區域平面座標（公尺）
            let bx = (b.longitude - a.longitude) * Self.metersPerDegree * lonScale
            let by = (b.latitude - a.latitude) * Self.metersPerDegree
            let px = (coordinate.longitude - a.longitude) * Self.metersPerDegree * lonScale
            let py = (coordinate.latitude - a.latitude) * Self.metersPerDegree

            let segLenSq = bx * bx + by * by
            // 夾在 [0, 1]：投影落在線段外時取端點，否則會算到線段的延長線上
            let t = segLenSq > 0 ? min(max((px * bx + py * by) / segLenSq, 0), 1) : 0

            let dx = px - bx * t
            let dy = py - by * t
            let offset = (dx * dx + dy * dy).squareRoot()

            if offset < bestOffset {
                bestOffset = offset
                bestDistance = cumulative[i - 1] + segLenSq.squareRoot() * t
            }
        }

        return (bestDistance, bestOffset)
    }

    // MARK: - 沿線推進

    /// 沿線距離 → 座標。超出兩端時夾在端點（公車不會開到路線外）。
    func coordinate(atDistance distance: Double) -> CLLocationCoordinate2D {
        guard let first = coordinates.first, let last = coordinates.last else {
            return CLLocationCoordinate2D()
        }
        if distance <= 0 { return first }
        if distance >= totalLength { return last }

        let i = segmentIndex(containing: distance)
        let a = coordinates[i]
        let b = coordinates[i + 1]
        let span = cumulative[i + 1] - cumulative[i]
        let t = span > 0 ? (distance - cumulative[i]) / span : 0

        return CLLocationCoordinate2D(
            latitude: a.latitude + (b.latitude - a.latitude) * t,
            longitude: a.longitude + (b.longitude - a.longitude) * t
        )
    }

    /// 沿線距離處的行進方位角（正北為 0，順時針）。
    /// 用來讓標記上的箭頭跟著轉彎，而不是停在最後一次定位的方位角。
    func bearing(atDistance distance: Double) -> Double {
        let i = segmentIndex(containing: min(max(distance, 0), totalLength))
        let a = coordinates[i]
        let b = coordinates[i + 1]

        let dx = (b.longitude - a.longitude) * Self.metersPerDegree * lonScale
        let dy = (b.latitude - a.latitude) * Self.metersPerDegree

        let degrees = atan2(dx, dy) * 180 / .pi
        return degrees < 0 ? degrees + 360 : degrees
    }

    /// 回傳包含該沿線距離的線段起點索引。二分搜尋，線型可能有數千點。
    private func segmentIndex(containing distance: Double) -> Int {
        var lo = 0
        var hi = cumulative.count - 1
        while lo + 1 < hi {
            let mid = (lo + hi) / 2
            if cumulative[mid] <= distance { lo = mid } else { hi = mid }
        }
        return lo
    }

    private static func planarDistance(_ a: CLLocationCoordinate2D,
                                       _ b: CLLocationCoordinate2D,
                                       lonScale: Double) -> Double {
        let dLat = (b.latitude - a.latitude) * metersPerDegree
        let dLon = (b.longitude - a.longitude) * metersPerDegree * lonScale
        return (dLat * dLat + dLon * dLon).squareRoot()
    }
}
