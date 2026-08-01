import Foundation
import CoreLocation
import Observation

/// 兩次定位之間，依路線線型推算公車「現在」大概在哪裡。
///
/// **為什麼需要**：TDX 動態資料每分鐘才更新一次（DESIGN.md §0.1），後端輪詢
/// 間隔 30 秒。不推算的話地圖上的車就是每 30 秒瞬移一次，中間完全靜止。
///
/// **為什麼沿線型而非沿方位角**：公車會轉彎，台北路網密集，直線外推會直接
/// 穿過建築物。以真實 TDX 資料實測（2026-08-01，78 組連續定位配對），
/// 推算位置與該車下一筆真實定位的中位數誤差——
/// 不推算 140.9m、沿線型 81.7m、沿方位角直線 106.7m。
///
/// 沿線型改善 42%，78 組中 53 組更準。**另外 32% 會變差**——公車會臨停、
/// 等紅燈、靠站，這些從速度與方位角預測不出來。所以推算只負責畫面連續性，
/// 誠實的來源始終是 UI 上那個「N 秒前」。
///
/// **與 DESIGN.md §0.1「不假裝更即時」的關係**：推算只用於視覺連續性，
/// 三道防線確保它不會變成謊言——
/// 1. `maxOffsetM`：定位點離線型太遠（停在總站、繞道、GPS 飄移）就不推算
/// 2. `maxExtrapolationSec`：超過就凍結，不會讓車無限往前滑
/// 3. UI 上的「N 秒前」仍照實顯示伺服器算出的資料年齡，不因推算而變新
@MainActor
@Observable
final class BusPositionEstimator {

    /// 定位點離線型超過此距離就不推算。
    ///
    /// 實測（TPE10132 全線 10 台車）：正常在線上的車偏離 0.5–5.8 公尺，
    /// 繞道中的車 20.4 公尺，停在總站外的車 235–245 公尺。60 公尺可以放行
    /// 前兩者、擋掉後者。
    private static let maxOffsetM = 60.0

    /// 最多外推幾秒。與後端的 `staleThresholdSec` 一致——伺服器判定為
    /// 訊號中斷的車，UI 本來就會轉成半透明，再往前推沒有意義。
    private static let maxExtrapolationSec = 90.0

    /// 低於此時速視為靜止。GPS 靜止時的速度讀數本來就會有雜訊。
    private static let minSpeedKph = 3.0

    /// 單台車的推算錨點。**只在收到新定位時重算**，之後每次畫面更新
    /// 只要做一次純量加法加一次二分搜尋，不必重跑投影。
    private struct Anchor {
        let pathKey: String
        /// 投影到線型上的沿線距離（公尺）
        let distanceAlong: Double
        let speedMps: Double
        /// 收到這筆資料時，伺服器算出的資料年齡
        let ageSecAtReceipt: Double
        /// 收到這筆資料的**本機**時間
        let receivedAt: Date
        /// 線型不可用或偏離過遠時的退路：直接用原始座標
        let fallback: CLLocationCoordinate2D
        let fallbackAzimuth: Double
        let canExtrapolate: Bool
    }

    private var paths: [String: RoutePath] = [:]
    private var anchors: [String: Anchor] = [:]

    // MARK: - 線型

    /// 載入靜態資料裡的路線線型。解碼一次就好——每次畫面更新都重解會很浪費。
    ///
    /// **在背景執行緒解碼**。實測台北市全量是 415 條路線、單條線型 350 個點，
    /// 而 `Polyline.decode` 是逐字元掃描；在主執行緒做會讓啟動時整個 UI 卡住。
    func loadShapes(from bundle: StaticBundle) async {
        let shapes = bundle.shapes

        let decoded = await Task.detached(priority: .userInitiated) {
            var paths: [String: RoutePath] = [:]
            paths.reserveCapacity(shapes.count)
            for shape in shapes {
                guard let path = RoutePath(encodedPolyline: shape.encodedPolyline) else { continue }
                paths[Self.key(routeUID: shape.routeUID, direction: shape.direction)] = path
            }
            return paths
        }.value

        paths = decoded
        // 線型換了，舊錨點的沿線距離失去意義
        anchors.removeAll()
    }

