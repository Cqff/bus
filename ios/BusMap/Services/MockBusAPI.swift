import Foundation
import CoreLocation

/// 開發期用的假資料後端。
///
/// 刻意涵蓋 API_CONTRACT.md §6 列出的全部邊界情況——這些是並行開發最容易漏測的地方：
/// `stale` 車輛、`truncated`、`stopStatus` 1–4、上游中斷、同站 4+ 站牌、`conflicting`。
final class MockBusAPI: BusAPI, @unchecked Sendable {

    /// 用來手動觸發各種失敗路徑，驗證 UI 的降級行為。
    struct Scenario {
        var simulateUpstreamOutage = false
        var simulateTooFar         = false
        var simulateRateLimit      = false
        var simulateNotOwner       = false
        var latency: Duration      = .milliseconds(180)
    }

    var scenario = Scenario()

    // 台北車站周邊
    private let center = CLLocationCoordinate2D(latitude: 25.0465, longitude: 121.5175)

    // MARK: - 即時車輛

    func liveBuses(routeUID: String, direction: Direction?) async throws -> LiveBusesResponse {
        try await delay()
        try checkOutage()
        let all = Self.buses(around: center, serverTime: Date())
            .filter { $0.routeUID == routeUID }
            .filter { direction == nil || $0.direction == direction }
        return LiveBusesResponse(
            serverTime: Date(),
            buses: all,
            truncated: false,
            oldestAgeSec: all.map(\.ageSec).max(),
            newestAgeSec: all.map(\.ageSec).min()
        )
    }

    func liveBuses(bbox: BBox, limit: Int) async throws -> LiveBusesResponse {
        try await delay()
        try checkOutage()
        let all = Self.buses(around: center, serverTime: Date())
        let visible = all.filter {
            $0.lat >= bbox.minLat && $0.lat <= bbox.maxLat &&
            $0.lon >= bbox.minLon && $0.lon <= bbox.maxLon
        }
        // 刻意讓 limit 偏小時觸發 truncated，驗證「放大以查看更多」提示
        let capped = Array(visible.prefix(limit))
        return LiveBusesResponse(
            serverTime: Date(),
            buses: capped,
            truncated: capped.count < visible.count,
            oldestAgeSec: capped.map(\.ageSec).max(),
            newestAgeSec: capped.map(\.ageSec).min()
        )
    }

    // MARK: - 到站預估

    func etas(stationUID: String) async throws -> [BusETA] {
        try await delay()
        try checkOutage()
        return Self.etas(stationUID: stationUID)
    }

    // MARK: - 靜態資料

    func staticBundle() async throws -> StaticBundle {
        try await delay()
        return Self.bundle(center: center)
    }

    // MARK: - 回報

    func reports(stationUID: String) async throws -> [BusReport] {
        try await delay()
        return Self.reports(stationUID: stationUID)
    }

    func aggregates(bbox: BBox) async throws -> [StationAggregate] {
        try await delay()
        return Self.aggregates()
    }

    func submitReport(_ draft: ReportDraft, from location: CLLocation) async throws -> SubmitReportResult {
        try await delay()

        if scenario.simulateTooFar {
            throw BusAPIError.reportTooFar(
                distanceM: 412, limitM: 150,
                message: "您距離站牌 412 公尺，請靠近至 150 公尺內再回報"
            )
        }
        if scenario.simulateRateLimit {
            throw BusAPIError.rateLimited(
                retryAfterSec: 78,
                message: "您剛剛已回報過這個站牌，請 78 秒後再試"
            )
        }

        let crossCheck: CrossCheckResult? = draft.type == .delay
            ? CrossCheckResult(
                verdict: .conflicting,
                tdxEstimateSec: 180,
                message: "⚠️ 官方預估 3 分鐘內到站，但已有 4 人回報未出現"
              )
            : nil

        return SubmitReportResult(
            reportId: UUID().uuidString,
            expiresAt: Date().addingTimeInterval(600),
            crossCheck: crossCheck,
            stationSummary: StationAggregate(
                stationUID: draft.stationUID,
                delayCount: draft.type == .delay ? 5 : 4,
                conflictingCount: 4,
                crowding: CrowdBreakdown(seat: 1, stand: 3, packed: 2),
                stopIssueCount: 0,
                updatedAt: Date()
            )
        )
    }

