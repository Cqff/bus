import Foundation
import CoreLocation
import Observation

/// 定位服務。**只申請 When In Use**——MVP 無背景功能，
/// 申請 Always 會提高審核風險與使用者疑慮。見 DESIGN.md §5.4。
@Observable
@MainActor
final class LocationService: NSObject, CLLocationManagerDelegate {

    private(set) var authorizationStatus: CLAuthorizationStatus
    private(set) var currentLocation: CLLocation?

    /// 送出回報時的精度門檻。伺服器會以 `locationAccuracyM > 100` 拒絕，
    /// 這裡先擋一次以免浪費往返。
    static let requiredAccuracyM: Double = 100

    /// 站牌距離上限，與伺服器端一致。見 REQUIREMENTS.md §4.4。
    static let reportRadiusM: Double = 150

    private let manager = CLLocationManager()

    override init() {
        authorizationStatus = manager.authorizationStatus
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
        manager.distanceFilter = 10
    }

    var isAuthorized: Bool {
        authorizationStatus == .authorizedWhenInUse || authorizationStatus == .authorizedAlways
    }

    var hasUsableAccuracy: Bool {
        guard let loc = currentLocation else { return false }
        return loc.horizontalAccuracy > 0 && loc.horizontalAccuracy <= Self.requiredAccuracyM
    }

    func requestAuthorization() {
        manager.requestWhenInUseAuthorization()
    }

    func startUpdating() {
        guard isAuthorized else { return }
        manager.startUpdatingLocation()
    }

    func stopUpdating() {
        manager.stopUpdatingLocation()
    }

    /// 使用者與站位的距離（公尺）。nil 表示尚無定位。
    func distance(to station: Station) -> Double? {
        guard let loc = currentLocation else { return nil }
        return CLLocation(latitude: station.lat, longitude: station.lon).distance(from: loc)
    }

    /// 是否可對該站位送出回報。伺服器仍會再驗一次——這裡只是提前給使用者回饋。
    func canReport(at station: Station) -> Bool {
        guard let d = distance(to: station), hasUsableAccuracy else { return false }
        return d <= Self.reportRadiusM
    }

    // MARK: - CLLocationManagerDelegate

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            self.authorizationStatus = status
            if self.isAuthorized { self.startUpdating() }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let latest = locations.last else { return }
        Task { @MainActor in
            self.currentLocation = latest
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // 定位失敗不阻斷地圖瀏覽，僅影響回報功能的可用性。
    }
}
