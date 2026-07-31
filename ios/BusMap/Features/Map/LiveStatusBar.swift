import SwiftUI

/// 地圖頂端的即時狀態列：目前時間、連線狀態、在線車輛數、資料新鮮度。
///
/// 「資料新鮮度」是這個 App 的誠實承諾——TDX 有分鐘級延遲，
/// 與其假裝即時，不如讓使用者一眼看出資料多舊。
struct LiveStatusBar: View {
    let busCount: Int
    let lastUpdated: Date?
    let oldestAgeSec: Int?
    let isRefreshing: Bool
    let degradedMessage: String?

    var body: some View {
        VStack(spacing: 6) {
            FloatingCapsule {
                HStack(spacing: 10) {
                    Text(Date(), style: .time)
                        .font(.system(size: 15, weight: .semibold, design: .rounded))
                        .monospacedDigit()

                    HStack(spacing: 4) {
                        Circle()
                            .fill(indicatorColor)
                            .frame(width: 7, height: 7)
                            .opacity(isRefreshing ? 0.35 : 1)
                            .animation(.easeInOut(duration: 0.4), value: isRefreshing)
                        Text(indicatorLabel)
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(indicatorColor)
                    }

                    Divider().frame(height: 12)

                    Text("\(busCount) 班行駛中")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
            }

            if let degradedMessage {
                Text(degradedMessage)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(Theme.busAbnormal, in: Capsule())
                    .shadow(color: .black.opacity(0.2), radius: 5, y: 2)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.25), value: degradedMessage)
    }

    private var indicatorColor: Color {
        if degradedMessage != nil { return Theme.busAbnormal }
        guard let age = oldestAgeSec else { return .secondary }
        return age > 90 ? Theme.busStale : .green
    }

    private var indicatorLabel: String {
        if degradedMessage != nil { return "資料中斷" }
        guard lastUpdated != nil else { return "連線中" }
        guard let age = oldestAgeSec else { return "LIVE" }
        // 最舊一筆都在 30 秒內才敢說 LIVE
        return age <= 30 ? "LIVE" : "\(age) 秒前"
    }
}

#Preview("狀態列", traits: .sizeThatFitsLayout) {
    VStack(spacing: 16) {
        LiveStatusBar(busCount: 10, lastUpdated: Date(), oldestAgeSec: 14,
                      isRefreshing: false, degradedMessage: nil)
        LiveStatusBar(busCount: 10, lastUpdated: Date(), oldestAgeSec: 62,
                      isRefreshing: true, degradedMessage: nil)
        LiveStatusBar(busCount: 8, lastUpdated: Date(), oldestAgeSec: 240,
                      isRefreshing: false,
                      degradedMessage: "⚠️ 官方資料來源中斷，顯示 4 分鐘前資料")
    }
    .padding(30)
    .background(Color.gray.opacity(0.25))
}