    func deleteReport(reportId: String) async throws -> DeleteReportResult {
        try await delay()

        if scenario.simulateNotOwner {
            throw BusAPIError.notOwner(
                message: "無法確認這筆回報屬於您。若您曾重新安裝 App，先前的回報將無法刪除。"
            )
        }

        // 分析資料庫為每日排程批次刪除，最壞情況接近 24 小時
        return DeleteReportResult(
            firestoreDeleted: Bool.random(),
            analyticsPurgeAt: Date().addingTimeInterval(60 * 60 * 24)
        )
    }

    // MARK: - Helpers

    private func delay() async throws {
        try? await Task.sleep(for: scenario.latency)
    }

    private func checkOutage() throws {
        guard scenario.simulateUpstreamOutage else { return }
        throw BusAPIError.upstreamUnavailable(
            lastGoodAt: Date().addingTimeInterval(-240),
            message: "官方資料來源中斷"
        )
    }
}

// MARK: - Fixtures

extension MockBusAPI {

    static func buses(around c: CLLocationCoordinate2D, serverTime: Date) -> [LiveBus] {
        // (路線, 車牌, 緯度偏移, 經度偏移, 方位角, 資料年齡, 勤務, 車況)
        let rows: [(String, String, String, Double, Double, Double, Int, DutyStatus, BusStatus)] = [
            ("TPE10132", "270", "KKA-1201",  0.0032, -0.0041,  87, 12, .normal, .normal),
            ("TPE10132", "270", "KKA-1202", -0.0018,  0.0026, 265,  8, .normal, .normal),
            ("TPE10132", "270", "KKA-1203",  0.0061,  0.0012, 350, 47, .normal, .normal),   // aging
            ("TPE10132", "270", "KKA-1204", -0.0044, -0.0033, 178,132, .normal, .normal),   // stale
            ("TPE10874", "307", "FAB-0912",  0.0009,  0.0058,  92, 15, .normal, .traffic),  // 異常車況
            ("TPE10874", "307", "FAB-0913", -0.0071,  0.0004, 271, 22, .normal, .normal),
            ("TPE15521", "藍7",  "EAA-3311",  0.0025,  0.0071,  45,  6, .normal, .normal),
            ("TPE15521", "藍7",  "EAA-3312", -0.0033, -0.0068, 225, 19, .normal, .normal),
            ("TPE10005", "12",  "KKA-7781",  0.0052, -0.0074, 310, 31, .normal, .normal),
            ("TPE10005", "12",  "KKA-7782",  0.0011, -0.0011, 130,  4, .toOrigin, .normal),
        ]

        return rows.map { routeUID, routeName, plate, dLat, dLon, azimuth, age, duty, status in
            LiveBus(
                plateNumb: plate,
                routeUID: routeUID,
                routeName: routeName,
                direction: dLon >= 0 ? .outbound : .inbound,
                lat: c.latitude + dLat,
                lon: c.longitude + dLon,
                azimuth: azimuth,
                speedKph: Double(Int.random(in: 0...42)),
                gpsTime: serverTime.addingTimeInterval(-Double(age)),
                ageSec: age,
                stale: age > 90,
                dutyStatus: duty,
                busStatus: status
            )
        }
    }

    static func etas(stationUID: String) -> [BusETA] {
        // 涵蓋 stopStatus 0–4 全部狀態
        let rows: [(String, String, Direction, Int?, StopStatus)] = [
            ("TPE50629", "270", .outbound,   45, .normal),
            ("TPE50630", "270", .inbound,   420, .normal),
            ("TPE50711", "307", .outbound,  180, .normal),
            ("TPE50712", "307", .inbound,   nil, .notDeparted),
            ("TPE50880", "藍7",  .outbound,  nil, .skipped),
            ("TPE50881", "12",  .outbound,  nil, .lastBusPassed),
            ("TPE50882", "小12", .inbound,   nil, .noService),
        ]
        return rows.map { stopUID, name, dir, sec, status in
            BusETA(
                stopUID: stopUID,
                stationUID: stationUID,
                routeUID: "UID-\(name)",
                routeName: name,
                direction: dir,
                estimateSec: sec,
                stopStatus: status,
                plateNumb: status == .normal ? "KKA-120\(Int.random(in: 1...4))" : nil,
                isLastBus: status == .lastBusPassed,
                ageSec: Int.random(in: 5...40)
            )
        }
    }

