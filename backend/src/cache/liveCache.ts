import { config } from '../config.ts';
import {
  fetchRealTimeByFrequency,
  fetchEstimatedTimeOfArrival,
  TDXError,
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

  /**
   * 因 429 而暫時放大的輪詢間隔。
   *
   * TDX 的呼叫次數配額**未公開**（官方只公告每秒 50 次的平行請求限制），
   * 實測會在少量請求後就回 429。撞到時繼續按原間隔猛打只會一直被擋，
   * 因此改為指數退避，成功後再逐步收回。
   *
   * 用 `npm run measure-quota` 量出實際配額後，應直接把
   * POLL_INTERVAL_MS 設到安全值，讓這個機制只當保險而非常態。
   */
  private throttledIntervalMs: number | null = null;
  private rateLimitedCount = 0;

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
    this.scheduleNext();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** 目前實際使用的輪詢間隔（可能因 429 而放大）。 */
  get currentIntervalMs(): number {
    return this.throttledIntervalMs ?? config.pollIntervalMs;
  }

  /**
   * 改用 setTimeout 逐次排程而非 setInterval——間隔會因 429 動態改變，
   * setInterval 無法在不重建計時器的情況下調整週期。
   */
  private scheduleNext(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.refresh().finally(() => this.scheduleNext());
    }, this.currentIntervalMs);
    this.timer.unref?.();
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
      this.relaxThrottle();

      console.log(
        `[cache] ${buses.length} 車 / ${etas.length} 預估　` +
          `${fmtBytes(a1.stats.bytes + n1.stats.bytes)}　` +
          `${a1.stats.elapsedMs + n1.stats.elapsedMs}ms`,
      );
    } catch (error) {
      this.consecutiveFailures++;

      if (error instanceof TDXError && error.status === 429) {
        this.applyThrottle();
      } else {
        console.error(
          `[cache] 更新失敗 (連續 ${this.consecutiveFailures} 次)：${(error as Error).message}`,
        );
      }
      // 刻意**不清空** snapshot——寧可回舊資料也不要讓 App 顯示空地圖。
      // 見 API_CONTRACT.md §1.2 的 UPSTREAM_UNAVAILABLE 行為約定。
    }
  }

  /** 撞到 429：間隔加倍，上限 5 分鐘。 */
  private applyThrottle(): void {
    this.rateLimitedCount++;
    const base = this.throttledIntervalMs ?? config.pollIntervalMs;
    this.throttledIntervalMs = Math.min(base * 2, 5 * 60 * 1000);
    console.warn(
      `[cache] TDX 配額用盡 (429，累計 ${this.rateLimitedCount} 次)，` +
        `輪詢間隔放大為 ${this.throttledIntervalMs / 1000} 秒。` +
        `建議執行 npm run measure-quota 量出實際配額後調整 POLL_INTERVAL_MS。`,
    );
  }

  /** 成功後逐步收回間隔，而非一次跳回——避免立刻又撞上配額。 */
  private relaxThrottle(): void {
    if (this.throttledIntervalMs === null) return;
    const relaxed = Math.round(this.throttledIntervalMs / 1.5);
    if (relaxed <= config.pollIntervalMs) {
      this.throttledIntervalMs = null;
      console.log('[cache] 輪詢間隔已恢復正常');
    } else {
      this.throttledIntervalMs = relaxed;
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
