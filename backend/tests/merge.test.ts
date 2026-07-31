/**
 * 站牌合併的邊界測試。
 *
 * 這是 DESIGN.md §2.3 標為最高風險的邏輯，且**完全不需要網路或 TDX 金鑰**
 * 就能驗證——因此值得測得比其他部分更密。
 *
 * 執行：node --test tests/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeStopsIntoStations,
  buildRouteLinks,
  buildStopToStationMap,
  haversineM,
} from '../src/static/merge.ts';
import type { TDXStop, TDXStopOfRoute } from '../src/tdx/types.ts';

/** 台北車站基準座標 */
const BASE = { lat: 25.0465, lon: 121.5175 };

/** 依公尺位移產生座標。緯度 1 度 ≈ 111,320 公尺。 */
function offset(meters: { north?: number; east?: number }) {
  const north = meters.north ?? 0;
  const east = meters.east ?? 0;
  return {
    lat: BASE.lat + north / 111_320,
    lon: BASE.lon + east / (111_320 * Math.cos((BASE.lat * Math.PI) / 180)),
  };
}

function stop(
  stopUID: string,
  name: string,
  pos: { lat: number; lon: number },
  extra: Partial<TDXStop> = {},
): TDXStop {
  return {
    StopUID: stopUID,
    StopName: { Zh_tw: name, En: name },
    StopPosition: { PositionLat: pos.lat, PositionLon: pos.lon },
    ...extra,
  };
}

test('有 StationUID 時直接採用，不做距離分群', () => {
  const stations = mergeStopsIntoStations([
    stop('S1', '臺北車站', BASE, { StationUID: 'TPE9800' }),
    // 距離 800m，遠超過 50m 門檻，但 StationUID 相同就該合併
    stop('S2', '臺北車站', offset({ north: 800 }), { StationUID: 'TPE9800' }),
  ]);

  assert.equal(stations.length, 1);
  assert.equal(stations[0]!.stationUID, 'TPE9800');
  assert.equal(stations[0]!.stops.length, 2);
});

test('StationID + CityCode 是實際生效的分組依據', () => {
  // 實測（500 筆樣本）: 臺北市 Bus/Stop 的 StationUID 出現率 0%、
  // StationID 100%。這是實務上唯一會走到的規則 1 路徑。
  const stations = mergeStopsIntoStations([
    stop('S1', '臺北車站', BASE, { StationID: '9800', CityCode: 'TPE' }),
    stop('S2', '臺北車站', offset({ north: 800 }), { StationID: '9800', CityCode: 'TPE' }),
  ]);

  assert.equal(stations.length, 1, 'StationID 相同就該合併，不受距離影響');
  assert.equal(stations[0]!.stationUID, 'TPE9800', '應還原為慣例的 UID 格式');
  assert.equal(stations[0]!.stops.length, 2);
});

test('不同 StationID 不合併，即使同名且緊鄰', () => {
  const stations = mergeStopsIntoStations([
    stop('S1', '公園路', BASE, { StationID: '1001', CityCode: 'TPE' }),
    stop('S2', '公園路', offset({ east: 5 }), { StationID: '1002', CityCode: 'TPE' }),
  ]);

  // TDX 既然把它們分成兩個站位，就尊重官方分組，不要用距離覆寫
  assert.equal(stations.length, 2);
});

test('CityCode 前綴避免跨城市 StationID 碰撞', () => {
  // 為日後擴充雙北預留：兩市可能有相同的 StationID
  const stations = mergeStopsIntoStations([
    stop('S1', '中正路', BASE, { StationID: '500', CityCode: 'TPE' }),
    stop('S2', '中正路', offset({ north: 900 }), { StationID: '500', CityCode: 'NWT' }),
  ]);

  assert.equal(stations.length, 2);
  assert.deepEqual(
    stations.map((s) => s.stationUID).sort(),
    ['NWT500', 'TPE500'],
  );
});

test('缺 CityCode 時仍以 StationID 分組', () => {
  const stations = mergeStopsIntoStations([
    stop('S1', '測試站', BASE, { StationID: '777' }),
    stop('S2', '測試站', offset({ north: 400 }), { StationID: '777' }),
  ]);

  assert.equal(stations.length, 1);
  assert.equal(stations[0]!.stationUID, '777');
});

test('無任何官方分組時才退回距離分群', () => {
  const stations = mergeStopsIntoStations([
    stop('S1', '無編號站', BASE),
    stop('S2', '無編號站', offset({ east: 20 })),
  ]);

  assert.equal(stations.length, 1);
  assert.equal(stations[0]!.stationUID, 'SYN-S1', '合成 ID 才會出現 SYN- 前綴');
});

test('同名且 50m 內合併為一個站位', () => {
  const stations = mergeStopsIntoStations([
    stop('S1', '公園路', BASE),
    stop('S2', '公園路', offset({ east: 20 })),
    stop('S3', '公園路', offset({ east: 40 })),
  ]);

  assert.equal(stations.length, 1);
  assert.equal(stations[0]!.stops.length, 3);
});

test('同名但超過 50m 不合併', () => {
  const stations = mergeStopsIntoStations([
    stop('S1', '忠孝東路', BASE),
    stop('S2', '忠孝東路', offset({ east: 300 })),
  ]);

  assert.equal(stations.length, 2);
});

test('不同名即使重疊也不合併', () => {
  const stations = mergeStopsIntoStations([
    stop('S1', '北門', BASE),
    stop('S2', '西門', offset({ east: 5 })),
  ]);

  assert.equal(stations.length, 2);
});

