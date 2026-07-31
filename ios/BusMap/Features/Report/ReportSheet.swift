import SwiftUI
import CoreLocation

/// 可回報的路線選項。由站位的到站資訊推導——
/// 一個站位可能有多條路線、多個方向的站牌（同站不同業者會有不同 StopUID）。
struct RouteOption: Identifiable, Hashable {
    let stopUID: String
    let routeUID: String
    let routeName: String
    let direction: Direction

    var id: String { stopUID }
    var label: String { "\(routeName)　\(direction.label)" }
}

/// 回報表單。三種類型 + 選填文字。
///
/// 照片上傳明確延後至 v1.1（REQUIREMENTS.md §8）——它是唯一同時能省開發時間、
/// 消除 Cloud Vision 成本失控風險、並降低 App Store UGC 審核退件機率的功能。
struct ReportSheet: View {
    let station: Station
    let api: BusAPI
    let location: LocationService
    var routeOptions: [RouteOption] = []
    let onSubmitted: () -> Void

    @State private var type: ReportType = .delay
    @State private var selectedRoute: RouteOption?
    @State private var crowdLevel: CrowdLevel = .stand
    @State private var waitMinutes = 10
    @State private var issueKind: IssueKind = .signWrong
    @State private var note = ""

    @State private var isSubmitting = false
    @State private var errorMessage: String?
    @State private var result: SubmitReportResult?

    @Environment(\.dismiss) private var dismiss

    private let noteLimit = 100

