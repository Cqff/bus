import Foundation
import CoreLocation
import MapKit

/// 地圖視野範圍，對應 `GET /v1/live/buses` 的 `bbox` 參數。
struct BBox: Equatable {
    let minLon: Double
    let minLat: Double
    let maxLon: Double
    let maxLat: Double

    /// API 規定跨距上限 0.15 度（約 15km）。
    static let maxSpanDegrees = 0.15

    init(minLon: Double, minLat: Double, maxLon: Double, maxLat: Double) {
        self.minLon = minLon
        self.minLat = minLat
        self.maxLon = maxLon
        self.maxLat = maxLat
    }

    init(region: MKCoordinateRegion) {
        let halfLat = min(region.span.latitudeDelta, Self.maxSpanDegrees) / 2
        let halfLon = min(region.span.longitudeDelta, Self.maxSpanDegrees) / 2
        minLat = region.center.latitude  - halfLat
        maxLat = region.center.latitude  + halfLat
        minLon = region.center.longitude - halfLon
        maxLon = region.center.longitude + halfLon
    }

    var queryValue: String {
        String(format: "%.6f,%.6f,%.6f,%.6f", minLon, minLat, maxLon, maxLat)
    }

    /// 視野對角線跨距（度）。用於決定是否顯示公車——見 DESIGN.md §5.2。
    var latSpan: Double { maxLat - minLat }
}

/// API 錯誤。`code` 決定行為，`message` 決定顯示文案（伺服器已提供繁中）。
enum BusAPIError: Error, Equatable {
    case invalidArgument(String)
    case notFound(String)
    case rateLimited(retryAfterSec: Int, message: String)
    case upstreamUnavailable(lastGoodAt: Date?, message: String)
    case reportTooFar(distanceM: Int, limitM: Int, message: String)
    case locationTooInaccurate(message: String)
    case noteRejected(message: String)
    case notOwner(message: String)
    case alreadyRequested(message: String)
    case unauthenticated(message: String)
    case appCheckFailed(message: String)
    case network(String)
    case internalError(String)

    var userMessage: String {
        switch self {
        case .invalidArgument(let m),
             .notFound(let m),
             .network(let m),
             .internalError(let m):
            return m
        case .rateLimited(_, let m),
             .upstreamUnavailable(_, let m),
             .reportTooFar(_, _, let m),
             .locationTooInaccurate(let m),
             .noteRejected(let m),
             .notOwner(let m),
             .alreadyRequested(let m),
             .unauthenticated(let m),
             .appCheckFailed(let m):
            return m
        }
    }

    /// 上游中斷時**不可顯示空地圖**，須降級顯示最後一筆好資料。
    /// 見 API_CONTRACT.md §1.2。
    var isDegradable: Bool {
        if case .upstreamUnavailable = self { return true }
        return false
    }
}

/// `deleteReport` 的結果。
///
/// **刪除不是同步完成的**：Firestore 熱資料可即時刪除，但長期分析資料庫
/// （BigQuery）因 streaming buffer 限制，最長約 90 分鐘內無法執行 DELETE，
/// 故改以佇列 + 每日排程處理。見 API_CONTRACT.md §4.3。
struct DeleteReportResult {
    /// 熱資料是否還在。10 分鐘前送出的回報已被 TTL 清掉，此值為 false。
    let firestoreDeleted: Bool
    /// 分析資料庫預計完成刪除的時間。UI 文案須據此寫「已受理」而非「已刪除」。
    let analyticsPurgeAt: Date
}

/// 後端介面。Mock 與正式實作共用，讓 UI 能在後端完成前獨立開發。
protocol BusAPI: Sendable {
    func liveBuses(routeUID: String, direction: Direction?) async throws -> LiveBusesResponse
    func liveBuses(bbox: BBox, limit: Int) async throws -> LiveBusesResponse
    func etas(stationUID: String) async throws -> [BusETA]
    func staticBundle() async throws -> StaticBundle
    func reports(stationUID: String) async throws -> [BusReport]
    func aggregates(bbox: BBox) async throws -> [StationAggregate]
    func submitReport(_ draft: ReportDraft, from location: CLLocation) async throws -> SubmitReportResult

    /// 刪除自己送出的回報。伺服器比對 `report.uid` 與呼叫者的匿名 uid 驗證所有權。
    func deleteReport(reportId: String) async throws -> DeleteReportResult
}
