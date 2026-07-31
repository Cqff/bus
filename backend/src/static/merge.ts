import type { TDXStop, TDXStopOfRoute } from '../tdx/types.ts';

/** 對應 API_CONTRACT.md §3.2 `stations.json` */
export type StationDTO = {
  stationUID: string;
  name: string;
  nameEn: string | null;
  lat: number;
  lon: number;
  stops: StopRefDTO[];
};

export type StopRefDTO = {
  stopUID: string;
  routeUID: string;
  direction: 0 | 1;
  operatorID: string | null;
  bearing: string | null;
};

/** 站牌所屬的路線與方向。**只有 StopOfRoute 有這個資訊，Bus/Stop 沒有。** */
export type RouteLink = { routeUID: string; direction: 0 | 1 };

/** 同名站牌視為同一站位的距離上限（公尺）。 */
const MERGE_RADIUS_M = 50;

/**
 * 把 TDX 站牌合併為「站位」。
 *
 * TDX 文件明載：「同一站牌會因為分屬不同的客運業者而有不同的 StopID」，
 * 且去返程也是不同的 StopUID。若不合併，使用者會在地圖上看到同一個實體站牌
 * 疊了 6 個點，回報也會被拆散到各 StopUID 底下無法聚合。
 *
 * 這是 DESIGN.md §2.3 標為最高風險的項目——**整包關在後端**，App 只消費結果。
 * 出問題時只要改這裡重跑每日同步，不用改 App、不用重新送審。
 *
 * 合併規則（API_CONTRACT.md §3.2）：
 *   1. **以 `StationID` 分組**（實測 100% 提供）
 *   2. 無 StationID 者才以「站名完全相同 且 距離 < 50m」分群
 *   3. 合併後座標取成員站牌的重心
 *
 * ⚠️ **規則 1 原本寫成依賴 `StationUID`，那是錯的。**
 * 實測（2026-07-31，500 筆樣本）顯示 Bus/Stop **沒有 `StationUID`**（0%），
 * 只有 `StationID`（100%）。照原設計執行，規則 1 永遠不會觸發，
 * 全部站牌都會落到規則 2 的距離分群——等於用推測取代 TDX 的權威分組。
 *
 * 這類錯誤不會拋例外，只會靜默產生錯誤的合併結果，是最難察覺的一種。
 *
 * ⚠️ **stationUID 的穩定性**
 *
 * 靜態資料每日重新同步。若同一個實體站位每天產生不同的 stationUID，
 * App 的本機快取會對不上，BigQuery 裡的歷史回報也會指向不存在的站位。
 *
 * 因此合成 ID 採 `SYN-<群組內字典序最小的 StopUID>`，而非雜湊成員清單——
 * 後者只要 TDX 增減任一站牌就會整組跳號。此作法唯一會變動的情況是
 * 該錨點站牌本身自 TDX 消失，機率遠低於群組成員增減。
 *
 * @param stops      Bus/Stop 的站牌資料（提供名稱與座標）
 * @param routeLinks StopUID → 路線與方向。由 `buildRouteLinks()` 自 StopOfRoute 產生。
 *                   未提供時退回 Bus/Stop 自身的 RouteUID，且 direction 一律為 0。
 */
export function mergeStopsIntoStations(
  stops: TDXStop[],
  routeLinks?: Map<string, RouteLink[]>,
): StationDTO[] {
  const groups = new Map<string, TDXStop[]>();
  const needsClustering: TDXStop[] = [];

  for (const stop of stops) {
    if (!isUsable(stop)) continue;
    // 規則 1：採用 TDX 的權威站位分組
    const authoritative = authoritativeStationUID(stop);
    if (authoritative) push(groups, authoritative, stop);
    else needsClustering.push(stop);
  }

  // 規則 2：同名 + 50m 內
  for (const [, sameName] of groupByName(needsClustering)) {
    for (const cluster of clusterByDistance(sameName, MERGE_RADIUS_M)) {
      const uid = synthesizeUID(cluster);
      for (const stop of cluster) push(groups, uid, stop);
    }
  }

  return [...groups.entries()]
    .map(([stationUID, members]) => toStation(stationUID, members, routeLinks))
    .sort((a, b) => a.stationUID.localeCompare(b.stationUID));
}

/**
 * 自 StopOfRoute 建立 StopUID → 路線與方向的對照。
 *
 * 一個 StopUID 理論上只屬於一條路線的一個方向，但同一路線可能由多家業者
 * 經營而產生多份 StopOfRoute，因此值為陣列並去重。
 */
export function buildRouteLinks(
  stopOfRoutes: TDXStopOfRoute[],
): Map<string, RouteLink[]> {
  const links = new Map<string, RouteLink[]>();

  for (const sor of stopOfRoutes) {
    const routeUID = sor.RouteUID;
    if (!routeUID) continue;
    const direction: 0 | 1 = sor.Direction === 1 ? 1 : 0;

    for (const stop of sor.Stops ?? []) {
      const stopUID = stop.StopUID;
      if (!stopUID) continue;

      const existing = links.get(stopUID);
      if (!existing) {
        links.set(stopUID, [{ routeUID, direction }]);
      } else if (
        !existing.some((l) => l.routeUID === routeUID && l.direction === direction)
      ) {
        existing.push({ routeUID, direction });
      }
    }
  }

  return links;
}

