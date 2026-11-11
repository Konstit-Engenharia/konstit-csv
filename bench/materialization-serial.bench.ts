import { measure } from 'mitata';
import {
  createReadStream,
  statSync,
} from 'node:fs';
import {
  csv,
  type CsvRowView,
  NativeCsvParser,
} from '../src/index.ts';
import { matchesBenchmarkName } from './benchmark-filter.ts';
import {
  CHUNK_SIZE,
  DELIMITER,
  FILE,
  SELECTED_COLUMNS,
} from './example/config.ts';

interface BenchResult {
  rows: number;
  fields: number;
  bytes: number;
}

const PROJECTED_COLUMNS = SELECTED_COLUMNS.map((_, index) => index);
const BYTES = statSync(FILE).size;
const CASES = [
  ['csv.rows projected selected columns', () => consumeMaterializedRowsFromApi()],
  ['native projected rowsInto(reused js arrays)', () => consumeMaterializedRowsFromRowsInto()],
  ['csv.withColumnarBatches projected selected columns(scanColumns)', () => consumeScannedColumns()],
  ['csv.withColumnarBatches projected selected columns(ranges)', () => consumeColumnarBatchRanges()],
  ['csv.withColumnarBatches projected selected columns(bytes)', () => consumeColumnarBatchBytes()],
  ['csv.withRowViews projected selected columns(bytes)', () => consumeProjectedRowViewsBytes()],
  ['csv.withRowViews projected selected columns(strings)', () => consumeProjectedRowViewsStrings()],
] as const;

if (SELECTED_COLUMNS.length === 0) {
  throw new Error('CSV_BENCH_COLUMNS must select at least one column');
}

console.log({
  file: FILE,
  bytes: BYTES,
  chunkSize: CHUNK_SIZE,
  delimiter: DELIMITER,
  selectedColumns: SELECTED_COLUMNS,
  projectedColumns: PROJECTED_COLUMNS,
});

for (const [name, fn,] of CASES) {
  if (!matchesBenchmarkName(name)) {
    continue;
  }

  let result: BenchResult = { rows: 0, fields: 0, bytes: 0 };
  const stats = await measure(async () => {
    result = await fn();
    assertResult(name, result);
  }, {
    min_samples: 1,
    max_samples: 1,
    min_cpu_time: 0,
    warmup_samples: 0,
  });

  const seconds = stats.avg / 1e9;
  const mibPerSecond = BYTES / 1024 / 1024 / seconds;

  console.log({
    name,
    ...result,
    seconds,
    mibPerSecond,
  });
}

async function consumeMaterializedRowsFromApi(): Promise<BenchResult> {
  const result = emptyResult();
  for await (
    const rows of csv.rows(FILE, {
      chunkSize: CHUNK_SIZE,
      delimiter: DELIMITER,
      columns: SELECTED_COLUMNS,
    })
  ) {
    consumeMaterializedRows(rows, result);
  }
  return result;
}

async function consumeMaterializedRowsFromRowsInto(): Promise<BenchResult> {
  using parser = new NativeCsvParser({ delimiter: DELIMITER });
  const rowsBuffer: string[][] = [];
  const result = emptyResult();
  for await (const chunk of createReadStream(FILE, { highWaterMark: CHUNK_SIZE })) {
    using batch = parser.writeProjectedBatch(chunk as Buffer, { selectedColumns: SELECTED_COLUMNS });
    consumeMaterializedRows(batch.rowsInto(rowsBuffer), result);
  }

  using batch = parser.endProjectedBatch({ selectedColumns: SELECTED_COLUMNS });
  consumeMaterializedRows(batch.rowsInto(rowsBuffer), result);
  return result;
}

async function consumeProjectedRowViewsBytes(): Promise<BenchResult> {
  const result = emptyResult();
  await withProjectedRowViews((row) => {
    ++result.rows;
    for (const column of row.selectedColumns) {
      const bytes = row.fieldBytes(column);
      if (bytes !== null) {
        ++result.fields;
        result.bytes += bytes.byteLength;
      }
    }
  });
  return result;
}

