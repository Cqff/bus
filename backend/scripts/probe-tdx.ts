/**
 * TDX 實測腳本。
 *
 * 回答 DESIGN.md §0.1 與 §2.1 標記為「取得金鑰後第一週務必實測」的三個問題：
 *
 *   1. 台北市 A1 動態資料**實際**多久更新一次？
 *      （官方文件說每分鐘，但 PTX 時代台北市約 20 秒。這決定「誤差 30 秒」能否達成。）
 *   2. 全市單次回應的資料量多大？
 *      （若過大則需改用空間篩選分區拉取，會改變整個 proxy 架構。）
 *   3. `src/tdx/types.ts` 裡的欄位名稱對不對？
 *      （那份型別是依慣例寫的，未經驗證。）
 *
 * 用法：
 *   npm run probe                  # 預設觀測 10 分鐘，每 15 秒取樣
 *   npm run probe -- 20 10         # 觀測 20 分鐘，每 10 秒取樣
 *
 * 產出：
 *   probe-output/raw-sample.json   原始回應樣本（用來核對欄位名稱）
 *   probe-output/report.md         實測報告
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { fetchRealTimeByFrequency } from '../src/tdx/client.ts';
import type { TDXRealTimeByFrequency } from '../src/tdx/types.ts';

const OUT_DIR = new URL('../probe-output/', import.meta.url);

const minutes = Number(process.argv[2] ?? 10);
const intervalSec = Number(process.argv[3] ?? 15);
const totalSamples = Math.max(2, Math.round((minutes * 60) / intervalSec));

type Sample = {
  index: number;
  wallClock: Date;
  bytes: number;
  count: number;
  elapsedMs: number;
  /** 本次取樣中 GPSTime 與上次不同的車輛數 */
  changedCount: number;
  /** 資料年齡（秒）：取樣時間 − GPSTime */
  ages: number[];
};

/** 每台車上次看到的 GPSTime 與當時的取樣序號 */
type VehicleState = { gpsTime: string; sampleIndex: number };

async function main(): Promise<void> {
  console.log(`開始實測：${minutes} 分鐘，每 ${intervalSec} 秒取樣，共 ${totalSamples} 次\n`);

  await mkdir(OUT_DIR, { recursive: true });

  const samples: Sample[] = [];
  const vehicles = new Map<string, VehicleState>();
  /** 每次 GPSTime 變動之間隔了幾秒 */
  const updateGaps: number[] = [];
  let rawSampleSaved = false;
  let fieldCheck: FieldCheck | null = null;

  for (let i = 0; i < totalSamples; i++) {
    const wallClock = new Date();
    try {
      const { data, stats } = await fetchRealTimeByFrequency();

      if (!rawSampleSaved && data.length > 0) {
        await writeFile(
          new URL('raw-sample.json', OUT_DIR),
          JSON.stringify(data.slice(0, 5), null, 2),
          'utf8',
        );
        fieldCheck = checkFields(data);
        rawSampleSaved = true;
        reportFieldCheck(fieldCheck);
      }

      let changedCount = 0;
      const ages: number[] = [];

      for (const bus of data) {
        const plate = bus.PlateNumb;
        const gpsTime = bus.GPSTime;
        if (!plate || !gpsTime) continue;

        const ageSec = (wallClock.getTime() - new Date(gpsTime).getTime()) / 1000;
        if (Number.isFinite(ageSec)) ages.push(ageSec);

        const previous = vehicles.get(plate);
        if (!previous) {
          vehicles.set(plate, { gpsTime, sampleIndex: i });
        } else if (previous.gpsTime !== gpsTime) {
          changedCount++;
          updateGaps.push((i - previous.sampleIndex) * intervalSec);
          vehicles.set(plate, { gpsTime, sampleIndex: i });
        }
      }

      samples.push({
        index: i,
        wallClock,
        bytes: stats.bytes,
        count: stats.count,
        elapsedMs: stats.elapsedMs,
        changedCount,
        ages,
      });

      const pct = data.length ? Math.round((changedCount / data.length) * 100) : 0;
      console.log(
        `[${i + 1}/${totalSamples}] ${stats.count} 筆　` +
          `${fmtBytes(stats.bytes)}　${stats.elapsedMs}ms　` +
          `更新 ${changedCount} 台 (${pct}%)　` +
          `中位年齡 ${median(ages).toFixed(0)}s`,
      );
    } catch (error) {
      console.error(`[${i + 1}/${totalSamples}] 失敗：${(error as Error).message}`);
    }

    if (i < totalSamples - 1) {
      await sleep(intervalSec * 1000);
    }
  }

  const report = buildReport(samples, updateGaps, vehicles.size, fieldCheck);
  await writeFile(new URL('report.md', OUT_DIR), report, 'utf8');

  console.log('\n' + '='.repeat(60));
  console.log(report);
  console.log('='.repeat(60));
  console.log(`\n報告已寫入 probe-output/report.md`);
  console.log(`原始樣本已寫入 probe-output/raw-sample.json —— 請據此核對 src/tdx/types.ts`);
}

