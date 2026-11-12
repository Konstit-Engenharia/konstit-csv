import { measure } from 'mitata';
import {
  createReadStream,
  statSync,
} from 'node:fs';
import {
  csv,
  NativeCsvParser,
  parseCsvFileProjected,
} from '../src/index.ts';
import { matchesBenchmarkName } from './benchmark-filter.ts';

// Measures whether native RE2 filtering avoids the row materialization cost of JavaScript RegExp filtering.
const FILE = Bun.env['CSV_BENCH_FILE'] ?? 'corpus/large/example.csv';
const CHUNK_SIZE = Number(Bun.env['CSV_BENCH_CHUNK_SIZE'] ?? 8 * 1024 * 1024);
const DELIMITER = Bun.env['CSV_BENCH_DELIMITER'] ?? ';';
const FILTER_COLUMN = Number(Bun.env['CSV_BENCH_FILTER_COLUMN'] ?? 19);
const FILTER_VALUES = (Bun.env['CSV_BENCH_FILTER_VALUES'] ?? 'SP,RJ')
  .split(',')
  .filter((value) => value.length > 0);
const FILTER_PREFIX = Bun.env['CSV_BENCH_FILTER_PREFIX'] ?? 'S';
const FILTER_REGEX = new RegExp(Bun.env['CSV_BENCH_FILTER_REGEX'] ?? '^(?:SP|RJ)$', 'u');
const SECOND_FILTER_COLUMN = Number(Bun.env['CSV_BENCH_SECOND_FILTER_COLUMN'] ?? 1);
const SECOND_FILTER_PREFIX = Bun.env['CSV_BENCH_SECOND_FILTER_PREFIX'] ?? 'A';
const SELECTED_COLUMNS = [FILTER_COLUMN];
const MULTIPLE_FILTER_COLUMNS = [FILTER_COLUMN, SECOND_FILTER_COLUMN];
const filterColumn = csv.column(FILTER_COLUMN);
const nativeFilterIn = filterColumn.isOneOf(FILTER_VALUES);
const nativeFilterStartsWith = filterColumn.startsWith(FILTER_PREFIX);
const nativeFilterRegex = filterColumn.hasMatch(FILTER_REGEX);
const nativeMultipleFilters = csv.all(
  nativeFilterIn,
  csv.column(SECOND_FILTER_COLUMN).startsWith(SECOND_FILTER_PREFIX),
);
const bytes = statSync(FILE).size;

const filterSet = new Set(FILTER_VALUES);
const measuredRows = new Map<string, number>();

const cases = [
  ['js materialized selected column filter in', () => countJsMaterializedSelectedIn()],
  ['js projected selected column filter in', () => countJsProjectedIn()],
  ['native filter in', () =>
    csv.count(FILE, {
      chunkSize: CHUNK_SIZE,
      delimiter: DELIMITER,
      where: nativeFilterIn,
    })],
  ['js materialized selected column startsWith', () => countJsMaterializedSelectedStartsWith()],
  ['js projected selected column startsWith', () => countJsProjectedStartsWith()],
  ['native filter startsWith', () =>
    csv.count(FILE, {
      chunkSize: CHUNK_SIZE,
      delimiter: DELIMITER,
      where: nativeFilterStartsWith,
    })],
  ['js materialized selected column regex', () => countJsMaterializedSelectedRegex()],
  ['js projected selected column regex', () => countJsProjectedRegex()],
  ['native filter regex', () =>
    csv.count(FILE, {
      chunkSize: CHUNK_SIZE,
      delimiter: DELIMITER,
      where: nativeFilterRegex,
    })],
  ['js projected multiple filters', () => countJsProjectedMultipleFilters()],
  ['native multiple filters', () =>
    csv.count(FILE, {
      chunkSize: CHUNK_SIZE,
      delimiter: DELIMITER,
      where: nativeMultipleFilters,
    })],
] as const;

console.log({
  file: FILE,
  bytes,
  chunkSize: CHUNK_SIZE,
  delimiter: DELIMITER,
  filterColumn: FILTER_COLUMN,
  filterValues: FILTER_VALUES,
  filterPrefix: FILTER_PREFIX,
  filterRegex: FILTER_REGEX.source,
  secondFilterColumn: SECOND_FILTER_COLUMN,
  secondFilterPrefix: SECOND_FILTER_PREFIX,
});

