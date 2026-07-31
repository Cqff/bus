import { config } from './config.ts';
import type {
  TDXRealTimeByFrequency,
  TDXEstimatedTimeOfArrival,
} from './tdx/types.ts';

/** 對應 API_CONTRACT.md §2.1 `buses[]` */
export type LiveBusDTO = {
  plateNumb: string;
  routeUID: string;
  routeName: string;
  direction: 0 | 1;
  lat: number;
  lon: number;
  azimuth: number;
  speedKph: number | null;
  gpsTime: string;
  ageSec: number;
  stale: boolean;
  dutyStatus: number;
  busStatus: number;
};

/** 對應 API_CONTRACT.md §2.2 `etas[]` */
export type LiveETADTO = {
  stopUID: string;
  stationUID: string;
  routeUID: string;
  routeName: string;
  direction: 0 | 1;
  estimateSec: number | null;
  stopStatus: number;
  plateNumb: string | null;
  isLastBus: boolean;
  srcUpdateTime: string | null;
  ageSec: number;
};

/**
 * A1 → LiveBusDTO。
 *
 * `ageSec` 在此計算而非交給 App——裝置時鐘偏移會讓「N 秒前」亂跳。
 * 見 API_CONTRACT.md §2.1。
 *
 * 缺少必要欄位的紀錄一律丟棄，不讓半殘的資料進到 App。
 */
export function toLiveBus(
  raw: TDXRealTimeByFrequency,
  nowMs: number,
): LiveBusDTO | null {
  const plateNumb = raw.PlateNumb;
  const routeUID = raw.RouteUID;
  const gpsTime = raw.GPSTime;
  const lat = raw.BusPosition?.PositionLat;
  const lon = raw.BusPosition?.PositionLon;

  if (!plateNumb || !routeUID || !gpsTime) return null;
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  // 台北市範圍外的座標多半是車機異常，濾掉避免地圖出現離群點
  if (lat < 24.5 || lat > 25.5 || lon < 121.0 || lon > 122.2) return null;

  const gpsMs = new Date(gpsTime).getTime();
  if (!Number.isFinite(gpsMs)) return null;

  const ageSec = Math.max(0, Math.round((nowMs - gpsMs) / 1000));

  return {
    plateNumb,
    routeUID,
    routeName: raw.RouteName?.Zh_tw ?? raw.RouteID ?? routeUID,
    direction: raw.Direction === 1 ? 1 : 0,
    lat,
    lon,
    azimuth: typeof raw.Azimuth === 'number' ? raw.Azimuth : 0,
    speedKph: typeof raw.Speed === 'number' ? raw.Speed : null,
    gpsTime: new Date(gpsMs).toISOString(),
    ageSec,
    stale: ageSec > config.staleThresholdSec,
    dutyStatus: raw.DutyStatus ?? 0,
    busStatus: raw.BusStatus ?? 0,
  };
}

/**
 * N1 → LiveETADTO。
 *
 * `stationUID` 需由站牌靜態資料補上——N1 只給 StopUID。
 * 傳入 `stopToStation` 對照表（由 static 同步作業產生）。
 */
export function toLiveETA(
  raw: TDXEstimatedTimeOfArrival,
  nowMs: number,
  stopToStation: Map<string, string>,
): LiveETADTO | null {
  const stopUID = raw.StopUID;
  const routeUID = raw.RouteUID;
  if (!stopUID || !routeUID) return null;

  const srcUpdateTime = raw.SrcUpdateTime ?? raw.UpdateTime ?? null;
  const srcMs = srcUpdateTime ? new Date(srcUpdateTime).getTime() : NaN;
  const ageSec = Number.isFinite(srcMs)
    ? Math.max(0, Math.round((nowMs - srcMs) / 1000))
    : 0;

  return {
    stopUID,
    stationUID: stopToStation.get(stopUID) ?? stopUID,
    routeUID,
    routeName: raw.RouteName?.Zh_tw ?? raw.RouteID ?? routeUID,
    direction: raw.Direction === 1 ? 1 : 0,
    estimateSec:
      typeof raw.EstimateTime === 'number' ? raw.EstimateTime : null,
    stopStatus: raw.StopStatus ?? 0,
    plateNumb: raw.PlateNumb ?? null,
    isLastBus: raw.IsLastBus === true,
    srcUpdateTime: srcUpdateTime ? new Date(srcMs).toISOString() : null,
    ageSec,
  };
}