// MARK: - 欄位驗證

type FieldCheck = {
  total: number;
  hasPlateNumb: number;
  hasGPSTime: number;
  hasPosition: number;
  hasRouteUID: number;
  hasRouteName: number;
};

function checkFields(data: TDXRealTimeByFrequency[]): FieldCheck {
  return {
    total: data.length,
    hasPlateNumb: data.filter((b) => b.PlateNumb).length,
    hasGPSTime: data.filter((b) => b.GPSTime).length,
    hasPosition: data.filter(
      (b) => typeof b.BusPosition?.PositionLat === 'number',
    ).length,
    hasRouteUID: data.filter((b) => b.RouteUID).length,
    hasRouteName: data.filter((b) => b.RouteName?.Zh_tw).length,
  };
}

function reportFieldCheck(check: FieldCheck): void {
  const rows: Array<[string, number]> = [
    ['PlateNumb', check.hasPlateNumb],
    ['GPSTime', check.hasGPSTime],
    ['BusPosition.PositionLat', check.hasPosition],
    ['RouteUID', check.hasRouteUID],
    ['RouteName.Zh_tw', check.hasRouteName],
  ];

  const broken = rows.filter(([, n]) => n === 0);
  if (broken.length > 0) {
    console.warn('\n⚠️  以下欄位在實際回應中完全不存在，types.ts 需要修正：');
    for (const [name] of broken) console.warn(`      ${name}`);
    console.warn('    請開啟 probe-output/raw-sample.json 核對真實欄位名稱\n');
  } else {
    console.log('\n✅ 欄位名稱與 types.ts 相符\n');
  }
}

// MARK: - 報告

