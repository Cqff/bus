import Foundation
import Observation

/// 公車即時位置的輪詢與狀態管理。
///
/// 輪詢規則由 API_CONTRACT.md §2.1 規定，此處為唯一實作點：
/// - 前景每 15 秒；進入背景立即停止
/// - 回到前景立即打一次
/// - 連續 3 次失敗改為 60 秒退避，成功後恢復
/// - 上游中斷時**保留舊資料**，不清空（絕不顯示空地圖）
@Observable
@MainActor
final class LiveBusStore {

    enum Mode: Equatable {
        /// 未選路線：依地圖視野取附近所有路線。
        case viewport(BBox)
        /// 已選路線：只取該路線。
        case route(routeUID: String, direction: Direction?)
    }

    private(set) var buses: [LiveBus] = []
    private(set) var truncated = false
    private(set) var lastUpdated: Date?
    private(set) var isRefreshing = false

    /// 非 nil 表示正在降級顯示舊資料，UI 須出示警示橫幅。
    private(set) var degradedMessage: String?

    /// 非降級類的錯誤（例如網路不通）。
    private(set) var errorMessage: String?

    private let api: BusAPI
    private var mode: Mode?
    private var pollTask: Task<Void, Never>?
    private var consecutiveFailures = 0

    private let normalInterval: Duration = .seconds(15)
    private let backoffInterval: Duration = .seconds(60)
    private let failureThreshold = 3

    init(api: BusAPI) {
        self.api = api
    }

    // MARK: - 生命週期

    /// 設定查詢模式。相同模式重複設定不會重啟輪詢（避免地圖微調造成的抖動），
    /// 但若輪詢已被 `suspend()` 停掉則仍需重啟——例如視野拉遠停止後又拉近回來。
    func setMode(_ newMode: Mode) {
        guard mode != newMode || pollTask == nil else { return }
        mode = newMode
        restart()
    }

    /// 進入前景。立即抓一次再恢復定期輪詢。
    func resume() {
        guard mode != nil, pollTask == nil else { return }
        restart()
    }

    /// 進入背景。立即停止——省電且省流量。
    func suspend() {
        pollTask?.cancel()
        pollTask = nil
        isRefreshing = false
    }

    private func restart() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.fetchOnce()
                let interval = self.currentInterval
                try? await Task.sleep(for: interval)
            }
        }
    }

    private var currentInterval: Duration {
        consecutiveFailures >= failureThreshold ? backoffInterval : normalInterval
    }

    // MARK: - 抓取

    private func fetchOnce() async {
        guard let mode else { return }
        isRefreshing = true
        defer { isRefreshing = false }

        do {
            let response: LiveBusesResponse
            switch mode {
            case .viewport(let bbox):
                response = try await api.liveBuses(bbox: bbox, limit: Self.viewportLimit)
            case .route(let uid, let direction):
                response = try await api.liveBuses(routeUID: uid, direction: direction)
            }
            guard !Task.isCancelled else { return }

            buses = response.buses
            truncated = response.truncated
            lastUpdated = response.serverTime
            degradedMessage = nil
            errorMessage = nil
            consecutiveFailures = 0

        } catch let error as BusAPIError {
            consecutiveFailures += 1
            if error.isDegradable {
                // 保留 buses，只掛警示——見 API_CONTRACT.md §1.2
                degradedMessage = degradationBanner(for: error)
            } else {
                errorMessage = error.userMessage
            }
        } catch {
            consecutiveFailures += 1
            errorMessage = "連線失敗，正在重試"
        }
    }

    private func degradationBanner(for error: BusAPIError) -> String {
        guard case .upstreamUnavailable(let lastGoodAt, _) = error else {
            return "官方資料來源中斷"
        }
        guard let lastGoodAt else { return "官方資料來源中斷" }
        let minutes = max(1, Int(Date().timeIntervalSince(lastGoodAt) / 60))
        return "⚠️ 官方資料來源中斷，顯示 \(minutes) 分鐘前資料"
    }

    /// 視野模式的車輛數上限。見 DESIGN.md §5.2。
    static let viewportLimit = 60
}
