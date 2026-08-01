import SwiftUI

/// 地圖上的單一公車標記：路線號碼膠囊 + 行進方向箭頭 + 資料時效。
///
/// 「顯示資料有多舊」是刻意的產品決策——TDX 動態資料本身就有分鐘級延遲，
/// 誠實揭露反而是相對官方 App 的優勢。見 DESIGN.md §0.1。
struct BusMarker: View {
    let bus: LiveBus

    /// 箭頭方向。有推算時是沿線型的當下方位角（會跟著轉彎），
    /// 沒有推算時就是 API 給的 `bus.azimuth`。
    let azimuth: Double

    init(bus: LiveBus, azimuth: Double? = nil) {
        self.bus = bus
        self.azimuth = azimuth ?? bus.azimuth
    }

    var body: some View {
        ZStack {
            // 方向箭頭繞著膠囊中心公轉，角度即 TDX 方位角（正北為 0）
            Image(systemName: "arrowtriangle.up.fill")
                .font(.system(size: 8))
                .foregroundStyle(tint)
                .offset(y: -19)
                .rotationEffect(.degrees(azimuth))

            VStack(spacing: 1) {
                Text(bus.routeName)
                    .font(Theme.routeNumber(13))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(tint, in: RoundedRectangle(cornerRadius: Theme.markerCorner))
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.markerCorner)
                            .strokeBorder(.white.opacity(0.85), lineWidth: 1.2)
                    )

                if let caption {
                    Text(caption)
                        .font(.system(size: 8, weight: .semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 4)
                        .padding(.vertical, 1)
                        .background(Color.black.opacity(0.55), in: Capsule())
                }
            }
        }
        .opacity(bus.freshness == .lost ? 0.45 : 1)
        .shadow(color: .black.opacity(0.3), radius: 3, y: 1)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
    }

    private var tint: Color {
        if bus.freshness == .lost { return Theme.busStale }
        if bus.busStatus.isAbnormal { return Theme.busAbnormal }
        return Theme.bus
    }

    /// 只在需要提醒時才佔用畫面——正常新鮮的車輛不加標籤，維持地圖簡潔。
    private var caption: String? {
        if bus.freshness == .lost { return "訊號中斷" }
        if let status = bus.busStatus.label { return status }
        if bus.freshness == .aging { return "\(bus.ageSec) 秒前" }
        return nil
    }

    private var accessibilityText: String {
        var parts = ["\(bus.routeName) 路公車", bus.direction.label]
        if let c = caption { parts.append(c) }
        return parts.joined(separator: "，")
    }
}

#Preview("公車標記", traits: .sizeThatFitsLayout) {
    let now = Date()
    return HStack(spacing: 28) {
        ForEach(MockBusAPI.buses(around: .init(latitude: 25.0465, longitude: 121.5175),
                                 serverTime: now).prefix(5), id: \.id) { bus in
            BusMarker(bus: bus)
        }
    }
    .padding(40)
}
