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

/**
 * N1 公車預估到站資料 —— Bus/EstimatedTimeOfArrival
 *
 * ✅ 已對實際回應核對（2026-07-31）。實測欄位：
 * `StopUID, StopID, StopName, RouteUID, RouteID, RouteName, Direction,
 *  EstimateTime, StopStatus, SrcUpdateTime, UpdateTime`
 *
 * ⚠️ **實測樣本不含 `PlateNumb`、`IsLastBus`、`StopSequence`。**
 * 這代表 App 的站位詳情無法顯示「哪一台車」，且末班車標示不可用。
 * 這些欄位仍保留為 optional（部分業者或部分時段可能提供），
 * 但 UI 不應假設它們存在。
 */
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

/**
 * 站牌靜態資料 —— Bus/Stop
 *
 * ✅ 已對實際回應核對（2026-07-31，500 筆樣本）。**完整**欄位清單為 13 個：
 * `StopUID, StopID, AuthorityID, StopName, StopPosition, StopAddress,
 *  Bearing, StationID, City, CityCode, LocationCityCode, UpdateTime, VersionID`
 *
 * 三項實測結果與原假設不符，每一項都會造成靜默失效（不報錯，只是資料錯）：
 *
 * | 原假設 | 實際 | 後果 |
 * |---|---|---|
 * | `StopBearing` | `Bearing` | bearing 永遠 null |
 * | 有 `StationUID` | **0%，只有 `StationID`（100%）** | 合併規則 1 永不觸發 |
 * | 有 `OperatorID` | **不存在** | operatorID 永遠 null |
 * | 有 `RouteUID` | 不存在 | 路線與方向只能自 StopOfRoute 取得 |
 */
export type TDXStop = {
  StopUID?: string;
  StopID?: string;
  StopName?: LocalizedName;
  StopPosition?: {
    PositionLon?: number;
    PositionLat?: number;
    GeoHash?: string;
  };
  StopAddress?: string;
  /** 實測 100%。原先誤寫為 `StopBearing`。 */
  Bearing?: string;
  /**
   * 實測 100%。**這是站位分組的權威來源**——
   * TDX 用它標示同一實體站位下的多個站牌（不同業者、不同方向）。
   */
  StationID?: string;
  /** 實測出現率 **0%**。保留僅為向前相容，實務上不可依賴。 */
  StationUID?: string;
  AuthorityID?: string;
  City?: string;
  /** 實測 100%。臺北市為 `TPE`，用於還原慣例上的 StationUID 格式。 */
  CityCode?: string;
  LocationCityCode?: string;
  UpdateTime?: string;
  VersionID?: number;
  /** Bus/Stop 實測**不含**下列欄位，保留僅為容錯 */
  OperatorID?: string;
  RouteUID?: string;
  RouteID?: string;
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
