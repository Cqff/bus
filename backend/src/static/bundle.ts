import { createHash } from 'node:crypto';
import { mergeStopsIntoStations, buildRouteLinks } from './merge.ts';
import type { StationDTO } from './merge.ts';
import { parseWKTLineString, encodePolyline } from './polyline.ts';
import type {
  TDXStop,
  TDXRoute,
  TDXStopOfRoute,
  TDXShape,
} from '../tdx/types.ts';

/** 對應 API_CONTRACT.md §3.3 */
export type RouteDTO = {
  routeUID: string;
  routeName: string;
  nameEn: string | null;
  departureStop: string;
  destinationStop: string;
  operatorIDs: string[];
  busRouteType: number | null;
};

/** 對應 API_CONTRACT.md §3.4 */
export type RouteStopsDTO = {
  routeUID: string;
  direction: 0 | 1;
  stops: Array<{
    stopUID: string;
    stationUID: string;
    sequence: number;
    lat: number;
    lon: number;
    name: string;
  }>;
};

/** 對應 API_CONTRACT.md §3.5 */
export type ShapeDTO = {
  routeUID: string;
  direction: 0 | 1;
  encodedPolyline: string;
};

/**
 * 精簡的站牌索引，給 Cloud Functions 驗證 150 公尺距離用。
 *
 * Functions **不自行解析 TDX 靜態資料**——那會需要第二份 TDX 金鑰、
 * 且合併邏輯會出現兩份實作而終將分歧。
 */
export type StopIndexEntry = {
  stopUID: string;
  stationUID: string;
  lat: number;
  lon: number;
  name: string;
};

export type StaticBundle = {
  version: string;
  builtAt: string;
  stations: StationDTO[];
  routes: RouteDTO[];
  routeStops: RouteStopsDTO[];
  shapes: ShapeDTO[];
  stopIndex: StopIndexEntry[];
};

export type RawStaticData = {
  stops: TDXStop[];
  routes: TDXRoute[];
  stopOfRoutes: TDXStopOfRoute[];
  shapes: TDXShape[];
};

/**
 * 由 TDX 原始資料建出整包靜態資料。
 *
 * 純函式——不碰網路也不碰檔案系統，因此可用固定樣本測試。
 */
export function buildBundle(raw: RawStaticData, builtAt: Date): StaticBundle {
  const routeLinks = buildRouteLinks(raw.stopOfRoutes);
  const stations = mergeStopsIntoStations(raw.stops, routeLinks);

  const stopToStation = new Map<string, string>();
  const stopMeta = new Map<string, { lat: number; lon: number; name: string }>();
  for (const station of stations) {
    for (const ref of station.stops) {
      stopToStation.set(ref.stopUID, station.stationUID);
    }
  }
  for (const stop of raw.stops) {
    if (!stop.StopUID) continue;
    const lat = stop.StopPosition?.PositionLat;
    const lon = stop.StopPosition?.PositionLon;
    const name = stop.StopName?.Zh_tw;
    if (typeof lat !== 'number' || typeof lon !== 'number' || !name) continue;
    stopMeta.set(stop.StopUID, { lat, lon, name });
  }

  const routes = raw.routes
    .filter((route) => route.RouteUID && route.RouteName?.Zh_tw)
    .map<RouteDTO>((route) => ({
      routeUID: route.RouteUID!,
      routeName: route.RouteName!.Zh_tw!,
      nameEn: route.RouteName?.En ?? null,
      departureStop: route.DepartureStopNameZh ?? '',
      destinationStop: route.DestinationStopNameZh ?? '',
      operatorIDs: (route.Operators ?? [])
        .map((op) => op.OperatorID)
        .filter((id): id is string => typeof id === 'string'),
      busRouteType: route.BusRouteType ?? null,
    }))
    .sort((a, b) => a.routeUID.localeCompare(b.routeUID));

  const routeStops = raw.stopOfRoutes
    .filter((sor) => sor.RouteUID)
    .map<RouteStopsDTO>((sor) => ({
      routeUID: sor.RouteUID!,
      direction: sor.Direction === 1 ? 1 : 0,
      stops: (sor.Stops ?? [])
        .filter((stop) => stop.StopUID)
        .map((stop) => {
          const meta = stopMeta.get(stop.StopUID!);
          return {
            stopUID: stop.StopUID!,
            stationUID: stopToStation.get(stop.StopUID!) ?? stop.StopUID!,
            sequence: stop.StopSequence ?? 0,
            lat: stop.StopPosition?.PositionLat ?? meta?.lat ?? 0,
            lon: stop.StopPosition?.PositionLon ?? meta?.lon ?? 0,
            name: stop.StopName?.Zh_tw ?? meta?.name ?? '',
          };
        })
        .sort((a, b) => a.sequence - b.sequence),
    }))
    // 同一路線可能由多家業者各提供一份 StopOfRoute，取站數最多的那份
    .reduce<RouteStopsDTO[]>((acc, current) => {
      const existing = acc.find(
        (r) => r.routeUID === current.routeUID && r.direction === current.direction,
      );
      if (!existing) {
        acc.push(current);
      } else if (current.stops.length > existing.stops.length) {
        acc[acc.indexOf(existing)] = current;
      }
      return acc;
    }, [])
    .sort(
      (a, b) => a.routeUID.localeCompare(b.routeUID) || a.direction - b.direction,
    );

  const shapes = raw.shapes
    .filter((shape) => shape.RouteUID)
    .map<ShapeDTO>((shape) => ({
      routeUID: shape.RouteUID!,
      direction: shape.Direction === 1 ? 1 : 0,
      encodedPolyline:
        shape.EncodedPolyline ??
        encodePolyline(parseWKTLineString(shape.Geometry ?? '')),
    }))
    .filter((shape) => shape.encodedPolyline.length > 0)
    .sort(
      (a, b) => a.routeUID.localeCompare(b.routeUID) || a.direction - b.direction,
    );

  const stopIndex = [...stopMeta.entries()]
    .map<StopIndexEntry>(([stopUID, meta]) => ({
      stopUID,
      stationUID: stopToStation.get(stopUID) ?? stopUID,
      lat: meta.lat,
      lon: meta.lon,
      name: meta.name,
    }))
    .sort((a, b) => a.stopUID.localeCompare(b.stopUID));

  return {
    // version 由內容雜湊而非時間戳決定——資料沒變時 App 就不必重新下載。
    // 用時間戳會讓使用者每天無謂地下載同一份 1–3MB 資料。
    version: hashContent(stations, routes, routeStops, shapes),
    builtAt: builtAt.toISOString(),
    stations,
    routes,
    routeStops,
    shapes,
    stopIndex,
  };
}

function hashContent(...parts: unknown[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(JSON.stringify(part));
  return hash.digest('hex').slice(0, 16);
}