/** StopUID → StationUID 對照表，供 N1 預估到站資料補上 stationUID。 */
export function buildStopToStationMap(stations: StationDTO[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const station of stations) {
    for (const stop of station.stops) {
      map.set(stop.stopUID, station.stationUID);
    }
  }
  return map;
}

// MARK: - 內部

function isUsable(stop: TDXStop): boolean {
  return (
    typeof stop.StopUID === 'string' &&
    typeof stop.StopName?.Zh_tw === 'string' &&
    typeof stop.StopPosition?.PositionLat === 'number' &&
    typeof stop.StopPosition?.PositionLon === 'number'
  );
}

function push(map: Map<string, TDXStop[]>, key: string, stop: TDXStop): void {
  const existing = map.get(key);
  if (existing) existing.push(stop);
  else map.set(key, [stop]);
}

function groupByName(stops: TDXStop[]): Map<string, TDXStop[]> {
  const byName = new Map<string, TDXStop[]>();
  for (const stop of stops) push(byName, stop.StopName!.Zh_tw!, stop);
  return byName;
}

/**
 * 貪婪分群：每個站牌歸入第一個重心在 50m 內的既有群組，否則自成一群。
 *
 * 刻意**不用** single-linkage——沿路排列的同名站牌會被鏈式串接成一整條，
 * 例如「忠孝東路」沿線數百公尺的站牌會被誤併為同一站位。
 *
 * 先依 StopUID 排序以保證每日同步結果一致。
 */
function clusterByDistance(stops: TDXStop[], radiusM: number): TDXStop[][] {
  const sorted = [...stops].sort((a, b) => a.StopUID!.localeCompare(b.StopUID!));
  const clusters: Array<{ members: TDXStop[]; lat: number; lon: number }> = [];

  for (const stop of sorted) {
    const lat = stop.StopPosition!.PositionLat!;
    const lon = stop.StopPosition!.PositionLon!;

    const target = clusters.find(
      (cluster) => haversineM(lat, lon, cluster.lat, cluster.lon) <= radiusM,
    );

    if (target) {
      target.members.push(stop);
      // 重心隨成員更新，避免群組因加入順序而漂移
      target.lat = mean(target.members.map((s) => s.StopPosition!.PositionLat!));
      target.lon = mean(target.members.map((s) => s.StopPosition!.PositionLon!));
    } else {
      clusters.push({ members: [stop], lat, lon });
    }
  }

  return clusters.map((cluster) => cluster.members);
}

/**
 * 取得 TDX 提供的權威站位識別碼。
 *
 * 優先序：
 *   1. `StationUID` —— 慣例格式（如 `TPE9800`），但臺北市實測不提供
 *   2. `CityCode + StationID` —— 還原成慣例格式。加上城市前綴是為了
 *      日後擴充雙北時 StationID 不會跨城市碰撞
 *
 * 回傳 null 表示此站牌沒有官方分組，需退回距離分群。
 */
function authoritativeStationUID(stop: TDXStop): string | null {
  if (stop.StationUID) return stop.StationUID;
  if (!stop.StationID) return null;
  // CityCode 實測 100% 提供（臺北市為 TPE）；缺漏時退回不帶前綴，
  // 單一城市下仍可正確分組
  const prefix = stop.CityCode ?? '';
  return `${prefix}${stop.StationID}`;
}

/** 以群組內字典序最小的 StopUID 為錨點——見本檔頂端關於穩定性的說明。 */
function synthesizeUID(cluster: TDXStop[]): string {
  const anchor = cluster
    .map((stop) => stop.StopUID!)
    .reduce((min, uid) => (uid < min ? uid : min));
  return `SYN-${anchor}`;
}

function toStation(
  stationUID: string,
  members: TDXStop[],
  routeLinks?: Map<string, RouteLink[]>,
): StationDTO {
  const first = members[0]!;
  const refs: StopRefDTO[] = [];

  for (const stop of members) {
    const stopUID = stop.StopUID!;
    const links = routeLinks?.get(stopUID);

    if (links && links.length > 0) {
      for (const link of links) {
        refs.push({
          stopUID,
          routeUID: link.routeUID,
          direction: link.direction,
          // Bus/Stop 實測不含 OperatorID —— 業者資訊只存在於 StopOfRoute
          // 的 Operators 陣列，若日後需要顯示須自那裡取
          operatorID: stop.OperatorID ?? null,
          bearing: stop.Bearing ?? null,
        });
      }
    } else {
      // 沒有 StopOfRoute 對照時退回 Bus/Stop 自身的 RouteUID。
      // direction 無從得知，一律填 0——App 端顯示方向會不正確，
      // 因此每日同步務必包含 StopOfRoute。
      refs.push({
        stopUID,
        routeUID: stop.RouteUID ?? '',
        direction: 0,
        operatorID: stop.OperatorID ?? null,
        bearing: stop.Bearing ?? null,
      });
    }
  }

  return {
    stationUID,
    name: first.StopName!.Zh_tw!,
    nameEn: first.StopName?.En ?? null,
    lat: round6(mean(members.map((s) => s.StopPosition!.PositionLat!))),
    lon: round6(mean(members.map((s) => s.StopPosition!.PositionLon!))),
    stops: refs.sort(
      (a, b) =>
        a.stopUID.localeCompare(b.stopUID) ||
        a.routeUID.localeCompare(b.routeUID) ||
        a.direction - b.direction,
    ),
  };
}

// MARK: - 幾何

export function haversineM(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
