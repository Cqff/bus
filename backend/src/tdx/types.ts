/**
 * TDX API 回應型別。
 *
 * ⚠️ 這些欄位名稱是依 TDX v2 慣例撰寫的，**尚未對實際回應驗證過**。
 * 取得金鑰後請先執行 `npm run probe`，它會把原始回應樣本寫入
 * `probe-output/raw-sample.json`，據此核對後再修正本檔。
 *
 * 所有欄位都標為 optional，讓欄位名稱有出入時解析不會直接爆炸——
 * 轉換層會把缺漏的資料濾掉而非拋錯。
 */

export type LocalizedName = {
  Zh_tw?: string;
  En?: string;
};

/** A1 公車動態定時資料 —— Bus/RealTimeByFrequency */
export type TDXRealTimeByFrequency = {
  PlateNumb?: string;
  OperatorID?: string;
  RouteUID?: string;
  RouteID?: string;
  RouteName?: LocalizedName;
  SubRouteUID?: string;
  Direction?: number;
  BusPosition?: {
    PositionLon?: number;
    PositionLat?: number;
    GeoHash?: string;
  };
  Speed?: number;
  Azimuth?: number;
  DutyStatus?: number;
  BusStatus?: number;
  MessageType?: number;
  GPSTime?: string;
  TransTime?: string;
  SrcRecTime?: string;
  SrcUpdateTime?: string;
  UpdateTime?: string;
};

/** N1 公車預估到站資料 —— Bus/EstimatedTimeOfArrival */
export type TDXEstimatedTimeOfArrival = {
  StopUID?: string;
  StopID?: string;
  StopName?: LocalizedName;
  RouteUID?: string;
  RouteID?: string;
  RouteName?: LocalizedName;
  SubRouteUID?: string;
  Direction?: number;
  EstimateTime?: number | null;
  StopSequence?: number;
  StopStatus?: number;
  NextBusTime?: string;
  IsLastBus?: boolean;
  PlateNumb?: string;
  SrcUpdateTime?: string;
  UpdateTime?: string;
};

/** 站牌靜態資料 —— Bus/Stop */
export type TDXStop = {
  StopUID?: string;
  StopID?: string;
  StopName?: LocalizedName;
  StopPosition?: {
    PositionLon?: number;
    PositionLat?: number;
    GeoHash?: string;
  };
  StopBearing?: string;
  StationID?: string;
  /** 部分縣市未提供，轉換層會退回「站名 + 50m」的群組規則 */
  StationUID?: string;
  RouteUID?: string;
  RouteID?: string;
  OperatorID?: string;
};

/** 路線靜態資料 —— Bus/Route */
export type TDXRoute = {
  RouteUID?: string;
  RouteID?: string;
  RouteName?: LocalizedName;
  DepartureStopNameZh?: string;
  DestinationStopNameZh?: string;
  DepartureStopNameEn?: string;
  DestinationStopNameEn?: string;
  Operators?: Array<{ OperatorID?: string; OperatorName?: LocalizedName }>;
  BusRouteType?: number;
  City?: string;
};

/** 路線站序 —— Bus/StopOfRoute */
export type TDXStopOfRoute = {
  RouteUID?: string;
  RouteID?: string;
  RouteName?: LocalizedName;
  Direction?: number;
  OperatorID?: string;
  Stops?: Array<{
    StopUID?: string;
    StopID?: string;
    StopName?: LocalizedName;
    StopBoarding?: number;
    StopSequence?: number;
    StopPosition?: {
      PositionLon?: number;
      PositionLat?: number;
    };
    StationID?: string;
    StationUID?: string;
  }>;
};

/** 路線線型 —— Bus/Shape */
export type TDXShape = {
  RouteUID?: string;
  RouteID?: string;
  Direction?: number;
  /** WKT 格式的 LINESTRING，需轉為 encoded polyline */
  Geometry?: string;
  EncodedPolyline?: string;
};