test('沿路排列的同名站牌不會被鏈式串接', () => {
  // 每站相隔 40m（都在門檻內），single-linkage 會把 6 站串成一個橫跨 200m 的站位。
  // 貪婪分群應該切成多組。
  const stops = Array.from({ length: 6 }, (_, i) =>
    stop(`S${i}`, '忠孝東路', offset({ east: i * 40 })),
  );

  const stations = mergeStopsIntoStations(stops);

  assert.ok(stations.length > 1, `應切成多組，實際 ${stations.length} 組`);
  for (const station of stations) {
    for (const ref of station.stops) {
      const member = stops.find((s) => s.StopUID === ref.stopUID)!;
      const d = haversineM(
        station.lat,
        station.lon,
        member.StopPosition!.PositionLat!,
        member.StopPosition!.PositionLon!,
      );
      assert.ok(d <= 120, `成員距重心 ${d.toFixed(0)}m，群組過度擴散`);
    }
  }
});

test('stationUID 不因輸入順序而改變', () => {
  const stops = [
    stop('S3', '公園路', offset({ east: 30 })),
    stop('S1', '公園路', BASE),
    stop('S2', '公園路', offset({ east: 15 })),
  ];

  const a = mergeStopsIntoStations(stops);
  const b = mergeStopsIntoStations([...stops].reverse());

  assert.deepEqual(
    a.map((s) => s.stationUID),
    b.map((s) => s.stationUID),
  );
});

test('stationUID 不因群組新增成員而跳號', () => {
  // 每日同步的關鍵性質：TDX 多回傳一個站牌時，既有站位的 UID 必須維持不變，
  // 否則 App 快取與 BigQuery 歷史回報都會指向不存在的站位。
  const before = mergeStopsIntoStations([
    stop('S1', '公園路', BASE),
    stop('S2', '公園路', offset({ east: 20 })),
  ]);

  const after = mergeStopsIntoStations([
    stop('S1', '公園路', BASE),
    stop('S2', '公園路', offset({ east: 20 })),
    stop('S9', '公園路', offset({ east: 35 })),
  ]);

  assert.equal(before[0]!.stationUID, after[0]!.stationUID);
  assert.equal(before[0]!.stationUID, 'SYN-S1');
});

test('缺座標或缺站名的紀錄被丟棄', () => {
  const stations = mergeStopsIntoStations([
    stop('S1', '正常站', BASE),
    { StopUID: 'S2', StopName: { Zh_tw: '缺座標' } },
    { StopUID: 'S3', StopPosition: { PositionLat: 25, PositionLon: 121.5 } },
    { StopName: { Zh_tw: '缺 UID' }, StopPosition: { PositionLat: 25, PositionLon: 121.5 } },
  ]);

  assert.equal(stations.length, 1);
  assert.equal(stations[0]!.name, '正常站');
});

test('direction 來自 StopOfRoute 而非 Bus/Stop', () => {
  const stopOfRoutes: TDXStopOfRoute[] = [
    { RouteUID: 'TPE10132', Direction: 0, Stops: [{ StopUID: 'S1' }] },
    { RouteUID: 'TPE10132', Direction: 1, Stops: [{ StopUID: 'S2' }] },
  ];
  const links = buildRouteLinks(stopOfRoutes);

  const stations = mergeStopsIntoStations(
    [
      stop('S1', '臺北車站', BASE, { StationUID: 'TPE9800' }),
      stop('S2', '臺北車站', offset({ east: 10 }), { StationUID: 'TPE9800' }),
    ],
    links,
  );

  const refs = stations[0]!.stops;
  assert.equal(refs.find((r) => r.stopUID === 'S1')!.direction, 0);
  assert.equal(refs.find((r) => r.stopUID === 'S2')!.direction, 1);
});

test('同站牌屬多條路線時展開為多筆', () => {
  const links = buildRouteLinks([
    { RouteUID: 'R1', Direction: 0, Stops: [{ StopUID: 'S1' }] },
    { RouteUID: 'R2', Direction: 0, Stops: [{ StopUID: 'S1' }] },
    // 同一路線由兩家業者經營，會有重複的 StopOfRoute —— 應去重
    { RouteUID: 'R1', Direction: 0, Stops: [{ StopUID: 'S1' }] },
  ]);

  assert.equal(links.get('S1')!.length, 2);

  const stations = mergeStopsIntoStations([stop('S1', '測試站', BASE)], links);
  assert.equal(stations[0]!.stops.length, 2);
});

test('buildStopToStationMap 涵蓋所有成員站牌', () => {
  const stations = mergeStopsIntoStations([
    stop('S1', '臺北車站', BASE, { StationUID: 'TPE9800' }),
    stop('S2', '臺北車站', offset({ east: 10 }), { StationUID: 'TPE9800' }),
    stop('S3', '北門', offset({ north: 500 })),
  ]);

  const map = buildStopToStationMap(stations);

  assert.equal(map.get('S1'), 'TPE9800');
  assert.equal(map.get('S2'), 'TPE9800');
  assert.equal(map.get('S3'), 'SYN-S3');
  assert.equal(map.size, 3);
});

test('haversine 距離計算正確', () => {
  assert.equal(Math.round(haversineM(BASE.lat, BASE.lon, BASE.lat, BASE.lon)), 0);

  const d100 = haversineM(
    BASE.lat,
    BASE.lon,
    offset({ north: 100 }).lat,
    offset({ north: 100 }).lon,
  );
  assert.ok(Math.abs(d100 - 100) < 1, `預期約 100m，實際 ${d100.toFixed(1)}m`);

  const d150 = haversineM(
    BASE.lat,
    BASE.lon,
    offset({ east: 150 }).lat,
    offset({ east: 150 }).lon,
  );
  assert.ok(Math.abs(d150 - 150) < 1, `預期約 150m，實際 ${d150.toFixed(1)}m`);
});