async function consumeColumnarBatchBytes(): Promise<BenchResult> {
  const result = emptyResult();
  await csv.withColumnarBatches(
    FILE,
    {
      chunkSize: CHUNK_SIZE,
      columns: SELECTED_COLUMNS,
      delimiter: DELIMITER,
    },
    (batch) => {
      result.rows += batch.rowCount;
      for (let rowIndex = 0; rowIndex < batch.rowCount; ++rowIndex) {
        const fieldCount = batch.rowFieldCount(rowIndex);
        result.fields += fieldCount;
        for (let columnIndex = 0; columnIndex < fieldCount; ++columnIndex) {
          const bytes = batch.fieldBytes(rowIndex, columnIndex);
          if (bytes !== null) {
            result.bytes += bytes.byteLength;
          }
        }
      }
    },
  );
  return result;
}

async function consumeColumnarBatchRanges(): Promise<BenchResult> {
  const result = emptyResult();
  await csv.withColumnarBatches(
    FILE,
    {
      chunkSize: CHUNK_SIZE,
      columns: SELECTED_COLUMNS,
      delimiter: DELIMITER,
    },
    (batch) => {
      result.rows += batch.rowCount;
      for (let columnIndex = 0; columnIndex < PROJECTED_COLUMNS.length; ++columnIndex) {
        batch.forEachColumnRange(columnIndex, (_rowIndex, start, end) => {
          ++result.fields;
          result.bytes += end - start;
        });
      }
    },
  );
  return result;
}

async function consumeScannedColumns(): Promise<BenchResult> {
  const result = emptyResult();
  await csv.withColumnarBatches(
    FILE,
    {
      chunkSize: CHUNK_SIZE,
      columns: SELECTED_COLUMNS,
      delimiter: DELIMITER,
    },
    (batch) => {
      result.rows += batch.rowCount;
      batch.scanColumns(PROJECTED_COLUMNS, (_rowIndex, ranges) => {
        for (let columnIndex = 0; columnIndex < PROJECTED_COLUMNS.length; ++columnIndex) {
          const rangeIndex = columnIndex * 2;
          const start = ranges[rangeIndex] ?? -1;
          const end = ranges[rangeIndex + 1] ?? -1;
          if (start !== -1 && end !== -1) {
            ++result.fields;
            result.bytes += end - start;
          }
        }
      });
    },
  );
  return result;
}

async function consumeProjectedRowViewsStrings(): Promise<BenchResult> {
  const result = emptyResult();
  await withProjectedRowViews((row) => {
    ++result.rows;
    for (const column of row.selectedColumns) {
      const value = row.fieldString(column);
      if (value !== null) {
        ++result.fields;
        result.bytes += value.length;
      }
    }
  });
  return result;
}

async function withProjectedRowViews(callback: (row: CsvRowView<typeof SELECTED_COLUMNS>) => void): Promise<void> {
  // Future high-level row-view integration belongs here if API shape changes.
  await csv.withRowViews(
    FILE,
    {
      chunkSize: CHUNK_SIZE,
      delimiter: DELIMITER,
      columns: SELECTED_COLUMNS,
    },
    callback,
  );
}

function consumeMaterializedRows(rows: string[][], result: BenchResult): void {
  result.rows += rows.length;
  for (const row of rows) {
    result.fields += row.length;
    for (const field of row) {
      result.bytes += field.length;
    }
  }
}

function emptyResult(): BenchResult {
  return { rows: 0, fields: 0, bytes: 0 };
}

function assertResult(name: string, result: BenchResult): void {
  if (result.rows === 0) {
    throw new Error(`${name}: zero rows`);
  }
  if (result.fields === 0) {
    throw new Error(`${name}: zero fields`);
  }
  if (result.bytes === 0) {
    throw new Error(`${name}: zero bytes`);
  }
}