for (const [name, fn,] of cases) {
  if (!matchesBenchmarkName(name)) {
    continue;
  }

  let rows = 0;
  const stats = await measure(async () => {
    rows = await fn();
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
    rows,
    seconds,
    mibPerSecond,
  });
  measuredRows.set(name, rows);
}

const jsMultipleRows = measuredRows.get('js projected multiple filters');
const nativeMultipleRows = measuredRows.get('native multiple filters');
if (jsMultipleRows !== undefined && nativeMultipleRows !== undefined && jsMultipleRows !== nativeMultipleRows) {
  throw new Error(`multiple filter benchmark result mismatch: JavaScript=${jsMultipleRows}, native=${nativeMultipleRows}`);
}

const jsRegexRows = measuredRows.get('js projected selected column regex');
const nativeRegexRows = measuredRows.get('native filter regex');
if (jsRegexRows !== undefined && nativeRegexRows !== undefined && jsRegexRows !== nativeRegexRows) {
  throw new Error(`regex benchmark result mismatch: JavaScript=${jsRegexRows}, native=${nativeRegexRows}`);
}

async function countJsMaterializedSelectedIn(): Promise<number> {
  return countJsMaterializedSelected((value) => filterSet.has(value));
}

async function countJsMaterializedSelectedStartsWith(): Promise<number> {
  return countJsMaterializedSelected((value) => value.startsWith(FILTER_PREFIX));
}

async function countJsMaterializedSelectedRegex(): Promise<number> {
  return countJsMaterializedSelected((value) => FILTER_REGEX.test(value));
}

async function countJsMaterializedSelected(predicate: (value: string) => boolean): Promise<number> {
  using parser = new NativeCsvParser({ delimiter: DELIMITER });
  const rowsBuffer: string[][] = [];
  let rows = 0;
  for await (const chunk of createReadStream(FILE, { highWaterMark: CHUNK_SIZE })) {
    using batch = parser.writeBatch(chunk as Buffer);
    rows += countRowsMatching(batch.rowsInto(rowsBuffer, SELECTED_COLUMNS), predicate);
  }
  using batch = parser.endBatch();
  rows += countRowsMatching(batch.rowsInto(rowsBuffer, SELECTED_COLUMNS), predicate);
  return rows;
}

async function countJsProjectedIn(): Promise<number> {
  return countJsProjected((value) => filterSet.has(value));
}

async function countJsProjectedStartsWith(): Promise<number> {
  return countJsProjected((value) => value.startsWith(FILTER_PREFIX));
}

async function countJsProjectedRegex(): Promise<number> {
  return countJsProjected((value) => FILTER_REGEX.test(value));
}

async function countJsProjectedMultipleFilters(): Promise<number> {
  let rows = 0;
  for await (
    const batch of parseCsvFileProjected(FILE, {
      chunkSize: CHUNK_SIZE,
      delimiter: DELIMITER,
      columns: MULTIPLE_FILTER_COLUMNS,
    })
  ) {
    try {
      for (const row of batch) {
        if (filterSet.has(row[0] ?? '') && (row[1] ?? '').startsWith(SECOND_FILTER_PREFIX)) {
          ++rows;
        }
      }
    } finally {
      for (const row of batch) {
        row.length = 0;
      }
    }
  }
  return rows;
}

async function countJsProjected(predicate: (value: string) => boolean): Promise<number> {
  let rows = 0;
  for await (
    const batch of parseCsvFileProjected(FILE, {
      chunkSize: CHUNK_SIZE,
      delimiter: DELIMITER,
      columns: SELECTED_COLUMNS,
    })
  ) {
    try {
      rows += countRowsMatching(batch, predicate);
    } finally {
      for (const row of batch) {
        row.length = 0;
      }
    }
  }
  return rows;
}

function countRowsMatching(rows: readonly string[][], predicate: (value: string) => boolean): number {
  let count = 0;
  for (const row of rows) {
    if (predicate(row[0] ?? '')) {
      ++count;
    }
  }
  return count;
}
