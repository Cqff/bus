import SwiftUI
import MapKit

/// 主畫面。
///
/// 顯示策略見 DESIGN.md §5.2：
/// - 預設（未選路線、視野 ≤ 3km）：顯示附近所有路線公車，上限 60 台
/// - 視野 > 3km：隱藏公車，只留有回報的站位標記（同時解決效能與畫面雜亂）
/// - 已選路線：只顯示該路線的公車、站牌與路線線型
struct MapScreen: View {

    /// 公車顯示的視野上限（緯度度數）。約 3 公里。
    private static let busVisibilityMaxSpan = 0.027

    private let api: BusAPI

    @State private var store: LiveBusStore
    @State private var location = LocationService()
    @State private var myReports = MyReportsStore()

    @State private var bundle: StaticBundle?
    @State private var aggregates: [String: StationAggregate] = [:]
    @State private var camera: MapCameraPosition = .region(.taipeiDefault)
    @State private var bbox: BBox?

    @State private var selectedRoute: BusRoute?
    @State private var selectedDirection: Direction = .outbound
    @State private var selectedStation: Station?
    @State private var showRouteSearch = false
    @State private var showMyReports = false

    @Environment(\.scenePhase) private var scenePhase

    init(api: BusAPI = MockBusAPI()) {
        self.api = api
        _store = State(initialValue: LiveBusStore(api: api))
    }

    var body: some View {
        Map(position: $camera) {
            UserAnnotation()

            if let line = routeLine, line.coordinates.count > 1 {
                MapPolyline(coordinates: line.coordinates)
                    .stroke(Theme.bus.opacity(line.isApproximate ? 0.45 : 0.7),
                            style: line.isApproximate
                                ? StrokeStyle(lineWidth: 3, lineCap: .round,
                                              lineJoin: .round, dash: [2, 7])
                                : StrokeStyle(lineWidth: 4, lineCap: .round, lineJoin: .round))
            }

            ForEach(visibleStations) { station in
                Annotation("", coordinate: station.coordinate, anchor: .center) {
                    StationMarker(station: station,
                                  aggregate: aggregates[station.stationUID],
                                  isSelected: selectedStation?.stationUID == station.stationUID)
                        .onTapGesture { selectedStation = station }
                }
            }

            if showsBuses {
                ForEach(store.buses) { bus in
                    Annotation("", coordinate: bus.coordinate, anchor: .center) {
                        BusMarker(bus: bus)
                    }
                }
            }
        }
        .mapControls {
            MapUserLocationButton()
            MapCompass()
        }
        .onMapCameraChange(frequency: .onEnd) { context in
            // .onEnd 本身就是 API_CONTRACT 要求的 debounce——平移中不觸發請求
            bbox = BBox(region: context.region)
            syncStoreMode()
        }
        .overlay(alignment: .top) { topBar }
        .overlay(alignment: .bottom) { bottomHint }
        .sheet(isPresented: $showRouteSearch) {
            RouteSearchSheet(routes: bundle?.routes ?? []) { route in
                select(route: route)
            }
        }
        .sheet(item: $selectedStation) { station in
            StationDetailSheet(station: station, api: api, location: location)
        }
        .sheet(isPresented: $showMyReports) {
            MyReportsSheet(api: api)
        }
        .environment(myReports)
        .task { await bootstrap() }
        .onChange(of: scenePhase) { _, phase in
            // 進背景立即停止輪詢；回前景立即補一次
            phase == .active ? store.resume() : store.suspend()
        }
        .onChange(of: selectedDirection) { _, _ in syncStoreMode() }
    }

    // MARK: - Overlays

    private var topBar: some View {
        VStack(spacing: 8) {
            LiveStatusBar(busCount: showsBuses ? store.buses.count : 0,
                          lastUpdated: store.lastUpdated,
                          oldestAgeSec: store.buses.map(\.ageSec).max(),
                          isRefreshing: store.isRefreshing,
                          degradedMessage: store.degradedMessage)

            HStack(spacing: 8) {
                if let route = selectedRoute {
                    selectedRouteChip(route)
                } else {
                    searchChip
                }

                if myReports.hasReports {
                    myReportsButton
                }
            }
        }
        .padding(.top, 6)
        .padding(.horizontal, 12)
    }

