import SwiftUI

/// 站位詳情：官方預估到站 + 使用者回報 + 回報入口。
///
/// 「與官方預估不符」的回報排在最上方且樣式最強——這是本 App 唯一
/// 官方管道給不了的資訊，見 DESIGN.md §4.2。
struct StationDetailSheet: View {
    let station: Station
    let api: BusAPI
    let location: LocationService

    @State private var etas: [BusETA] = []
    @State private var reports: [BusReport] = []
    @State private var isLoading = true
    @State private var loadError: String?
    @State private var showReportSheet = false

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if let loadError {
                    Section {
                        Label(loadError, systemImage: "exclamationmark.triangle")
                            .font(.system(size: 13))
                            .foregroundStyle(.secondary)
                    }
                }

                if !conflictingReports.isEmpty {
                    conflictSection
                }

                etaSection

                if !otherReports.isEmpty {
                    reportSection
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle(station.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("關閉") { dismiss() }
                }
            }
            .safeAreaInset(edge: .bottom) { reportButton }
            .task { await load() }
            .sheet(isPresented: $showReportSheet) {
                ReportSheet(station: station, api: api, location: location,
                            routeOptions: routeOptions) {
                    Task { await load() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    // MARK: - Sections

    private var conflictSection: some View {
        Section {
            ForEach(conflictingReports) { report in
                ReportRow(report: report)
            }
        } header: {
            Label("與官方預估不符", systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(Theme.conflict)
                .font(.system(size: 13, weight: .bold))
        } footer: {
            Text("官方預估顯示即將到站，但有使用者回報車輛未出現。")
                .font(.system(size: 12))
        }
    }

    private var etaSection: some View {
        Section {
            if isLoading && etas.isEmpty {
                HStack { ProgressView(); Text("載入中").foregroundStyle(.secondary) }
            } else if etas.isEmpty {
                Text("目前沒有到站資訊").foregroundStyle(.secondary)
            } else {
                ForEach(etas) { eta in
                    ETARow(eta: eta)
                }
            }
        } header: {
            Text("官方預估到站")
        } footer: {
            Text("資料來源：交通部 TDX，更新頻率約每分鐘一次。")
                .font(.system(size: 12))
        }
    }

    private var reportSection: some View {
        Section("使用者回報") {
            ForEach(otherReports) { report in
                ReportRow(report: report)
            }
        }
    }

    private var reportButton: some View {
        VStack(spacing: 6) {
            Button {
                showReportSheet = true
            } label: {
                Label("回報這個站牌", systemImage: "plus.bubble.fill")
                    .font(.system(size: 16, weight: .semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 13)
            }
            .buttonStyle(.borderedProminent)
            .disabled(!canReport)

            if let hint = reportHint {
                Text(hint)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .background(.bar)
    }

    // MARK: - Derived

    private var conflictingReports: [BusReport] {
        reports.filter { $0.verdict == .conflicting && !$0.isExpired }
    }

    private var otherReports: [BusReport] {
        reports.filter { $0.verdict != .conflicting && !$0.isExpired }
    }

    private var canReport: Bool {
        location.canReport(at: station)
    }

    /// 可回報的路線由到站資訊推導——這些正是實際停靠此站位的路線與方向。
    private var routeOptions: [RouteOption] {
        etas.map {
            RouteOption(stopUID: $0.stopUID, routeUID: $0.routeUID,
                        routeName: $0.routeName, direction: $0.direction)
        }
    }

    /// 明確告訴使用者為什麼不能回報，以及還差多少距離。
    private var reportHint: String? {
        guard !location.isAuthorized else {
            guard let distance = location.distance(to: station) else {
                return "正在取得定位…"
            }
            guard !location.hasUsableAccuracy else {
                return distance <= LocationService.reportRadiusM
                    ? nil
                    : "距離站牌 \(Int(distance)) 公尺，需在 \(Int(LocationService.reportRadiusM)) 公尺內才能回報"
            }
            return "定位精度不足，請至空曠處再試"
        }
        return "需要定位權限才能回報，以確認您在站牌附近"
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            async let etaTask = api.etas(stationUID: station.stationUID)
            async let reportTask = api.reports(stationUID: station.stationUID)
            etas = try await etaTask
            reports = try await reportTask
            loadError = nil
        } catch let error as BusAPIError {
            loadError = error.userMessage
        } catch {
            loadError = "載入失敗，請稍後再試"
        }
    }
}

// MARK: - Rows

private struct ETARow: View {
    let eta: BusETA

    var body: some View {
        HStack(spacing: 12) {
            Text(eta.routeName)
                .font(Theme.routeNumber(15))
                .foregroundStyle(.white)
                .frame(minWidth: 44)
                .padding(.horizontal, 7)
                .padding(.vertical, 4)
                .background(Theme.bus, in: RoundedRectangle(cornerRadius: 7))

            VStack(alignment: .leading, spacing: 1) {
                Text(eta.direction.label)
                    .font(.system(size: 13, weight: .medium))
                if let plate = eta.plateNumb {
                    Text(plate)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .monospaced()
                }
            }

            Spacer()

            Text(eta.displayText)
                .font(.system(size: 15, weight: eta.isImminent ? .bold : .regular,
                              design: .rounded))
                .foregroundStyle(eta.isImminent ? Theme.conflict : .primary)
                .monospacedDigit()
        }
        .padding(.vertical, 2)
    }
}

private struct ReportRow: View {
    let report: BusReport

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
                Image(systemName: report.type.systemImage)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(tint)

                if let name = report.routeName {
                    Text(name)
                        .font(Theme.routeNumber(12))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(tint, in: RoundedRectangle(cornerRadius: 4))
                }

                Text(report.summary)
                    .font(.system(size: 14, weight: .medium))

                Spacer()

                Text(report.relativeAge)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }

            if let note = report.note {
                Text(note)
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if report.type == .crowding {
                // 擁擠度無任何官方資料可比對，必須明講——見 REQUIREMENTS.md §4.1
                Text("僅供參考，未經官方驗證")
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 3)
    }

    private var tint: Color {
        if report.verdict == .conflicting { return Theme.conflict }
        if let level = report.crowdLevel { return Theme.crowd(level) }
        return Theme.report
    }
}

#Preview("站位詳情") {
    StationDetailSheet(
        station: MockBusAPI.bundle(center: .init(latitude: 25.0465, longitude: 121.5175)).stations[0],
        api: MockBusAPI(),
        location: LocationService()
    )
}