    static func reports(stationUID: String) -> [BusReport] {
        let now = Date()
        return [
            BusReport(
                id: "r1", type: .delay, stopUID: "TPE50629", stationUID: stationUID,
                routeUID: "TPE10132", routeName: "270", direction: .outbound, plateNumb: nil,
                crowdLevel: nil, reportedWaitMinutes: 14, issueKind: nil,
                note: "站牌顯示 3 分鐘但等了快 15 分鐘還沒看到車",
                createdAt: now.addingTimeInterval(-120), expiresAt: now.addingTimeInterval(480),
                verdict: .conflicting, flagCount: 0
            ),
            BusReport(
                id: "r2", type: .delay, stopUID: "TPE50629", stationUID: stationUID,
                routeUID: "TPE10132", routeName: "270", direction: .outbound, plateNumb: nil,
                crowdLevel: nil, reportedWaitMinutes: 12, issueKind: nil, note: nil,
                createdAt: now.addingTimeInterval(-260), expiresAt: now.addingTimeInterval(340),
                verdict: .conflicting, flagCount: 0
            ),
            BusReport(
                id: "r3", type: .crowding, stopUID: "TPE50711", stationUID: stationUID,
                routeUID: "TPE10874", routeName: "307", direction: .outbound, plateNumb: "FAB-0912",
                crowdLevel: .packed, reportedWaitMinutes: nil, issueKind: nil,
                note: "完全上不去",
                createdAt: now.addingTimeInterval(-90), expiresAt: now.addingTimeInterval(510),
                verdict: nil, flagCount: 0
            ),
            BusReport(
                id: "r4", type: .crowding, stopUID: "TPE50711", stationUID: stationUID,
                routeUID: "TPE10874", routeName: "307", direction: .outbound, plateNumb: nil,
                crowdLevel: .stand, reportedWaitMinutes: nil, issueKind: nil, note: nil,
                createdAt: now.addingTimeInterval(-410), expiresAt: now.addingTimeInterval(190),
                verdict: nil, flagCount: 0
            ),
            BusReport(
                id: "r5", type: .stopIssue, stopUID: "TPE50629", stationUID: stationUID,
                routeUID: nil, routeName: nil, direction: nil, plateNumb: nil,
                crowdLevel: nil, reportedWaitMinutes: nil, issueKind: .construction,
                note: "站牌前面在施工，要走到下一個路口",
                createdAt: now.addingTimeInterval(-540), expiresAt: now.addingTimeInterval(60),
                verdict: nil, flagCount: 1
            ),
        ]
    }

    static func aggregates() -> [StationAggregate] {
        [
            StationAggregate(stationUID: "TPE9800", delayCount: 4, conflictingCount: 4,
                             crowding: CrowdBreakdown(seat: 0, stand: 1, packed: 1),
                             stopIssueCount: 1, updatedAt: Date()),
            StationAggregate(stationUID: "TPE9801", delayCount: 0, conflictingCount: 0,
                             crowding: CrowdBreakdown(seat: 2, stand: 0, packed: 0),
                             stopIssueCount: 0, updatedAt: Date()),
            StationAggregate(stationUID: "TPE9802", delayCount: 1, conflictingCount: 0,
                             crowding: CrowdBreakdown(seat: 0, stand: 3, packed: 0),
                             stopIssueCount: 0, updatedAt: Date()),
        ]
    }

    /// 每條路線的**去程站序**（回程直接反向）。
    ///
    /// 舊版把「全部站位、依宣告順序」當成每條路線的站序，於是每條路線都畫出同一條
    /// 在市區裡對角亂穿又自我交叉的線。這裡改成各線只經過部分站位、且沿地理走向排列，
    /// 讓 mock 畫出來的形狀至少像一條公車路線。
    private static let routePaths: [String: [String]] = [
        "TPE10132": ["TPE9804", "TPE9802", "TPE9800", "TPE9803"],  // 270  西門→北門→北車→中山市場
        "TPE10874": ["TPE9804", "TPE9801", "TPE9800", "TPE9803"],  // 307  西門→公園路→北車→中山市場
        "TPE15521": ["TPE9804", "TPE9802", "TPE9800"],             // 藍7  西門→北門→北車（北車為終點）
        "TPE10005": ["TPE9801", "TPE9800", "TPE9802"],             // 12   公園路→北車→北門
        "TPE19001": ["TPE9803", "TPE9800"],                        // 小12 中山市場→北車（只有兩站）
    ]

