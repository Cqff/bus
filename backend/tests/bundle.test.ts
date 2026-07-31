import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBundle } from '../src/static/bundle.ts';
import type { RawStaticData } from '../src/static/bundle.ts';
import {
  parseWKTLineString,
  encodePolyline,
  decodePolyline,
} from '../src/static/polyline.ts';

const BUILT_AT = new Date('2026-07-31T04:00:00Z');

function raw(overrides: Partial<RawStaticData> = {}): RawStaticData {
  return {
    stops: [
      {
        StopUID: 'TPE50629',
        StopName: { Zh_tw: '臺北車站', En: 'Taipei Main Station' },
        StopPosition: { PositionLat: 25.0465, PositionLon: 121.5175 },
        StationUID: 'TPE9800',
        OperatorID: '10012',
      },
      {
        StopUID: 'TPE50630',
        StopName: { Zh_tw: '臺北車站', En: 'Taipei Main Station' },
        StopPosition: { PositionLat: 25.0466, PositionLon: 121.5176 },
        StationUID: 'TPE9800',
        OperatorID: '10012',
      },
      {
        StopUID: 'TPE50711',
        StopName: { Zh_tw: '公園路' },
        StopPosition: { PositionLat: 25.0431, PositionLon: 121.5171 },
      },
    ],
    routes: [
      {
        RouteUID: 'TPE10132',
        RouteName: { Zh_tw: '270', En: '270' },
        DepartureStopNameZh: '捷運景安站',
        DestinationStopNameZh: '松山車站',
        Operators: [{ OperatorID: '10012' }],
        BusRouteType: 11,
      },
    ],
    stopOfRoutes: [
      {
        RouteUID: 'TPE10132',
        Direction: 0,
        Stops: [
          {
            StopUID: 'TPE50629',
            StopName: { Zh_tw: '臺北車站' },
            StopSequence: 1,
            StopPosition: { PositionLat: 25.0465, PositionLon: 121.5175 },
          },
          {
            StopUID: 'TPE50711',
            StopName: { Zh_tw: '公園路' },
            StopSequence: 2,
            StopPosition: { PositionLat: 25.0431, PositionLon: 121.5171 },
          },
        ],
      },
      {
        RouteUID: 'TPE10132',
        Direction: 1,
        Stops: [
          {
            StopUID: 'TPE50630',
            StopName: { Zh_tw: '臺北車站' },
            StopSequence: 1,
            StopPosition: { PositionLat: 25.0466, PositionLon: 121.5176 },
          },
        ],
      },
    ],
    shapes: [
      {
        RouteUID: 'TPE10132',
        Direction: 0,
        Geometry: 'LINESTRING (121.5175 25.0465, 121.5171 25.0431)',
      },
    ],
    ...overrides,
  };
}

test('version 由內容雜湊決定，相同輸入產生相同版本', () => {
  const a = buildBundle(raw(), BUILT_AT);
  const b = buildBundle(raw(), new Date('2026-08-01T04:00:00Z'));

  // 換一天重建但資料沒變 → 版本必須相同，否則使用者每天無謂下載 1-3MB
  assert.equal(a.version, b.version);
  assert.notEqual(a.builtAt, b.builtAt);
});

test('資料變動時 version 隨之改變', () => {
  const before = buildBundle(raw(), BUILT_AT);
  const after = buildBundle(
    raw({
      routes: [
        {
          RouteUID: 'TPE10132',
          RouteName: { Zh_tw: '270' },
          DepartureStopNameZh: '捷運景安站',
          DestinationStopNameZh: '南港車站',
          Operators: [],
        },
      ],
    }),
    BUILT_AT,
  );

  assert.notEqual(before.version, after.version);
});

test('stopIndex 涵蓋所有站牌並帶有 stationUID', () => {
  const bundle = buildBundle(raw(), BUILT_AT);

  assert.equal(bundle.stopIndex.length, 3);

  const taipei = bundle.stopIndex.find((s) => s.stopUID === 'TPE50629')!;
  assert.equal(taipei.stationUID, 'TPE9800');
  assert.equal(taipei.name, '臺北車站');

  const park = bundle.stopIndex.find((s) => s.stopUID === 'TPE50711')!;
  assert.equal(park.stationUID, 'SYN-TPE50711');
});

