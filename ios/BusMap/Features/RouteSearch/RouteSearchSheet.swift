import SwiftUI

/// 路線搜尋。MVP 只支援以路線號碼搜尋——
/// 「我的最愛路線」需要帳號系統，明確排除於 MVP 之外（REQUIREMENTS.md §8）。
struct RouteSearchSheet: View {
    let routes: [BusRoute]
    let onSelect: (BusRoute) -> Void

    @State private var query = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if filtered.isEmpty {
                    ContentUnavailableView(
                        query.isEmpty ? "輸入路線號碼" : "找不到「\(query)」",
                        systemImage: query.isEmpty ? "bus" : "magnifyingglass",
                        description: Text(query.isEmpty
                            ? "例如 270、藍7、小12"
                            : "請確認號碼是否正確，或此路線可能不屬臺北市公車")
                    )
                } else {
                    List(filtered) { route in
                        Button {
                            onSelect(route)
                            dismiss()
                        } label: {
                            RouteRow(route: route)
                        }
                        .buttonStyle(.plain)
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("搜尋路線")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, prompt: "路線號碼")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("關閉") { dismiss() }
                }
            }
        }
        .presentationDetents([.large])
    }

    private var filtered: [BusRoute] {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return [] }
        return routes
            .filter {
                $0.routeName.localizedCaseInsensitiveContains(trimmed) ||
                $0.departureStop.localizedCaseInsensitiveContains(trimmed) ||
                $0.destinationStop.localizedCaseInsensitiveContains(trimmed)
            }
            .sorted { lhs, rhs in
                // 完全相符優先，其次才是數字序
                let lExact = lhs.routeName.caseInsensitiveCompare(trimmed) == .orderedSame
                let rExact = rhs.routeName.caseInsensitiveCompare(trimmed) == .orderedSame
                if lExact != rExact { return lExact }
                return lhs.sortKey < rhs.sortKey
            }
    }
}

private struct RouteRow: View {
    let route: BusRoute

    var body: some View {
        HStack(spacing: 12) {
            Text(route.routeName)
                .font(Theme.routeNumber(16))
                .foregroundStyle(.white)
                .frame(minWidth: 46)
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(Theme.bus, in: RoundedRectangle(cornerRadius: 8))

            VStack(alignment: .leading, spacing: 2) {
                Text(route.subtitle)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                if let en = route.nameEn {
                    Text(en)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
            }

            Spacer()

            Image(systemName: "chevron.right")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }
}

#Preview("路線搜尋") {
    RouteSearchSheet(
        routes: MockBusAPI.bundle(center: .init(latitude: 25.0465, longitude: 121.5175)).routes,
        onSelect: { _ in }
    )
}