    /// 只在使用者實際送出過回報後才出現——沒有紀錄時這個入口沒有意義，
    /// 藏起來可維持預設畫面的簡潔。
    private var myReportsButton: some View {
        Button {
            showMyReports = true
        } label: {
            FloatingCapsule {
                Image(systemName: "list.bullet.rectangle")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.primary)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("我的回報")
    }

    private var searchChip: some View {
        Button {
            showRouteSearch = true
        } label: {
            FloatingCapsule {
                HStack(spacing: 7) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 13, weight: .semibold))
                    Text("搜尋路線號碼")
                        .font(.system(size: 14, weight: .medium))
                }
                .foregroundStyle(.primary)
            }
        }
        .buttonStyle(.plain)
    }

    private func selectedRouteChip(_ route: BusRoute) -> some View {
        FloatingCapsule {
            HStack(spacing: 10) {
                Text(route.routeName)
                    .font(Theme.routeNumber(15))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(Theme.bus, in: RoundedRectangle(cornerRadius: 6))

                Button {
                    selectedDirection = selectedDirection == .outbound ? .inbound : .outbound
                } label: {
                    HStack(spacing: 4) {
                        Text(directionDestination(route))
                            .font(.system(size: 13, weight: .medium))
                            .lineLimit(1)
                        Image(systemName: "arrow.left.arrow.right")
                            .font(.system(size: 10, weight: .bold))
                    }
                    .foregroundStyle(.primary)
                }
                .buttonStyle(.plain)

                Button {
                    clearRouteSelection()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 15))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }
        }
    }

    @ViewBuilder
    private var bottomHint: some View {
        if selectedRoute == nil && !showsBuses {
            hintCapsule("放大地圖以顯示公車", systemImage: "plus.magnifyingglass")
        } else if store.truncated {
            hintCapsule("車輛較多，放大以查看更多", systemImage: "eye.slash")
        } else if let message = store.errorMessage {
            hintCapsule(message, systemImage: "wifi.exclamationmark")
        }
    }

    private func hintCapsule(_ text: String, systemImage: String) -> some View {
        FloatingCapsule {
            HStack(spacing: 6) {
                Image(systemName: systemImage).font(.system(size: 12))
                Text(text).font(.system(size: 13, weight: .medium))
            }
            .foregroundStyle(.secondary)
        }
        .padding(.bottom, 28)
    }

    // MARK: - Derived state

    private var showsBuses: Bool {
        if selectedRoute != nil { return true }
        guard let bbox else { return false }
        return bbox.latSpan <= Self.busVisibilityMaxSpan
    }

    private var visibleStations: [Station] {
        guard let bundle else { return [] }

        if let route = selectedRoute {
            let ids = Set(bundle.routeStops(routeUID: route.routeUID,
                                            direction: selectedDirection)?
                                .stops.map(\.stationUID) ?? [])
            return bundle.stations.filter { ids.contains($0.stationUID) }
        }

        guard let bbox else { return [] }
        let inView = bundle.stations.filter {
            $0.lat >= bbox.minLat && $0.lat <= bbox.maxLat &&
            $0.lon >= bbox.minLon && $0.lon <= bbox.maxLon
        }
        // 視野拉遠時只保留有回報的站位，避免整張圖被灰點淹沒
        guard bbox.latSpan > Self.busVisibilityMaxSpan else { return inView }
        return inView.filter { aggregates[$0.stationUID]?.hasReports == true }
    }

    /// 路線線型。`isApproximate` 表示後端沒給線型、改以站點直線相連，
    /// 由呼叫端畫成虛線——示意線長得像實際路徑會誤導使用者。
    private var routeLine: (coordinates: [CLLocationCoordinate2D], isApproximate: Bool)? {
        guard let bundle, let route = selectedRoute else { return nil }
        if let shape = bundle.shape(routeUID: route.routeUID, direction: selectedDirection) {
            return (Polyline.decode(shape.encodedPolyline), false)
        }
        // 無線型資料時以站點連線示意。
        // 務必依 sequence 排序：API_CONTRACT 沒有保證 stops[] 的陣列順序等於站序，
        // 直接照陣列順序連線會讓路線在地圖上對角亂穿。
        guard let stops = bundle.routeStops(routeUID: route.routeUID,
                                            direction: selectedDirection)?.stops else { return nil }
        return (stops.sorted { $0.sequence < $1.sequence }.map(\.coordinate), true)
    }

    private func directionDestination(_ route: BusRoute) -> String {
        selectedDirection == .outbound
            ? "往 \(route.destinationStop)"
            : "往 \(route.departureStop)"
    }

    // MARK: - Actions

    private func bootstrap() async {
        location.requestAuthorization()
        do {
            let loaded = try await api.staticBundle()
            bundle = loaded
            if bbox == nil { bbox = BBox(region: .taipeiDefault) }
            let list = try await api.aggregates(bbox: bbox ?? BBox(region: .taipeiDefault))
            aggregates = Dictionary(uniqueKeysWithValues: list.map { ($0.stationUID, $0) })
            syncStoreMode()
        } catch {
            // 靜態資料載入失敗時地圖仍可顯示底圖，避免整個畫面不可用
            store.setMode(.viewport(bbox ?? BBox(region: .taipeiDefault)))
        }
    }

    private func select(route: BusRoute) {
        selectedRoute = route
        selectedDirection = .outbound
        showRouteSearch = false
        zoomToRoute(route)
        syncStoreMode()
    }

    private func clearRouteSelection() {
        selectedRoute = nil
        syncStoreMode()
    }

    private func zoomToRoute(_ route: BusRoute) {
        guard let stops = bundle?.routeStops(routeUID: route.routeUID,
                                             direction: selectedDirection)?.stops,
              !stops.isEmpty else { return }
        let lats = stops.map(\.lat)
        let lons = stops.map(\.lon)
        let center = CLLocationCoordinate2D(
            latitude:  (lats.min()! + lats.max()!) / 2,
            longitude: (lons.min()! + lons.max()!) / 2
        )
        let span = MKCoordinateSpan(
            latitudeDelta:  max((lats.max()! - lats.min()!) * 1.35, 0.01),
            longitudeDelta: max((lons.max()! - lons.min()!) * 1.35, 0.01)
        )
        withAnimation(.easeInOut(duration: 0.4)) {
            camera = .region(MKCoordinateRegion(center: center, span: span))
        }
    }

    private func syncStoreMode() {
        if let route = selectedRoute {
            store.setMode(.route(routeUID: route.routeUID, direction: selectedDirection))
        } else if let bbox, showsBuses {
            store.setMode(.viewport(bbox))
        } else {
            // 視野太遠時停止輪詢——省電且省流量
            store.suspend()
        }
    }
}

extension MKCoordinateRegion {
    /// 台北車站周邊，約 2 公里視野。
    static let taipeiDefault = MKCoordinateRegion(
        center: CLLocationCoordinate2D(latitude: 25.0465, longitude: 121.5175),
        span: MKCoordinateSpan(latitudeDelta: 0.018, longitudeDelta: 0.018)
    )
}

#Preview("地圖") {
    MapScreen()
}
