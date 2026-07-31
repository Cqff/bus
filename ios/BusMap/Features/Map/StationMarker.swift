import SwiftUI

/// 地圖上的站位標記。有回報時放大並標示回報數；
/// 有「與官方預估不符」的回報時使用最高視覺優先級（紅色 + 驚嘆號）。
struct StationMarker: View {
    let station: Station
    let aggregate: StationAggregate?
    let isSelected: Bool

    var body: some View {
        VStack(spacing: 2) {
            ZStack {
                Circle()
                    .fill(fillColor)
                    .frame(width: diameter, height: diameter)
                    .overlay(Circle().strokeBorder(.white, lineWidth: 1.6))

                if let agg = aggregate, agg.hasReports {
                    if agg.isConflicting {
                        Image(systemName: "exclamationmark")
                            .font(.system(size: 10, weight: .heavy))
                            .foregroundStyle(.white)
                    } else {
                        Text("\(agg.totalCount)")
                            .font(.system(size: 9, weight: .bold, design: .rounded))
                            .foregroundStyle(.white)
                    }
                }
            }

            if isSelected {
                Text(station.name)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.primary)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 4))
            }
        }
        .shadow(color: .black.opacity(0.25), radius: 2, y: 1)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
    }

    private var diameter: CGFloat {
        guard let agg = aggregate, agg.hasReports else { return 11 }
        return agg.isConflicting ? 22 : 18
    }

    private var fillColor: Color {
        guard let agg = aggregate, agg.hasReports else {
            return Color(white: 0.42)
        }
        if agg.isConflicting { return Theme.conflict }
        if let level = agg.crowding.dominant, agg.crowding.total >= agg.delayCount {
            return Theme.crowd(level)
        }
        return Theme.report
    }

    private var accessibilityText: String {
        guard let agg = aggregate, agg.hasReports else { return station.name }
        if agg.isConflicting {
            return "\(station.name)，\(agg.conflictingCount) 筆回報與官方預估不符"
        }
        return "\(station.name)，\(agg.totalCount) 筆回報"
    }
}

#Preview("站位標記", traits: .sizeThatFitsLayout) {
    let station = Station(stationUID: "TPE9800", name: "臺北車站", nameEn: nil,
                          lat: 25.0465, lon: 121.5175, stops: [])
    return HStack(spacing: 30) {
        StationMarker(station: station, aggregate: nil, isSelected: false)
        StationMarker(station: station,
                      aggregate: MockBusAPI.aggregates()[1], isSelected: false)
        StationMarker(station: station,
                      aggregate: MockBusAPI.aggregates()[0], isSelected: false)
        StationMarker(station: station,
                      aggregate: MockBusAPI.aggregates()[0], isSelected: true)
    }
    .padding(40)
}
