import { config } from '../config.ts';
import {
  fetchRealTimeByFrequency,
  fetchEstimatedTimeOfArrival,
} from '../tdx/client.ts';
import { toLiveBus, toLiveETA } from '../transform.ts';
import type { LiveBusDTO, LiveETADTO } from '../transform.ts';

export type BBox = {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
};

type Snapshot = {
  buses: LiveBusDTO[];
  etas: LiveETADTO[];
  /** 這份快照的產生時間 */
  filledAt: Date;
};

/**
 * 全市即時資料的記憶體快取。
 *
 * 這是 D1 決策的核心：資料不寫 Firestore，改由此處常駐記憶體，
 * 經 HTTP 端點 + CDN 快取供 App 輪詢。成本相差約 20 倍，
 * 而 TDX 本身只有分鐘級更新，「即時推送」對使用者毫無差別。
 * 見 DESIGN.md §1.1。
 *
 * 因為需要常駐記憶體，部署必須用 Cloud Run（min-instances=1），
 * 不能用 Cloud Functions——後者實例會被回收，每次冷啟動都要重拉全量資料。
 */
class LiveCache {
  private snapshot: Snapshot | null = null;
  private lastGoodAt: Date | null = null;
  private consecutiveFailures = 0;
  private timer: NodeJS.Timeout | null = null;

  /** StopUID → StationUID，由靜態資料同步作業填入 */
  private stopToStation = new Map<string, string>();

  setStopToStation(map: Map<string, string>): void {
    this.stopToStation = map;
  }

  get isReady(): boolean {
    return this.snapshot !== null;
  }

  get filledAt(): Date | null {
    return this.snapshot?.filledAt ?? null;
  }

  get lastGood(): Date | null {
    return this.lastGoodAt;
  }

  get failures(): number {
    return this.consecutiveFailures;
  }

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), config.pollIntervalMs);
    // 不讓輪詢計時器阻止行程結束
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async refresh(): Promise<void> {
    try {
      const [a1, n1] = await Promise.all([
        fetchRealTimeByFrequency(),
        fetchEstimatedTimeOfArrival(),
      ]);

      const nowMs = Date.now();
      const buses = a1.data
        .map((raw) => toLiveBus(raw, nowMs))
        .filter((bus): bus is LiveBusDTO => bus !== null);
      const etas = n1.data
        .map((raw) => toLiveETA(raw, nowMs, this.stopToStation))
        .filter((eta): eta is LiveETADTO => eta !== null);

      this.snapshot = { buses, etas, filledAt: new Date(nowMs) };
      this.lastGoodAt = new Date(nowMs);
      this.consecutiveFailures = 0;

      console.log(
        `[cache] ${buses.length} 車 / ${etas.length} 預估　` +
          `${fmtBytes(a1.stats.bytes + n1.stats.bytes)}　` +
          `${a1.stats.elapsedMs + n1.stats.elapsedMs}ms`,
      );
    } catch (error) {
      this.consecutiveFailures++;
      console.error(
        `[cache] 更新失敗 (連續 ${this.consecutiveFailures} 次)：${(error as Error).message}`,
      );
      // 刻意**不清空** snapshot——寧可回舊資料也不要讓 App 顯示空地圖。
      // 見 API_CONTRACT.md §1.2 的 UPSTREAM_UNAVAILABLE 行為約定。
    }
  }

  // MARK: - 查詢

  busesByRoute(routeUID: string, direction?: 0 | 1): LiveBusDTO[] {
    const all = this.snapshot?.buses ?? [];
    return all.filter(
      (bus) =>
        bus.routeUID === routeUID &&
        (direction === undefined || bus.direction === direction),
    );
  }

  busesInBBox(bbox: BBox, limit: number): { buses: LiveBusDTO[]; truncated: boolean } {
    const all = this.snapshot?.buses ?? [];
    const inside = all.filter(
      (bus) =>
        bus.lat >= bbox.minLat &&
        bus.lat <= bbox.maxLat &&
        bus.lon >= bbox.minLon &&
        bus.lon <= bbox.maxLon,
    );
    // 超過上限時優先保留資料較新的——過期車輛對使用者價值最低
    if (inside.length <= limit) {
      return { buses: inside, truncated: false };
    }
    const sorted = [...inside].sort((a, b) => a.ageSec - b.ageSec);
    return { buses: sorted.slice(0, limit), truncated: true };
  }

  etasByStop(stopUID: string): LiveETADTO[] {
    return (this.snapshot?.etas ?? []).filter((eta) => eta.stopUID === stopUID);
  }

  etasByStation(stationUID: string): LiveETADTO[] {
    return (this.snapshot?.etas ?? []).filter(
      (eta) => eta.stationUID === stationUID,
    );
  }

  etasByRoute(routeUID: string, direction?: 0 | 1): LiveETADTO[] {
    return (this.snapshot?.etas ?? []).filter(
      (eta) =>
        eta.routeUID === routeUID &&
        (direction === undefined || eta.direction === direction),
    );
  }
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

export const liveCache = new LiveCache();