function buildReport(
  samples: Sample[],
  updateGaps: number[],
  vehicleCount: number,
  fieldCheck: FieldCheck | null,
): string {
  if (samples.length === 0) {
    return '# TDX 實測報告\n\n所有取樣皆失敗，無資料可分析。';
  }

  const allAges = samples.flatMap((s) => s.ages);
  const bytes = samples.map((s) => s.bytes);
  const counts = samples.map((s) => s.count);
  const latencies = samples.map((s) => s.elapsedMs);

  const medianGap = median(updateGaps);
  const p90Gap = percentile(updateGaps, 90);
  const maxAge = Math.max(...allAges, 0);
  const p90Age = percentile(allAges, 90);

  // 「誤差 30 秒」能否達成，取決於資料年齡而非拉取頻率
  const meets30s = p90Age <= 30;

  return `# TDX 實測報告

觀測期間：${samples[0]!.wallClock.toISOString()} — ${samples.at(-1)!.wallClock.toISOString()}
取樣次數：${samples.length}　取樣間隔：${intervalSec} 秒

## 1. 實際更新頻率

觀測到的不重複車輛數：**${vehicleCount}**
偵測到 GPSTime 變動次數：**${updateGaps.length}**

| 指標 | 秒 |
|---|---|
| 車輛位置更新間隔（中位數）| **${medianGap.toFixed(0)}** |
| 車輛位置更新間隔（p90）| ${p90Gap.toFixed(0)} |

> 取樣間隔為 ${intervalSec} 秒，因此此處的解析度上限即為 ${intervalSec} 秒。
> 若中位數等於取樣間隔，代表實際更新可能更快，需縮小取樣間隔再測一次。

## 2. 資料年齡（決定「誤差 30 秒」能否達成）

| 指標 | 秒 |
|---|---|
| 中位數 | ${median(allAges).toFixed(1)} |
| p90 | ${p90Age.toFixed(1)} |
| 最大 | ${maxAge.toFixed(1)} |

**結論：${meets30s ? '✅ p90 在 30 秒內，需求可達成' : '❌ p90 超過 30 秒，需求無法達成'}**

${
  meets30s
    ? '可維持 DESIGN.md §0.1 的現行設計。'
    : `這印證了 DESIGN.md §0.1 的判斷：誤差上限由 TDX 資料源決定，非後端可控。
必須維持「顯示每筆資料時間戳」的設計，不可對外宣稱 30 秒即時。`
}

## 3. 資料量（決定是否需分區拉取）

| 指標 | 值 |
|---|---|
| 紀錄筆數（中位數）| ${median(counts).toFixed(0)} |
| 未壓縮大小（中位數）| ${fmtBytes(median(bytes))} |
| 未壓縮大小（最大）| ${fmtBytes(Math.max(...bytes))} |
| 回應延遲（中位數）| ${median(latencies).toFixed(0)} ms |
| 回應延遲（p90）| ${percentile(latencies, 90).toFixed(0)} ms |

${
  median(bytes) > 5_000_000
    ? '⚠️ **單次回應超過 5MB，建議改用 `$spatialFilter` 分區拉取。**'
    : '✅ 資料量在單次全市拉取的合理範圍內。'
}

每日 TDX 呼叫量估算（以 ${intervalSec} 秒間隔、每日 20 小時營運計）：
**約 ${Math.round((20 * 3600) / intervalSec).toLocaleString()} 次/日**

## 4. 欄位驗證

${
  fieldCheck
    ? `樣本數 ${fieldCheck.total}

| 欄位 | 出現筆數 | 比例 |
|---|---|---|
| PlateNumb | ${fieldCheck.hasPlateNumb} | ${pct(fieldCheck.hasPlateNumb, fieldCheck.total)} |
| GPSTime | ${fieldCheck.hasGPSTime} | ${pct(fieldCheck.hasGPSTime, fieldCheck.total)} |
| BusPosition.PositionLat | ${fieldCheck.hasPosition} | ${pct(fieldCheck.hasPosition, fieldCheck.total)} |
| RouteUID | ${fieldCheck.hasRouteUID} | ${pct(fieldCheck.hasRouteUID, fieldCheck.total)} |
| RouteName.Zh_tw | ${fieldCheck.hasRouteName} | ${pct(fieldCheck.hasRouteName, fieldCheck.total)} |

比例為 0 的欄位代表 \`src/tdx/types.ts\` 的名稱有誤，請對照 \`raw-sample.json\` 修正。`
    : '未取得樣本。'
}

## 5. 建議調整

- \`POLL_INTERVAL_MS\` 建議設為 **${suggestPollInterval(medianGap, intervalSec)} 毫秒**
  （拉得比資料源更新更快沒有意義，只會浪費配額）
- iOS \`LiveBus.stale\` 門檻（目前 90 秒）：實測 p90 年齡為 ${p90Age.toFixed(0)} 秒，${
    p90Age > 90 ? '**偏低，建議調高**' : '合理'
  }
`;
}

function suggestPollInterval(medianGapSec: number, samplingSec: number): number {
  // 資料源若 N 秒更新一次，拉取間隔取 N 的一半即可保證及時取得，再快就是浪費
  if (!Number.isFinite(medianGapSec) || medianGapSec <= 0) return samplingSec * 1000;
  return Math.max(10_000, Math.round((medianGapSec / 2) * 1000));
}

// MARK: - 小工具

function median(values: number[]): number {
  return percentile(values, 50);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] ?? 0;
}

function pct(n: number, total: number): string {
  return total === 0 ? '—' : `${Math.round((n / total) * 100)}%`;
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes.toFixed(0)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await main();
