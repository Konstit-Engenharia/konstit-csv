import {
  bench,
  summary,
} from 'mitata';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  csv,
  type CsvRowsOptions,
} from '../src/index.ts';
import { makeLatin1Text } from './synthetic/fixtures.ts';

// Measure complete serial scans at two batch sizes. Consuming each field before advancing
// lets callers reuse rows without copying them and keeps field decoding in the timings.
const sourceFile = Bun.env['CSV_BENCH_FILE'];
if (sourceFile === undefined) {
  const directory = mkdtempSync(join(tmpdir(), 'csv-reuse-arrays-'));
  process.once('exit', () => rmSync(directory, { force: true, recursive: true }));
  const text = makeLatin1Text(250_000);
  for (const encoding of ['utf8', 'latin1'] as const) {
    const path = join(directory, `${encoding}.csv`);
    await Bun.write(path, Buffer.from(text, encoding));
    await registerScans(path, encoding, ',');
  }
} else {
  const encoding = Bun.env['CSV_BENCH_ENCODING'] ?? 'latin1';
  if (encoding !== 'utf8' && encoding !== 'latin1') {
    throw new Error('CSV_BENCH_ENCODING must be utf8 or latin1');
  }
  await registerScans(sourceFile, encoding, Bun.env['CSV_BENCH_DELIMITER'] ?? ';');
}

async function registerScans(path: string, encoding: 'utf8' | 'latin1', delimiter: string) {
  const expected = await consume(path, { encoding, delimiter });
  if (expected.rows === 0 || (sourceFile === undefined && expected.rows !== 250_001)) {
    throw new Error(`unexpected fixture row count: ${expected.rows}`);
  }
  for (const chunkSize of [64 * 1024, 1024 * 1024]) {
    const options = { encoding, delimiter, chunkSize };
    summary(() => {
      for (const reuseArrays of [false, true]) {
        const rowOptions = reuseArrays ? { ...options, reuseArrays } : options;
        const label = reuseArrays ? 'reuseArrays' : 'default';
        bench(`${encoding} ${chunkSize / 1024} KiB ${label}`, async () => {
          const result = await consume(path, rowOptions);
          if (result.rows !== expected.rows || result.fields !== expected.fields || result.chars !== expected.chars) {
            throw new Error(`unexpected materialization result: ${JSON.stringify(result)}`);
          }
        });
      }
    });
  }
}

async function consume(path: string, options: CsvRowsOptions) {
  let rows = 0;
  let fields = 0;
  let chars = 0;
  for await (const batch of csv.rows(path, options)) {
    rows += batch.length;
    for (const row of batch) {
      fields += row.length;
      for (const value of row) {
        chars += value.length;
      }
    }
  }
  return { rows, fields, chars };
}
