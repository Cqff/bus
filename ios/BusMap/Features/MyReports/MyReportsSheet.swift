import SwiftUI

/// 「我的回報」——履行個資法當事人刪除權的入口。
///
/// 清單來自本機（`MyReportsStore`），刪除時由伺服器比對匿名 uid 驗證所有權。
/// 見 DESIGN.md §4.4、PRIVACY_POLICY.md §7。
struct MyReportsSheet: View {
    let api: BusAPI

    @Environment(MyReportsStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var pendingDeletion: MyReport?
    @State private var deletingIds: Set<String> = []
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Group {
                if store.reports.isEmpty {
                    ContentUnavailableView(
                        "尚無回報紀錄",
                        systemImage: "bubble.left.and.exclamationmark.bubble.right",
                        description: Text("您送出的回報會顯示在這裡，可隨時刪除。\n這份清單只存在您的裝置上，不會上傳。")
                    )
                } else {
                    list
                }
            }
            .navigationTitle("我的回報")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("關閉") { dismiss() }
                }
            }
            .task { store.pruneCompleted() }
            .alert("刪除這筆回報？", isPresented: .constant(pendingDeletion != nil),
                   presenting: pendingDeletion) { report in
                Button("刪除", role: .destructive) {
                    let target = report
                    pendingDeletion = nil
                    Task { await delete(target) }
                }
                Button("取消", role: .cancel) { pendingDeletion = nil }
            } message: { _ in
                Text("即時資料會立即移除；長期分析資料庫的紀錄將於 24 小時內清除。")
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private var list: some View {
        List {
            Section {
                ForEach(store.reports) { report in
                    MyReportRow(report: report,
                                isDeleting: deletingIds.contains(report.reportId))
                        .swipeActions(edge: .trailing) {
                            if !report.isDeletionPending {
                                Button("刪除", role: .destructive) {
                                    pendingDeletion = report
                                }
                            }
                        }
                }
            } footer: {
                VStack(alignment: .leading, spacing: 8) {
                    if let errorMessage {
                        Text(errorMessage)
                            .foregroundStyle(Theme.conflict)
                    }
                    // 誠實揭露匿名設計的代價——見 PRIVACY_POLICY.md §7.2
                    Text("這份清單只存在您的裝置上。若您刪除 App，紀錄會一併消失，"
                         + "屆時將無法再刪除先前送出的回報。若在意這點，請在刪除 App 前先於此處清除。")
                }
                .font(.system(size: 12))
            }
        }
        .listStyle(.insetGrouped)
    }

    private func delete(_ report: MyReport) async {
        deletingIds.insert(report.reportId)
        defer { deletingIds.remove(report.reportId) }
        errorMessage = nil

        do {
            let result = try await api.deleteReport(reportId: report.reportId)
            store.markDeletionRequested(reportId: report.reportId,
                                        analyticsPurgeAt: result.analyticsPurgeAt)
        } catch let error as BusAPIError {
            errorMessage = error.userMessage
        } catch {
            errorMessage = "刪除失敗，請稍後再試"
        }
    }
}

private struct MyReportRow: View {
    let report: MyReport
    let isDeleting: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
                Image(systemName: report.type.systemImage)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.secondary)

                if let routeName = report.routeName {
                    Text(routeName)
                        .font(Theme.routeNumber(12))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(Theme.bus, in: RoundedRectangle(cornerRadius: 4))
                }

                Text(report.stationName)
                    .font(.system(size: 14, weight: .medium))

                Spacer()

                if isDeleting {
                    ProgressView().controlSize(.small)
                }
            }

            Text(report.summary)
                .font(.system(size: 13))
                .foregroundStyle(.secondary)

            if let note = report.note {
                Text(note)
                    .font(.system(size: 12))
                    .foregroundStyle(.tertiary)
                    .lineLimit(2)
            }

            HStack(spacing: 6) {
                Text(report.createdAt, format: .dateTime.month().day().hour().minute())
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)

                if report.isDeletionPending {
                    // 「處理中」而非「已刪除」——分析資料庫的清除是排程作業，
                    // 寫「已刪除」是不實陳述
                    Label("刪除處理中", systemImage: "clock.arrow.circlepath")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(Theme.busAbnormal)
                }
            }
        }
        .padding(.vertical, 3)
        .opacity(report.isDeletionPending ? 0.55 : 1)
    }
}

#Preview("我的回報") {
    let store = MyReportsStore(filename: "preview-my-reports.json")
    store.add(MyReport(reportId: "r1", type: .delay, stationUID: "TPE9800",
                       stationName: "臺北車站", routeName: "270",
                       summary: "已等 14 分鐘仍未出現",
                       note: "站牌顯示 3 分鐘但等了快 15 分鐘", createdAt: Date().addingTimeInterval(-3600)))
    store.add(MyReport(reportId: "r2", type: .crowding, stationUID: "TPE9801",
                       stationName: "公園路", routeName: "307",
                       summary: "爆滿", note: nil,
                       createdAt: Date().addingTimeInterval(-86400),
                       deletionRequestedAt: Date(),
                       analyticsPurgeAt: Date().addingTimeInterval(3600)))
    return MyReportsSheet(api: MockBusAPI())
        .environment(store)
}
