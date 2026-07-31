import Foundation
import Observation

/// 使用者自己送出的回報摘要。**只存在本機，永不上傳。**
///
/// 這份清單是無帳號設計下唯一的所有權證明——與 Firebase 匿名 uid 併用，
/// 讓使用者能刪除自己的回報而不必交出任何身分資訊。見 DESIGN.md §4.4。
struct MyReport: Identifiable, Codable, Hashable {
    let reportId: String
    let type: ReportType
    let stationUID: String
    let stationName: String
    let routeName: String?
    let summary: String
    let note: String?
    let createdAt: Date

    /// 已送出刪除請求的時間。非 nil 表示正在等待分析資料庫的排程清除。
    var deletionRequestedAt: Date?
    /// 伺服器回報的分析資料庫預計清除完成時間。
    var analyticsPurgeAt: Date?

    var id: String { reportId }

    var isDeletionPending: Bool {
        guard let purgeAt = analyticsPurgeAt else { return deletionRequestedAt != nil }
        return purgeAt > Date()
    }
}

/// 本機回報清單。
///
/// **保留期限：永久，直到使用者主動刪除。**
/// 回報在地圖上 10 分鐘後就消失了，但長期分析資料庫那份是永久保存的——
/// 使用者要行使刪除權的對象正是後者，所以本機索引必須一直留著。
@Observable
@MainActor
final class MyReportsStore {

    private(set) var reports: [MyReport] = []

    private let fileURL: URL
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(filename: String = "my-reports.json") {
        let base = (try? FileManager.default.url(for: .applicationSupportDirectory,
                                                 in: .userDomainMask,
                                                 appropriateFor: nil,
                                                 create: true))
            ?? URL.temporaryDirectory
        fileURL = base.appendingPathComponent(filename)
        encoder.dateEncodingStrategy = .iso8601
        decoder.dateDecodingStrategy = .iso8601
        load()
    }

    var hasReports: Bool { !reports.isEmpty }

    /// 送出成功後立即記錄。
    func add(_ report: MyReport) {
        reports.insert(report, at: 0)
        save()
    }

    /// 刪除請求已被伺服器受理。保留項目並標示處理中——
    /// 直接從清單移除會讓使用者以為已完成，但分析資料庫其實還沒清。
    func markDeletionRequested(reportId: String, analyticsPurgeAt: Date) {
        guard let index = reports.firstIndex(where: { $0.reportId == reportId }) else { return }
        reports[index].deletionRequestedAt = Date()
        reports[index].analyticsPurgeAt = analyticsPurgeAt
        save()
    }

    /// 移除本機紀錄。用於清除已完成刪除的項目，或使用者選擇僅清本機索引。
    func forget(reportId: String) {
        reports.removeAll { $0.reportId == reportId }
        save()
    }

    /// 清掉已過清除時限的項目——此時分析資料庫應已完成刪除。
    func pruneCompleted() {
        let before = reports.count
        reports.removeAll { report in
            guard let purgeAt = report.analyticsPurgeAt else { return false }
            return purgeAt <= Date()
        }
        if reports.count != before { save() }
    }

    // MARK: - Persistence

    private func load() {
        guard let data = try? Data(contentsOf: fileURL) else { return }
        reports = (try? decoder.decode([MyReport].self, from: data)) ?? []
    }

    private func save() {
        guard let data = try? encoder.encode(reports) else { return }
        // 標為不參與 iCloud 備份——這份索引只對這台裝置的匿名 uid 有意義
        try? data.write(to: fileURL, options: .atomic)
        var resourceValues = URLResourceValues()
        resourceValues.isExcludedFromBackup = true
        var url = fileURL
        try? url.setResourceValues(resourceValues)
    }
}