    var body: some View {
        NavigationStack {
            Group {
                if let result {
                    SubmitSuccessView(result: result) {
                        onSubmitted()
                        dismiss()
                    }
                } else {
                    form
                }
            }
            .navigationTitle(result == nil ? "回報　\(station.name)" : "已送出")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if result == nil {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("取消") { dismiss() }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("送出") { Task { await submit() } }
                            .disabled(!canSubmit || isSubmitting)
                    }
                }
            }
        }
        .presentationDetents([.large])
        .interactiveDismissDisabled(isSubmitting)
    }

    // MARK: - Form

    private var form: some View {
        List {
            Section("回報類型") {
                Picker("類型", selection: $type) {
                    ForEach(ReportType.allCases) { t in
                        Label(t.title, systemImage: t.systemImage).tag(t)
                    }
                }
                .pickerStyle(.inline)
                .labelsHidden()
            }

            if type != .stopIssue {
                routePicker
            }

            switch type {
            case .delay:     delaySection
            case .crowding:  crowdingSection
            case .stopIssue: issueSection
            }

            noteSection

            if let errorMessage {
                Section {
                    Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.conflict)
                }
            }
        }
        .listStyle(.insetGrouped)
        .overlay {
            if isSubmitting {
                ProgressView("送出中")
                    .padding(24)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: Theme.cardCorner))
            }
        }
    }

    private var routePicker: some View {
        Section("路線") {
            if routeOptions.isEmpty {
                Text("目前沒有可回報的路線").foregroundStyle(.secondary)
            } else {
                Picker("路線", selection: $selectedRoute) {
                    Text("請選擇").tag(RouteOption?.none)
                    ForEach(routeOptions) { option in
                        Text(option.label).tag(RouteOption?.some(option))
                    }
                }
            }
        }
    }

    private var delaySection: some View {
        Section {
            Stepper(value: $waitMinutes, in: 1...60) {
                HStack {
                    Text("已等候")
                    Spacer()
                    Text("\(waitMinutes) 分鐘")
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
            }
        } footer: {
            Text("送出後會立即與交通部官方預估比對。若官方顯示即將到站但多人回報未出現，其他使用者會看到警示。")
        }
    }

    private var crowdingSection: some View {
        Section {
            Picker("擁擠度", selection: $crowdLevel) {
                ForEach(CrowdLevel.allCases) { level in
                    Label(level.label, systemImage: level.systemImage).tag(level)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
        } header: {
            Text("車廂擁擠度")
        } footer: {
            // 誠實揭露：TDX 沒有任何載客/擁擠度欄位，這類資料完全依賴群眾回報
            Text("台北市公車未開放車廂載客資料，擁擠度完全來自使用者回報，無法與官方資料交叉驗證。")
        }
    }

    private var issueSection: some View {
        Section("異常類型") {
            Picker("異常類型", selection: $issueKind) {
                ForEach(IssueKind.allCases) { kind in
                    Text(kind.label).tag(kind)
                }
            }
            .pickerStyle(.inline)
            .labelsHidden()
        }
    }

    private var noteSection: some View {
        Section {
            TextField("補充說明（選填）", text: $note, axis: .vertical)
                .lineLimit(2...5)
                .onChange(of: note) { _, newValue in
                    if newValue.count > noteLimit {
                        note = String(newValue.prefix(noteLimit))
                    }
                }
        } footer: {
            HStack {
                Text("其他使用者會看到這段文字")
                Spacer()
                Text("\(note.count)/\(noteLimit)")
                    .monospacedDigit()
                    .foregroundStyle(note.count >= noteLimit ? Theme.conflict : .secondary)
            }
            .font(.system(size: 12))
        }
    }

    // MARK: - Submit

    private var canSubmit: Bool {
        guard location.canReport(at: station) else { return false }
        switch type {
        case .delay, .crowding: return selectedRoute != nil
        case .stopIssue:        return true
        }
    }

    private func submit() async {
        guard let currentLocation = location.currentLocation else {
            errorMessage = "尚未取得定位，請稍候再試"
            return
        }

        var draft = ReportDraft(
            type: type,
            stopUID: selectedRoute?.stopUID ?? station.stops.first?.stopUID ?? "",
            stationUID: station.stationUID,
            routeUID: selectedRoute?.routeUID,
            direction: selectedRoute?.direction,
            plateNumb: nil
        )
        draft.note = note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : note

        switch type {
        case .delay:     draft.reportedWaitMinutes = waitMinutes
        case .crowding:  draft.crowdLevel = crowdLevel
        case .stopIssue: draft.issueKind = issueKind
        }

        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }

        do {
            result = try await api.submitReport(draft, from: currentLocation)
        } catch let error as BusAPIError {
            errorMessage = error.userMessage
        } catch {
            errorMessage = "送出失敗，請稍後再試"
        }
    }
}

// MARK: - 送出結果

private struct SubmitSuccessView: View {
    let result: SubmitReportResult
    let onDone: () -> Void

    var body: some View {
        VStack(spacing: 20) {
            Spacer()

            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 54))
                .foregroundStyle(.green)

            Text("回報已送出")
                .font(.system(size: 20, weight: .semibold))

            if let cross = result.crossCheck {
                VStack(spacing: 8) {
                    Text(cross.message)
                        .font(.system(size: 14, weight: .medium))
                        .multilineTextAlignment(.center)
                        .foregroundStyle(cross.verdict == .conflicting ? Theme.conflict : .secondary)

                    if cross.verdict == .conflicting {
                        Text("這筆回報會提醒其他等車的人")
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity)
                .background(
                    (cross.verdict == .conflicting ? Theme.conflict : Color.secondary)
                        .opacity(0.1),
                    in: RoundedRectangle(cornerRadius: Theme.cardCorner)
                )
                .padding(.horizontal, 24)
            }

            Text("回報將於 10 分鐘後自動失效")
                .font(.system(size: 12))
                .foregroundStyle(.tertiary)

            Spacer()

            Button(action: onDone) {
                Text("完成")
                    .font(.system(size: 16, weight: .semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 13)
            }
            .buttonStyle(.borderedProminent)
            .padding(.horizontal, 24)
            .padding(.bottom, 20)
        }
    }
}

#Preview("回報表單") {
    let bundle = MockBusAPI.bundle(center: .init(latitude: 25.0465, longitude: 121.5175))
    return ReportSheet(
        station: bundle.stations[0],
        api: MockBusAPI(),
        location: LocationService(),
        routeOptions: [
            RouteOption(stopUID: "TPE50629", routeUID: "TPE10132", routeName: "270", direction: .outbound),
            RouteOption(stopUID: "TPE50711", routeUID: "TPE10874", routeName: "307", direction: .outbound),
        ],
        onSubmitted: {}
    )
}
