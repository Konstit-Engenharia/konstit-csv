import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  countCsvFile,
  csv,
  parseCsvBuffer,
  parseCsvFile,
  parseCsvFileProjected,
} from '../src/index.ts';

interface RegressionBaseline {
  rows: number;
  samples: number;
  maxMilliseconds: Record<string, number>;
}

const baseline = await Bun.file(new URL('./regression-baselines.json', import.meta.url)).json() as RegressionBaseline;
const guardMultiplier = Number(process.env['CSV_BENCH_GUARD_MULTIPLIER'] ?? '1');
const ROWS = baseline.rows;
const EXPECTED_ROWS = ROWS + 1;
const HOT_ROWS = ROWS / 10;
const HOT_FILTER = csv.column(3).equals('hot');

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function maxMilliseconds(label: string): number {
  const value = baseline.maxMilliseconds[label];
  if (value === undefined) {
    throw new Error(`missing regression baseline for ${label}`);
  }
  return value * guardMultiplier;
}

function assertUnder(milliseconds: number, max: number, label: string): void {
  if (milliseconds > max) {
    throw new Error(`${label}: median ${milliseconds.toFixed(1)}ms > ${max.toFixed(1)}ms`);
  }
}

async function measureMedian(label: string, fn: () => Promise<void> | void): Promise<number> {
  await fn();

  const samples: number[] = [];
  for (let index = 0; index < baseline.samples; ++index) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  samples.sort((left, right) => left - right);
  const median = samples[Math.floor(samples.length / 2)] ?? 0;
  assertUnder(median, maxMilliseconds(label), label);
  console.log(`${label}: median ${median.toFixed(1)}ms samples=${samples.map((sample) => sample.toFixed(1)).join(',')}`);
  return median;
}

async function collectRows(path: string): Promise<number> {
  let count = 0;
  for await (const batch of parseCsvFile(path, { chunkSize: 4_096 })) {
    count += batch.length;
  }
  return count;
}

async function collectProjectedHotRows(path: string): Promise<number> {
  let count = 0;
  for await (
    const batch of parseCsvFileProjected(path, {
      chunkSize: 4_096,
      columns: [0, 3],
      equalsFilter: { column: 3, value: 'hot' },
    })
  ) {
    count += batch.length;
  }
  return count;
}

const csvPath = fileURLToPath(new URL(`../corpus/bench/regression-smoke-${ROWS}-rows.csv`, import.meta.url));
const csvBuffer = readFileSync(csvPath);

await measureMedian('materialize buffer', () => {
  const rows = parseCsvBuffer(csvBuffer);
  assertEqual(rows.length, EXPECTED_ROWS, 'materialized row count');
  assertEqual(rows[0]?.[0], 'id', 'header first column');
  assertEqual(rows[1]?.[2], 'Sao Paulo, SP', 'quoted field');
  assertEqual(rows[ROWS]?.[4], String((ROWS - 1) % 997), 'last value');
});

await measureMedian('strict materialize buffer', () => {
  const rows = parseCsvBuffer(csvBuffer, { strict: true });
  assertEqual(rows.length, EXPECTED_ROWS, 'strict materialized row count');
  assertEqual(rows[ROWS]?.[3], (ROWS - 1) % 10 === 0 ? 'hot' : 'cold', 'strict last status');
});

await measureMedian('count file', async () => {
  const count = await countCsvFile(csvPath, { chunkSize: 4_096 });
  assertEqual(count, EXPECTED_ROWS, 'countCsvFile row count');
});

await measureMedian('count where equals', async () => {
  const count = await csv.count(csvPath, { chunkSize: 4_096, where: HOT_FILTER });
  assertEqual(count, HOT_ROWS, 'csv.count filtered row count');
});

await measureMedian('stream materialize file', async () => {
  const count = await collectRows(csvPath);
  assertEqual(count, EXPECTED_ROWS, 'parseCsvFile row count');
});

await measureMedian('projected filter file', async () => {
  const count = await collectProjectedHotRows(csvPath);
  assertEqual(count, HOT_ROWS, 'parseCsvFileProjected hot row count');
});

console.log(`smoke ok: ${ROWS} synthetic data rows`);
