import SwiftUI

/// 視覺常數。集中管理讓地圖標記在淺色／深色底圖上都維持可讀性。
enum Theme {

    // MARK: - 語意色

    /// 公車標記主色。
    static let bus = Color(red: 0.13, green: 0.47, blue: 0.95)

    /// 車況異常（塞車／故障／事故）。
    static let busAbnormal = Color(red: 0.95, green: 0.55, blue: 0.10)

    /// 資料過期（> 90 秒）。
    static let busStale = Color(white: 0.55)

    /// 與官方預估不符——本 App 最重要的視覺訊號，優先級最高。
    static let conflict = Color(red: 0.92, green: 0.26, blue: 0.21)

    /// 一般回報標記。
    static let report = Color(red: 0.99, green: 0.75, blue: 0.18)

    static func crowd(_ level: CrowdLevel) -> Color {
        switch level {
        case .seat:   Color(red: 0.20, green: 0.72, blue: 0.45)
        case .stand:  Color(red: 0.98, green: 0.71, blue: 0.16)
        case .packed: Color(red: 0.90, green: 0.32, blue: 0.28)
        }
    }

    // MARK: - 尺寸

    static let markerCorner: CGFloat = 7
    static let pillHeight: CGFloat = 24
    static let cardCorner: CGFloat = 16

    // MARK: - 字體

    /// 路線號碼專用——rounded 讓數字在小尺寸下辨識度較高。
    static func routeNumber(_ size: CGFloat) -> Font {
        .system(size: size, weight: .bold, design: .rounded)
    }
}

/// 浮在地圖上的膠囊容器，深淺色皆維持對比。
struct FloatingCapsule<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(.regularMaterial, in: Capsule())
            .overlay(Capsule().strokeBorder(.white.opacity(0.12), lineWidth: 0.5))
            .shadow(color: .black.opacity(0.18), radius: 8, y: 2)
    }
}
