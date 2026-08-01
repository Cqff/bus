/**
 * 內容協商與靜態資料打包的測試。
 *
 * 這兩件事湊在一起，是因為它們共同決定「App 拿到的位元組是什麼、以及能不能驗得過」：
 * `acceptsGzip` 決定回傳的是壓縮還是未壓縮，`compressAll` 決定 manifest 上那組
 * sha256／bytes／gzipBytes 各自描述哪一份內容。兩邊對不上，App 的完整性驗證就會全掛。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { StaticBundle } from '../src/static/bundle.ts';

// http.ts 與 staticStore.ts 都會（間接）載入 config.ts，而後者在缺少 TDX 金鑰時
// 於**模組載入當下**就 throw。靜態 import 會先於檔案本體求值，所以這裡必須先塞假值
// 再動態載入——單元測試不該需要一把真金鑰。
process.env.TDX_CLIENT_ID ??= 'test-id';
process.env.TDX_CLIENT_SECRET ??= 'test-secret';
const { acceptsGzip } = await import('../src/http.ts');
const { compressAll } = await import('../src/static/staticStore.ts');

// MARK: - Accept-Encoding

test('缺少 Accept-Encoding 時視為接受 gzip（RFC 9110 §12.5.3）', () => {
  assert.equal(acceptsGzip(undefined), true);
});

test('iOS URLSession 實際送出的標頭接受 gzip', () => {
  assert.equal(acceptsGzip('gzip, deflate, br'), true);
});

test('空字串代表只接受 identity', () => {
  assert.equal(acceptsGzip(''), false);
});

test('只列 identity 時不得回 gzip', () => {
  assert.equal(acceptsGzip('identity'), false);
});

test('gzip;q=0 是明確拒絕', () => {
  assert.equal(acceptsGzip('gzip;q=0'), false);
  assert.equal(acceptsGzip('gzip;q=0.0'), false);
});

test('gzip 帶正 q 值仍接受', () => {
  assert.equal(acceptsGzip('gzip;q=0.5'), true);
  assert.equal(acceptsGzip('deflate;q=1.0, gzip;q=0.5'), true);
});

test('萬用字元涵蓋 gzip', () => {
  assert.equal(acceptsGzip('*'), true);
  assert.equal(acceptsGzip('deflate, *'), true);
});

test('萬用字元 q=0 代表全部拒絕', () => {
  assert.equal(acceptsGzip('*;q=0'), false);
});

test('明列的 gzip 優先於萬用字元', () => {
  assert.equal(acceptsGzip('gzip;q=0, *'), false);
  assert.equal(acceptsGzip('*;q=0, gzip'), true);
});

test('大小寫與空白不影響判斷', () => {
  assert.equal(acceptsGzip('  GZIP ; Q=0.8 '), true);
  assert.equal(acceptsGzip('GZIP;Q=0'), false);
});

test('q 值格式錯誤時依 RFC 預設為 1', () => {
  assert.equal(acceptsGzip('gzip;q=abc'), true);
});

// MARK: - manifest 的 sha256 / bytes / gzipBytes

function bundle(): StaticBundle {
  return {
    version: 'testversion00000',
    builtAt: '2026-08-01T00:00:00.000Z',
    stations: [
      {
        stationUID: 'TPE9800',
        name: '臺北車站',
        nameEn: 'Taipei Main Station',
        lat: 25.0465,
        lon: 121.5175,
        stops: [],
      },
    ] as StaticBundle['stations'],
    routes: [] as StaticBundle['routes'],
    routeStops: [] as StaticBundle['routeStops'],
    shapes: [] as StaticBundle['shapes'],
    stopIndex: [] as StaticBundle['stopIndex'],
  };
}

test('sha256 對應解壓後內容，而非傳輸的位元組', () => {
  const asset = compressAll(bundle()).get('stations');
  assert.ok(asset);

  const decompressed = gunzipSync(asset.gzipped);
  const uncompressedHash = createHash('sha256').update(decompressed).digest('hex');
  const gzippedHash = createHash('sha256').update(asset.gzipped).digest('hex');

  assert.equal(asset.sha256, uncompressedHash);
  assert.notEqual(asset.sha256, gzippedHash);
});

test('bytes 為解壓後長度，gzipBytes 為傳輸長度', () => {
  const asset = compressAll(bundle()).get('stations');
  assert.ok(asset);

  assert.equal(asset.bytes, gunzipSync(asset.gzipped).byteLength);
  assert.equal(asset.gzipBytes, asset.gzipped.byteLength);
});

test('解壓後可還原為原始 JSON', () => {
  const source = bundle();
  const asset = compressAll(source).get('stations');
  assert.ok(asset);

  assert.deepEqual(JSON.parse(gunzipSync(asset.gzipped).toString('utf8')), source.stations);
});

test('五份靜態資料都被打包', () => {
  const assets = compressAll(bundle());
  assert.deepEqual(
    [...assets.keys()].sort(),
    ['routes', 'shapes', 'stations', 'stopIndex', 'stopOfRoute'].sort(),
  );
});