test('routeStops 帶入 stationUID 並依站序排列', () => {
  const bundle = buildBundle(raw(), BUILT_AT);
  const outbound = bundle.routeStops.find(
    (r) => r.routeUID === 'TPE10132' && r.direction === 0,
  )!;

  assert.equal(outbound.stops.length, 2);
  assert.equal(outbound.stops[0]!.sequence, 1);
  assert.equal(outbound.stops[0]!.stationUID, 'TPE9800');
  assert.equal(outbound.stops[1]!.stationUID, 'SYN-TPE50711');
});

test('同路線多份 StopOfRoute 取站數最多者', () => {
  const bundle = buildBundle(
    raw({
      stopOfRoutes: [
        {
          RouteUID: 'TPE10132',
          Direction: 0,
          OperatorID: '10012',
          Stops: [{ StopUID: 'TPE50629', StopSequence: 1 }],
        },
        {
          // 另一家業者提供了完整站序
          RouteUID: 'TPE10132',
          Direction: 0,
          OperatorID: '10015',
          Stops: [
            { StopUID: 'TPE50629', StopSequence: 1 },
            { StopUID: 'TPE50711', StopSequence: 2 },
          ],
        },
      ],
    }),
    BUILT_AT,
  );

  const outbound = bundle.routeStops.filter((r) => r.routeUID === 'TPE10132');
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0]!.stops.length, 2);
});

test('WKT 線型轉為 encoded polyline', () => {
  const bundle = buildBundle(raw(), BUILT_AT);
  const shape = bundle.shapes[0]!;

  assert.ok(shape.encodedPolyline.length > 0);

  const decoded = decodePolyline(shape.encodedPolyline);
  assert.equal(decoded.length, 2);
  assert.ok(Math.abs(decoded[0]!.lat - 25.0465) < 1e-5);
  assert.ok(Math.abs(decoded[0]!.lon - 121.5175) < 1e-5);
});

test('無效線型被丟棄而非產生空 polyline', () => {
  const bundle = buildBundle(
    raw({ shapes: [{ RouteUID: 'TPE10132', Direction: 0, Geometry: 'GARBAGE' }] }),
    BUILT_AT,
  );
  assert.equal(bundle.shapes.length, 0);
});

test('缺必要欄位的路線被丟棄', () => {
  const bundle = buildBundle(
    raw({ routes: [{ RouteID: '270' }, { RouteUID: 'X', RouteName: {} }] }),
    BUILT_AT,
  );
  assert.equal(bundle.routes.length, 0);
});

// MARK: - polyline 單元

test('WKT 解析採「經度在前、緯度在後」', () => {
  // 寫反會讓所有路線出現在地球另一側，這是最容易犯又最難察覺的錯
  const points = parseWKTLineString('LINESTRING (121.5175 25.0465)');
  assert.equal(points[0]!.lon, 121.5175);
  assert.equal(points[0]!.lat, 25.0465);
});

test('polyline 編碼解碼往返一致', () => {
  const original = [
    { lat: 25.0465, lon: 121.5175 },
    { lat: 25.0431, lon: 121.5171 },
    { lat: 25.0389, lon: 121.5203 },
  ];
  const decoded = decodePolyline(encodePolyline(original));

  assert.equal(decoded.length, original.length);
  for (let i = 0; i < original.length; i++) {
    assert.ok(Math.abs(decoded[i]!.lat - original[i]!.lat) < 1e-5);
    assert.ok(Math.abs(decoded[i]!.lon - original[i]!.lon) < 1e-5);
  }
});

test('polyline 對長路線有實質壓縮效果', () => {
  const points = Array.from({ length: 500 }, (_, i) => ({
    lat: 25.0465 + i * 0.0001,
    lon: 121.5175 + i * 0.0001,
  }));
  const encoded = encodePolyline(points);
  const rawJson = JSON.stringify(points);

  assert.ok(
    encoded.length < rawJson.length / 4,
    `壓縮不足：${encoded.length} vs ${rawJson.length}`,
  );
});

test('空輸入不產生垃圾', () => {
  assert.equal(encodePolyline([]), '');
  assert.deepEqual(parseWKTLineString(''), []);
  assert.deepEqual(decodePolyline(''), []);
});
