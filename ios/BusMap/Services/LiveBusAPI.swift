import Foundation
import CoreLocation

/// `BusAPI` 的正式實作，打自家的 Cloud Run proxy。
///
/// **只有即時與靜態端點是真的**。回報相關功能（`reports` / `aggregates` /
/// `submitReport` / `deleteReport`）走 Cloud Functions，而那些函式雖然已寫好
/// 也通過型別檢查，但尚未部署。這裡的處理方式刻意分成兩種：
///
/// - 讀取類（`reports` / `aggregates`）回空集合 —— 讓地圖與即時公車完全可用，
///   只是沒有回報疊加層
/// - 寫入類（`submitReport` / `deleteReport`）明確拋錯 —— 假裝送出成功會讓
///   使用者以為自己回報了，那比直接報錯糟糕得多
final class LiveBusAPI: BusAPI {

    private let baseURL: URL
    private let session: URLSession

    /// - Parameter baseURL: 後端位址。模擬器連本機後端用 `http://localhost:8080`
    ///   （需要 Info.plist 的 `NSAllowsLocalNetworking`），正式環境填 Firebase
    ///   Hosting 的網域，CDN 才會生效。
    init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    // MARK: - 即時

    func liveBuses(routeUID: String, direction: Direction?) async throws -> LiveBusesResponse {
        var items = [URLQueryItem(name: "route", value: routeUID)]
        if let direction {
            items.append(URLQueryItem(name: "direction", value: String(direction.rawValue)))
        }
        return try await get("/v1/live/buses", query: items)
    }

    func liveBuses(bbox: BBox, limit: Int) async throws -> LiveBusesResponse {
        try await get("/v1/live/buses", query: [
            URLQueryItem(name: "bbox", value: bbox.queryValue),
            URLQueryItem(name: "limit", value: String(limit)),
        ])
    }

    func etas(stationUID: String) async throws -> [BusETA] {
        let response: ETAResponse = try await get("/v1/live/eta", query: [
            URLQueryItem(name: "station", value: stationUID),
        ])
        return response.etas
    }

    private struct ETAResponse: Decodable {
        let serverTime: Date
        let etas: [BusETA]
    }

    // MARK: - 靜態資料

    /// 取 manifest 後平行下載四份檔案再組裝。
    ///
    /// 四份檔案彼此不相依，序列下載會白白多花三趟 RTT。未壓縮總量約 11MB
    /// （壓縮後 1.9MB），`URLSession` 預設就會帶 `Accept-Encoding: gzip`
    /// 並自動解壓，因此這裡拿到的已是解壓後的內容。
    ///
    /// - Note: 尚未實作 manifest 的 `sha256` 驗證與本機快取。目前每次啟動
    ///   都會重新下載——見下方 TODO。
    func staticBundle() async throws -> StaticBundle {
        let manifest: StaticManifest = try await get("/v1/static/manifest", query: [])

        async let stations: [Station] = getAbsolute(manifest.files.stations.url)
        async let routes: [BusRoute] = getAbsolute(manifest.files.routes.url)
        async let routeStops: [RouteStops] = getAbsolute(manifest.files.stopOfRoute.url)
        async let shapes: [RouteShape] = getAbsolute(manifest.files.shapes.url)

        return StaticBundle(
            version: manifest.version,
            stations: try await stations,
            routes: try await routes,
            routeStops: try await routeStops,
            shapes: try await shapes
        )
    }

    // TODO: 依 manifest.version 做本機快取，version 沒變就不重抓；
    //       下載後依 files[].sha256 驗證**解壓後**內容（見 API_CONTRACT.md §3.1）。

    private struct StaticManifest: Decodable {
        struct File: Decodable {
            let url: URL
            let sha256: String
            /// 解壓後位元組數
            let bytes: Int
            /// 傳輸位元組數
            let gzipBytes: Int
        }
        struct Files: Decodable {
            let stations: File
            let routes: File
            let stopOfRoute: File
            let shapes: File
        }
        let version: String
        let builtAt: Date
        let minAppBuild: Int
        let files: Files
    }

    // MARK: - 回報（Cloud Functions，尚未部署）

    func reports(stationUID: String) async throws -> [BusReport] { [] }

    func aggregates(bbox: BBox) async throws -> [StationAggregate] { [] }

    func submitReport(_ draft: ReportDraft,
                      from location: CLLocation) async throws -> SubmitReportResult {
        throw BusAPIError.internalError("回報功能尚未上線（Cloud Functions 尚未部署）")
    }

