import Foundation
import CoreLocation

/// Google Encoded Polyline Algorithm（precision 5）解碼。
/// 後端以此格式壓縮路線線型，見 API_CONTRACT.md §3.5。
enum Polyline {

    static func decode(_ encoded: String) -> [CLLocationCoordinate2D] {
        var coordinates: [CLLocationCoordinate2D] = []
        var index = encoded.startIndex
        var lat = 0
        var lon = 0

        while index < encoded.endIndex {
            guard let dLat = nextValue(in: encoded, from: &index) else { break }
            lat += dLat
            guard let dLon = nextValue(in: encoded, from: &index) else { break }
            lon += dLon

            coordinates.append(
                CLLocationCoordinate2D(latitude: Double(lat) / 1e5,
                                       longitude: Double(lon) / 1e5)
            )
        }
        return coordinates
    }

    /// 讀出一個 varint 並還原 zigzag 編碼。回傳 nil 表示字串已結束或格式損毀。
    private static func nextValue(in string: String, from index: inout String.Index) -> Int? {
        var result = 0
        var shift = 0
        var byte = 0

        repeat {
            guard index < string.endIndex,
                  let ascii = string[index].asciiValue else { return nil }
            index = string.index(after: index)

            byte = Int(ascii) - 63
            result |= (byte & 0x1F) << shift
            shift += 5

            // 防止損毀資料造成無限位移
            if shift > 32 { return nil }
        } while byte >= 0x20

        return (result & 1) != 0 ? ~(result >> 1) : (result >> 1)
    }
}
