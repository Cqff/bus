/**
 * WKT LINESTRING → Google Encoded Polyline（precision 5）。
 *
 * TDX 的 Bus/Shape 以 WKT 提供線型，未壓縮時全市線型可達數 MB。
 * 轉為 encoded polyline 後通常縮小 8–10 倍，且 iOS 端已有對應的解碼器
 * （`ios/BusMap/Utils/Polyline.swift`）。
 */

export type LatLon = { lat: number; lon: number };

/**
 * 解析 WKT `LINESTRING (lon lat, lon lat, ...)`。
 *
 * 注意 WKT 的順序是 **經度在前、緯度在後**，與一般習慣相反——
 * 寫反會讓所有路線出現在地球另一側。
 */
export function parseWKTLineString(wkt: string): LatLon[] {
  const match = /LINESTRING\s*\(([^)]*)\)/i.exec(wkt);
  if (!match?.[1]) return [];

  const points: LatLon[] = [];
  for (const pair of match[1].split(',')) {
    const parts = pair.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const lon = Number(parts[0]);
    const lat = Number(parts[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    points.push({ lat, lon });
  }
  return points;
}

/** 編碼為 Google Encoded Polyline（precision 5）。 */
export function encodePolyline(points: LatLon[]): string {
  let previousLat = 0;
  let previousLon = 0;
  let result = '';

  for (const point of points) {
    const lat = Math.round(point.lat * 1e5);
    const lon = Math.round(point.lon * 1e5);
    result += encodeValue(lat - previousLat);
    result += encodeValue(lon - previousLon);
    previousLat = lat;
    previousLon = lon;
  }

  return result;
}

function encodeValue(value: number): string {
  // zigzag：負數映射為奇數，正數為偶數
  let v = value < 0 ? ~(value << 1) : value << 1;
  let output = '';
  while (v >= 0x20) {
    output += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  output += String.fromCharCode(v + 63);
  return output;
}

/** 解碼。僅供測試往返驗證使用。 */
export function decodePolyline(encoded: string): LatLon[] {
  const points: LatLon[] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  while (index < encoded.length) {
    const dLat = decodeValue();
    if (dLat === null) break;
    lat += dLat;
    const dLon = decodeValue();
    if (dLon === null) break;
    lon += dLon;
    points.push({ lat: lat / 1e5, lon: lon / 1e5 });
  }

  return points;

  function decodeValue(): number | null {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      if (index >= encoded.length) return null;
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
      if (shift > 32) return null;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  }
}