    var hasShapes: Bool { !paths.isEmpty }

    // MARK: - 錨定

    /// 收到新一批定位時呼叫。為每台車重新投影到線型上。
    ///
    /// - Parameter receivedAt: 收到回應的本機時間，預設為現在。
    func anchor(buses: [LiveBus], receivedAt: Date = Date()) {
        var next: [String: Anchor] = [:]
        next.reserveCapacity(buses.count)

        for bus in buses {
            let key = Self.key(routeUID: bus.routeUID, direction: bus.direction)
            let speedMps = max(bus.speedKph ?? 0, 0) / 3.6

            guard let path = paths[key] else {
                next[bus.plateNumb] = Anchor(
                    pathKey: key, distanceAlong: 0, speedMps: speedMps,
                    ageSecAtReceipt: Double(bus.ageSec), receivedAt: receivedAt,
                    fallback: bus.coordinate, fallbackAzimuth: bus.azimuth,
                    canExtrapolate: false
                )
                continue
            }

            let (distanceAlong, offsetM) = path.project(bus.coordinate)
            let onRoute = offsetM <= Self.maxOffsetM
            let moving = (bus.speedKph ?? 0) >= Self.minSpeedKph

            next[bus.plateNumb] = Anchor(
                pathKey: key,
                distanceAlong: distanceAlong,
                speedMps: speedMps,
                ageSecAtReceipt: Double(bus.ageSec),
                receivedAt: receivedAt,
                fallback: bus.coordinate,
                fallbackAzimuth: bus.azimuth,
                canExtrapolate: onRoute && moving && !bus.stale
            )
        }

        anchors = next
    }

    // MARK: - 推算

    /// 這台車「現在」的估計位置。
    ///
    /// 沒有錨點、線型不可用、偏離過遠、靜止、或已逾外推上限時，
    /// 一律回傳 API 給的原始座標——寧可讓它停著，也不要編一個錯的位置。
    func position(of bus: LiveBus, at now: Date = Date()) -> EstimatedPosition {
        let raw = EstimatedPosition(coordinate: bus.coordinate,
                                    azimuth: bus.azimuth,
                                    extrapolatedSec: 0,
                                    isEstimated: false)

        guard let anchor = anchors[bus.plateNumb], anchor.canExtrapolate,
              let path = paths[anchor.pathKey] else { return raw }

        // 只用本機時鐘量「距離收到回應過了多久」這個**差值**，絕不拿本機時鐘
        // 去減伺服器的 gpsTime——裝置時鐘偏移會讓推算距離整個歪掉。
        // 起算點是伺服器算好的 ageSec，見 LiveModels.swift 的說明。
        let sinceReceipt = max(now.timeIntervalSince(anchor.receivedAt), 0)
        let elapsed = anchor.ageSecAtReceipt + sinceReceipt

        guard elapsed > 0 else { return raw }

        let usable = min(elapsed, Self.maxExtrapolationSec)
        let advanced = anchor.distanceAlong + anchor.speedMps * usable

        return EstimatedPosition(
            coordinate: path.coordinate(atDistance: advanced),
            azimuth: path.bearing(atDistance: advanced),
            extrapolatedSec: usable,
            isEstimated: true
        )
    }

    /// `nonisolated`：`loadShapes` 會在背景 task 裡呼叫它。
    private nonisolated static func key(routeUID: String, direction: Direction) -> String {
        "\(routeUID)-\(direction.rawValue)"
    }
}

/// 推算結果。`isEstimated` 供 UI 決定要不要標示這是推算值。
struct EstimatedPosition {
    let coordinate: CLLocationCoordinate2D
    let azimuth: Double
    /// 實際往前推了幾秒（已套上上限）
    let extrapolatedSec: Double
    /// false 代表這就是 API 原始座標，沒有任何推算成分
    let isEstimated: Bool
}