    func deleteReport(reportId: String) async throws -> DeleteReportResult {
        throw BusAPIError.internalError("回報功能尚未上線（Cloud Functions 尚未部署）")
    }

    // MARK: - 傳輸

    /// 刻意不用 `appendingPathComponent` —— 傳入的 path 帶前導斜線，
    /// 那個 API 對斜線的處理會跟著 baseURL 有無尾斜線而變。直接組 path
    /// 字串可以讓 `http://localhost:8080` 與 `https://x.web.app/` 都正確。
    private func get<T: Decodable>(_ path: String, query: [URLQueryItem]) async throws -> T {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw BusAPIError.internalError("URL 組裝失敗：\(path)")
        }
        let base = components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path
        components.path = base + path
        components.queryItems = query.isEmpty ? nil : query

        guard let url = components.url else {
            throw BusAPIError.internalError("URL 組裝失敗：\(path)")
        }
        return try await getAbsolute(url)
    }

    private func getAbsolute<T: Decodable>(_ url: URL) async throws -> T {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(from: url)
        } catch let error as URLError {
            throw BusAPIError.network(Self.message(for: error))
        }

        guard let http = response as? HTTPURLResponse else {
            throw BusAPIError.internalError("非 HTTP 回應")
        }

        guard (200..<300).contains(http.statusCode) else {
            throw Self.apiError(from: data, statusCode: http.statusCode, headers: http)
        }

        do {
            return try Self.makeDecoder().decode(T.self, from: data)
        } catch {
            throw BusAPIError.internalError("回應格式無法解析：\(error.localizedDescription)")
        }
    }

    // MARK: - 錯誤對應

    private struct ErrorEnvelope: Decodable {
        struct Payload: Decodable {
            let code: String
            let message: String
            let details: Details?
        }
        struct Details: Decodable {
            let lastGoodAt: Date?
            let retryAfterSec: Int?
        }
        let error: Payload
    }

    /// 把後端的錯誤碼（API_CONTRACT.md §1.2）對應到 `BusAPIError`。
    ///
    /// `message` 直接沿用伺服器給的字串——後端已提供繁體中文文案，
    /// 在 App 端再寫一份只會兩邊分歧。
    private static func apiError(from data: Data,
                                 statusCode: Int,
                                 headers: HTTPURLResponse) -> BusAPIError {
        guard let envelope = try? makeDecoder().decode(ErrorEnvelope.self, from: data) else {
            return .internalError("伺服器錯誤（HTTP \(statusCode)）")
        }
        let payload = envelope.error

        switch payload.code {
        case "INVALID_ARGUMENT":
            return .invalidArgument(payload.message)
        case "NOT_FOUND":
            return .notFound(payload.message)
        case "RATE_LIMITED":
            let header = (headers.value(forHTTPHeaderField: "Retry-After")).flatMap(Int.init)
            return .rateLimited(retryAfterSec: payload.details?.retryAfterSec ?? header ?? 30,
                                message: payload.message)
        case "UPSTREAM_UNAVAILABLE":
            return .upstreamUnavailable(lastGoodAt: payload.details?.lastGoodAt,
                                        message: payload.message)
        default:
            return .internalError(payload.message)
        }
    }

    private static func message(for error: URLError) -> String {
        switch error.code {
        case .notConnectedToInternet: "目前沒有網路連線"
        case .timedOut:               "連線逾時，請稍後再試"
        case .cannotConnectToHost,
             .cannotFindHost:         "無法連線到伺服器"
        default:                      "連線失敗（\(error.code.rawValue)）"
        }
    }

    // MARK: - 解碼

    /// 伺服器的時間戳有兩種寫法：`serverTime` 帶毫秒、`gpsTime` 不一定帶。
    /// 兩種都試，不然某個欄位會在半夜莫名解碼失敗。
    ///
    /// - Note: 刻意每次建新的而不是存成 `static let`。`JSONDecoder` 是 class，
    ///   在 `SWIFT_STRICT_CONCURRENCY: complete` 下共用一個實例會因為
    ///   非 Sendable 而編譯失敗。建立成本相對於解碼本身可以忽略。
    private static func makeDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let raw = try decoder.singleValueContainer().decode(String.self)
            if let date = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(raw) {
                return date
            }
            if let date = try? Date.ISO8601FormatStyle().parse(raw) {
                return date
            }
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "無法解析時間戳：\(raw)")
            )
        }
        return decoder
    }
}