    /// 某站位停靠的所有站牌，由 `routePaths` 反推，確保與站序資料一致。
    private static func stopRefs(at stationUID: String) -> [StopRef] {
        routePaths.filter { $0.value.contains(stationUID) }
                  .sorted { $0.key < $1.key }
                  .flatMap { routeUID, _ -> [StopRef] in
                      Direction.allCases.map { dir in
                          StopRef(stopUID: "\(stationUID)-\(routeUID)-\(dir.rawValue)",
                                  routeUID: routeUID,
                                  direction: dir,
                                  operatorID: "10012",
                                  bearing: dir == .outbound ? "S" : "N")
                      }
                  }
    }

    static func bundle(center c: CLLocationCoordinate2D) -> StaticBundle {
        // 台北車站刻意給 6 個 stops，驗證「同站 4+ 站牌」的合併 UI
        let taipeiMain = Station(
            stationUID: "TPE9800", name: "臺北車站", nameEn: "Taipei Main Station",
            lat: c.latitude, lon: c.longitude,
            stops: [
                StopRef(stopUID: "TPE50629", routeUID: "TPE10132", direction: .outbound, operatorID: "10012", bearing: "S"),
                StopRef(stopUID: "TPE50630", routeUID: "TPE10132", direction: .inbound,  operatorID: "10012", bearing: "N"),
                StopRef(stopUID: "TPE50711", routeUID: "TPE10874", direction: .outbound, operatorID: "10015", bearing: "S"),
                StopRef(stopUID: "TPE50712", routeUID: "TPE10874", direction: .inbound,  operatorID: "10015", bearing: "N"),
                StopRef(stopUID: "TPE50880", routeUID: "TPE15521", direction: .outbound, operatorID: "10002", bearing: "E"),
                StopRef(stopUID: "TPE50881", routeUID: "TPE10005", direction: .outbound, operatorID: "10012", bearing: "W"),
            ]
        )
        // 位移依實際地理方位給：北門在西北、中山市場在東北、公園路在南、西門在西南。
        // 名稱與方位對不上的假資料在地圖上一眼就看得出來。
        let others = [
            ("TPE9801", "公園路",  -0.0024,  0.0008),
            ("TPE9802", "北門",     0.0022, -0.0060),
            ("TPE9803", "中山市場",  0.0058,  0.0032),
            ("TPE9804", "西門",    -0.0050, -0.0082),
        ].map { uid, name, dLat, dLon in
            Station(
                stationUID: uid, name: name, nameEn: nil,
                lat: c.latitude + dLat, lon: c.longitude + dLon,
                stops: stopRefs(at: uid)
            )
        }

        let routes = [
            BusRoute(routeUID: "TPE10132", routeName: "270", nameEn: "270",
                     departureStop: "捷運景安站", destinationStop: "松山車站"),
            BusRoute(routeUID: "TPE10874", routeName: "307", nameEn: "307",
                     departureStop: "板橋",       destinationStop: "撫遠街"),
            BusRoute(routeUID: "TPE15521", routeName: "藍7",  nameEn: "Blue 7",
                     departureStop: "板橋",       destinationStop: "臺北車站"),
            BusRoute(routeUID: "TPE10005", routeName: "12",  nameEn: "12",
                     departureStop: "青年公園",   destinationStop: "民生社區"),
            BusRoute(routeUID: "TPE19001", routeName: "小12", nameEn: "Minibus 12",
                     departureStop: "捷運劍潭站", destinationStop: "碧山巖"),
        ]

        let stations = [taipeiMain] + others

        let stationByUID = Dictionary(uniqueKeysWithValues: stations.map { ($0.stationUID, $0) })

        let routeStops = routes.flatMap { route in
            Direction.allCases.compactMap { dir -> RouteStops? in
                guard let path = routePaths[route.routeUID] else { return nil }
                let ordered = dir == .outbound ? path : Array(path.reversed())
                return RouteStops(
                    routeUID: route.routeUID,
                    direction: dir,
                    stops: ordered.enumerated().compactMap { idx, uid -> SequencedStop? in
                        guard let st = stationByUID[uid] else { return nil }
                        return SequencedStop(stopUID: "\(uid)-\(route.routeUID)-\(dir.rawValue)",
                                             stationUID: uid,
                                             sequence: idx + 1,
                                             lat: st.lat, lon: st.lon, name: st.name)
                    }
                )
            }
        }

        return StaticBundle(
            version: "mock-2026-08-01",
            stations: stations,
            routes: routes,
            routeStops: routeStops,
            shapes: []   // Mock 不提供線型，地圖改以站點連線示意（畫成虛線）
        )
    }
}
