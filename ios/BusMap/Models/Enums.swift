import Foundation

/// 路線方向。TDX 原值 0=去程 1=返程。
enum Direction: Int, Codable, Hashable, CaseIterable {
    case outbound = 0
    case inbound  = 1

    var label: String {
        switch self {
        case .outbound: "去程"
        case .inbound:  "返程"
        }
    }
}

/// TDX `BusStatus` 原值。只有 `.normal` 以外需要在 UI 上示警。
enum BusStatus: Int, Codable, Hashable {
    case normal        = 0
    case accident      = 1
    case malfunction   = 2
    case traffic       = 3
    case emergency     = 4
    case refuelling    = 5
    case unknown       = 99

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(Int.self)
        self = BusStatus(rawValue: raw) ?? .unknown
    }

    var isAbnormal: Bool { self != .normal }

    /// nil 表示正常，不需顯示任何標示。
    var label: String? {
        switch self {
        case .normal:      nil
        case .accident:    "事故"
        case .malfunction: "故障"
        case .traffic:     "塞車"
        case .emergency:   "緊急"
        case .refuelling:  "加油"
        case .unknown:     nil
        }
    }
}

/// TDX `DutyStatus` 原值。
enum DutyStatus: Int, Codable, Hashable {
    case normal      = 0
    case outOfService = 1
    case toOrigin    = 2
    case unknown     = 99

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(Int.self)
        self = DutyStatus(rawValue: raw) ?? .unknown
    }
}

/// TDX `StopStatus` 原值。`estimateSec == nil` 時一律以此為準。
enum StopStatus: Int, Codable, Hashable {
    case normal        = 0
    case notDeparted   = 1
    case skipped       = 2
    case lastBusPassed = 3
    case noService     = 4
    case unknown       = 99

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(Int.self)
        self = StopStatus(rawValue: raw) ?? .unknown
    }

    /// nil 表示應改用 `estimateSec` 顯示時間。
    var overrideLabel: String? {
        switch self {
        case .normal:        nil
        case .notDeparted:   "尚未發車"
        case .skipped:       "不停靠"
        case .lastBusPassed: "末班已過"
        case .noService:     "今日未營運"
        case .unknown:       "－"
        }
    }
}

// MARK: - 回報

enum ReportType: String, Codable, Hashable, CaseIterable, Identifiable {
    case delay
    case crowding
    case stopIssue

    var id: String { rawValue }

    var title: String {
        switch self {
        case .delay:     "誤點／還沒來"
        case .crowding:  "車廂擁擠度"
        case .stopIssue: "站牌異常"
        }
    }

    var systemImage: String {
        switch self {
        case .delay:     "clock.badge.exclamationmark"
        case .crowding:  "person.3.fill"
        case .stopIssue: "exclamationmark.triangle.fill"
        }
    }

    /// 擁擠度沒有任何官方資料可以交叉比對，UI 必須據此標示。
    /// 見 REQUIREMENTS.md §4.1。
    var hasOfficialCrossCheck: Bool {
        self == .delay
    }
}

enum CrowdLevel: String, Codable, Hashable, CaseIterable, Identifiable {
    case seat
    case stand
    case packed

    var id: String { rawValue }

    var label: String {
        switch self {
        case .seat:   "有位"
        case .stand:  "站位"
        case .packed: "爆滿"
        }
    }

    var systemImage: String {
        switch self {
        case .seat:   "figure.seated.side"
        case .stand:  "figure.stand"
        case .packed: "person.3.sequence.fill"
        }
    }
}

enum IssueKind: String, Codable, Hashable, CaseIterable, Identifiable {
    case signWrong
    case construction
    case inaccessible
    case other

    var id: String { rawValue }

    var label: String {
        switch self {
        case .signWrong:    "牌面資訊錯誤"
        case .construction: "施工／封閉"
        case .inaccessible: "無法通行"
        case .other:        "其他"
        }
    }
}

/// 誤點回報與 TDX 官方預估的比對結果。
/// `conflicting` 是本 App 最有價值的輸出，見 DESIGN.md §4.2。
enum CrossCheckVerdict: String, Codable, Hashable {
    case consistent
    case conflicting
    case unavailable
}
