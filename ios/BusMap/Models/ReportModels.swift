import Foundation

/// 使用者回報。對應 Firestore `reports/{reportId}` 的 **client 可讀欄位**。
/// `deviceHash` / `uid` / `reporterGeo` 由 Security Rules 擋住，不會出現在這裡。
struct BusReport: Identifiable, Hashable {
    let id: String
    let type: ReportType
    let stopUID: String
    let stationUID: String
    let routeUID: String?
    let routeName: String?
    let direction: Direction?
    let plateNumb: String?

    let crowdLevel: CrowdLevel?
    let reportedWaitMinutes: Int?
    let issueKind: IssueKind?

    let note: String?
    let createdAt: Date
    let expiresAt: Date
    let verdict: CrossCheckVerdict?
    let flagCount: Int

    var isExpired: Bool { expiresAt < Date() }

    /// 「N 分鐘前」。回報顯示時效僅 10 分鐘，故只需分鐘級精度。
    var relativeAge: String {
        let minutes = Int(Date().timeIntervalSince(createdAt) / 60)
        return minutes < 1 ? "剛剛" : "\(minutes) 分鐘前"
    }

    var summary: String {
        switch type {
        case .delay:
            if let m = reportedWaitMinutes { return "已等 \(m) 分鐘仍未出現" }
            return "回報車輛未出現"
        case .crowding:
            return crowdLevel?.label ?? "擁擠度回報"
        case .stopIssue:
            return issueKind?.label ?? "站牌異常"
        }
    }
}

/// 站位聚合。對應 Firestore `stopAggregates/{stationUID}`。
/// `count` 已由後端排除過期回報，App **不需要**自行過濾時間。
struct StationAggregate: Identifiable, Hashable {
    let stationUID: String
    let delayCount: Int
    let conflictingCount: Int
    let crowding: CrowdBreakdown
    let stopIssueCount: Int
    let updatedAt: Date

    var id: String { stationUID }

    var totalCount: Int { delayCount + crowding.total + stopIssueCount }
    var hasReports: Bool { totalCount > 0 }

    /// 有回報與官方預估不符時，標記需要最高視覺優先級。
    var isConflicting: Bool { conflictingCount > 0 }
}

struct CrowdBreakdown: Hashable {
    var seat: Int = 0
    var stand: Int = 0
    var packed: Int = 0

    var total: Int { seat + stand + packed }

    /// 回報數最多的擁擠等級，用於地圖標記。
    var dominant: CrowdLevel? {
        let pairs: [(CrowdLevel, Int)] = [(.seat, seat), (.stand, stand), (.packed, packed)]
        guard let best = pairs.max(by: { $0.1 < $1.1 }), best.1 > 0 else { return nil }
        return best.0
    }
}

// MARK: - 送出

/// `submitReport` callable 的請求內容。
/// `deviceId` / 座標由 `ReportService` 在送出時補上，UI 層不需要處理。
struct ReportDraft {
    var type: ReportType
    var stopUID: String
    var stationUID: String
    var routeUID: String?
    var direction: Direction?
    var plateNumb: String?

    var crowdLevel: CrowdLevel?
    var reportedWaitMinutes: Int?
    var issueKind: IssueKind?

    var note: String?

    /// 送出前的本地檢查——避免明顯無效的請求浪費一次伺服器往返。
    /// 真正的驗證仍在伺服器端（見 API_CONTRACT.md §4.1）。
    var isComplete: Bool {
        switch type {
        case .delay:     routeUID != nil && reportedWaitMinutes != nil
        case .crowding:  routeUID != nil && crowdLevel != nil
        case .stopIssue: issueKind != nil
        }
    }
}

struct SubmitReportResult {
    let reportId: String
    let expiresAt: Date
    let crossCheck: CrossCheckResult?
    let stationSummary: StationAggregate
}

struct CrossCheckResult {
    let verdict: CrossCheckVerdict
    let tdxEstimateSec: Int?
    /// 伺服器產生的繁體中文訊息，可直接顯示。
    let message: String
}
