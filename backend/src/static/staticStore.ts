import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  fetchStops,
  fetchRoutes,
  fetchStopOfRoute,
  fetchShapes,
} from '../tdx/client.ts';
import { buildBundle } from './bundle.ts';
import type { StaticBundle } from './bundle.ts';
import { buildStopToStationMap } from './merge.ts';
import { liveCache } from '../cache/liveCache.ts';

/** 預先壓縮好的檔案，直接由記憶體供應。 */
type Asset = {
  gzipped: Buffer;
  sha256: string;
  bytes: number;
};

/**
 * 靜態資料（站牌／路線／站序／線型）的記憶體存放與每日更新。
 *
 * **刻意不使用 Cloud Storage。** 整包壓縮後約 1–3MB，直接由 Cloud Run
 * 記憶體供應並讓 CDN 快取 1 小時即可——省掉一個服務、一組權限設定，
 * 也省掉「Storage 的檔案與記憶體中的版本不一致」這類麻煩。
 *
 * TDX 靜態資料每日更新一次，因此重建頻率設為每日。
 */
class StaticStore {
  private bundle: StaticBundle | null = null;
  private assets = new Map<string, Asset>();
  private timer: NodeJS.Timeout | null = null;
  private refreshing = false;

  get isReady(): boolean {
    return this.bundle !== null;
  }

  get version(): string | null {
    return this.bundle?.version ?? null;
  }

  get builtAt(): string | null {
    return this.bundle?.builtAt ?? null;
  }

  asset(name: string): Asset | null {
    return this.assets.get(name) ?? null;
  }

  manifest(baseUrl: string): unknown {
    if (!this.bundle) return null;
    const files: Record<string, unknown> = {};
    for (const [name, asset] of this.assets) {
      files[name] = {
        url: `${baseUrl}/v1/static/${name}`,
        sha256: asset.sha256,
        bytes: asset.bytes,
      };
    }
    return {
      version: this.bundle.version,
      builtAt: this.bundle.builtAt,
      minAppBuild: 1,
      files,
    };
  }

  start(): void {
    if (this.timer) return;
    void this.refresh();
    // 每日重建。TDX 靜態資料每日更新，拉更頻繁沒有意義。
    this.timer = setInterval(() => void this.refresh(), 24 * 60 * 60 * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;

    try {
      const [stops, routes, stopOfRoutes, shapes] = await Promise.all([
        fetchStops(),
        fetchRoutes(),
        fetchStopOfRoute(),
        fetchShapes(),
      ]);

      const built = buildBundle(
        {
          stops: stops.data,
          routes: routes.data,
          stopOfRoutes: stopOfRoutes.data,
          shapes: shapes.data,
        },
        new Date(),
      );

      const previousVersion = this.bundle?.version;
      this.bundle = built;
      this.assets = compressAll(built);

      // 讓 N1 預估到站資料能補上 stationUID
      liveCache.setStopToStation(buildStopToStationMap(built.stations));

      const totalBytes = [...this.assets.values()].reduce((sum, a) => sum + a.bytes, 0);
      console.log(
        `[static] version=${built.version}` +
          `${previousVersion === built.version ? '（未變動）' : ''}　` +
          `${built.stations.length} 站位 / ${built.routes.length} 路線 / ` +
          `${built.stopIndex.length} 站牌　壓縮後 ${(totalBytes / 1024).toFixed(0)}KB`,
      );
    } catch (error) {
      console.error(`[static] 更新失敗：${(error as Error).message}`);
      // 保留舊資料——靜態資料過期一天遠比整個 App 沒有站牌可用好
    } finally {
      this.refreshing = false;
    }
  }
}

function compressAll(bundle: StaticBundle): Map<string, Asset> {
  const assets = new Map<string, Asset>();
  const parts: Array<[string, unknown]> = [
    ['stations', bundle.stations],
    ['routes', bundle.routes],
    ['stopOfRoute', bundle.routeStops],
    ['shapes', bundle.shapes],
    // Cloud Functions 用來驗證 150 公尺距離
    ['stopIndex', bundle.stopIndex],
  ];

  for (const [name, data] of parts) {
    const json = JSON.stringify(data);
    const gzipped = gzipSync(Buffer.from(json, 'utf8'), { level: 9 });
    assets.set(name, {
      gzipped,
      // 對**未壓縮**內容取雜湊，App 解壓後才能驗證
      sha256: createHash('sha256').update(json).digest('hex'),
      bytes: gzipped.byteLength,
    });
  }

  return assets;
}

export const staticStore = new StaticStore();
