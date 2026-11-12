import { measure } from 'mitata';
import {
  createReadStream,
  statSync,
} from 'node:fs';
import { NativeCsvParser } from '../src/index.ts';
import { matchesBenchmarkName } from './benchmark-filter.ts';

interface BenchResult {
  rows: number;
  fields: number;
  bytes: number;
}

const FILE = Bun.env['CSV_BENCH_FILE'] ?? 'corpus/large/example.csv';
const CHUNK_SIZE = Number(Bun.env['CSV_BENCH_CHUNK_SIZE'] ?? 8 * 1024 * 1024);
const DELIMITER = Bun.env['CSV_BENCH_DELIMITER'] ?? ';';
const SELECTED_COLUMNS = (Bun.env['CSV_BENCH_COLUMNS'] ?? '0,4,19')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value >= 0);
const PRINT_ROWS = Number(Bun.env['CSV_ROW_VIEW_PRINT_ROWS'] ?? 10);
const bytes = statSync(FILE).size;

const cases = [
  ['forEachRow selected field bytes(count)', () => countSelectedFieldsWithRowView()],
  ['rowsInto selected fields(count)', () => countSelectedFieldsWithRowsInto()],
  ['forEachRow selected fields(print first rows)', () => printSelectedFieldsWithRowView()],
  ['rowsInto selected fields(print first rows)', () => printSelectedFieldsWithRowsInto()],
] as const;

console.log({
  file: FILE,
  bytes,
  chunkSize: CHUNK_SIZE,
  delimiter: DELIMITER,
  selectedColumns: SELECTED_COLUMNS,
  printRows: PRINT_ROWS,
});

for (const [name, fn,] of cases) {
  if (!matchesBenchmarkName(name)) {
    continue;
  }

  let result: BenchResult = { rows: 0, fields: 0, bytes: 0 };
  const stats = await measure(async () => {
    result = await fn();
    if (result.rows === 0) {
      throw new Error(`${name}: zero rows`);
    }
  }, {
    min_samples: 1,
    max_samples: 1,
    min_cpu_time: 0,
    warmup_samples: 0,
  });

  const seconds = stats.avg / 1e9;
  const mibPerSecond = bytes / 1024 / 1024 / seconds;

  console.log({
    name,
    ...result,
    seconds,
    mibPerSecond,
  });
}

async function countSelectedFieldsWithRowView(): Promise<BenchResult> {
  using parser = new NativeCsvParser({ delimiter: DELIMITER });
  const result: BenchResult = { rows: 0, fields: 0, bytes: 0 };
  for await (const chunk of createReadStream(FILE, { highWaterMark: CHUNK_SIZE })) {
    using batch = parser.writeBatch(chunk as Buffer);
    batch.forEachRow((row) => {
      ++result.rows;
      for (const column of SELECTED_COLUMNS) {
        const bytes = row.bytes(column);
        if (bytes !== null) {
          ++result.fields;
          result.bytes += bytes.byteLength;
        }
      }
    });
  }

  using batch = parser.endBatch();
  batch.forEachRow((row) => {
    ++result.rows;
    for (const column of SELECTED_COLUMNS) {
      const bytes = row.bytes(column);
      if (bytes !== null) {
        ++result.fields;
        result.bytes += bytes.byteLength;
      }
    }
  });
  return result;
}

async function countSelectedFieldsWithRowsInto(): Promise<BenchResult> {
  using parser = new NativeCsvParser({ delimiter: DELIMITER });
  const rowsBuffer: string[][] = [];
  const result: BenchResult = { rows: 0, fields: 0, bytes: 0 };
  for await (const chunk of createReadStream(FILE, { highWaterMark: CHUNK_SIZE })) {
    using batch = parser.writeBatch(chunk as Buffer);
    countRowsIntoBatch(batch.rowsInto(rowsBuffer, SELECTED_COLUMNS), result);
  }

  using batch = parser.endBatch();
  countRowsIntoBatch(batch.rowsInto(rowsBuffer, SELECTED_COLUMNS), result);
  return result;
}

async function printSelectedFieldsWithRowView(): Promise<BenchResult> {
  using parser = new NativeCsvParser({ delimiter: DELIMITER });
  const output: string[] = [];
  const result: BenchResult = { rows: 0, fields: 0, bytes: 0 };
  for await (const chunk of createReadStream(FILE, { highWaterMark: CHUNK_SIZE })) {
    using batch = parser.writeBatch(chunk as Buffer);
    batch.forEachRow((row) => {
      if (output.length >= PRINT_ROWS) {
        return;
      }
      const fields = SELECTED_COLUMNS.map((column) => row.get(column) ?? '');
      output.push(fields.join('|'));
      ++result.rows;
      result.fields += fields.length;
      result.bytes += output.at(-1)?.length ?? 0;
    });
    if (output.length >= PRINT_ROWS) {
      return result;
    }
  }
  return result;
}

async function printSelectedFieldsWithRowsInto(): Promise<BenchResult> {
  using parser = new NativeCsvParser({ delimiter: DELIMITER });
  const rowsBuffer: string[][] = [];
  const output: string[] = [];
  const result: BenchResult = { rows: 0, fields: 0, bytes: 0 };
  for await (const chunk of createReadStream(FILE, { highWaterMark: CHUNK_SIZE })) {
    using batch = parser.writeBatch(chunk as Buffer);
    for (const row of batch.rowsInto(rowsBuffer, SELECTED_COLUMNS)) {
      const line = row.join('|');
      output.push(line);
      ++result.rows;
      result.fields += row.length;
      result.bytes += line.length;
      if (output.length >= PRINT_ROWS) {
        return result;
      }
    }
  }
  return result;
}

function countRowsIntoBatch(rows: string[][], result: BenchResult): void {
  result.rows += rows.length;
  for (const row of rows) {
    result.fields += row.length;
    for (const field of row) {
      result.bytes += field.length;
    }
  }
}
