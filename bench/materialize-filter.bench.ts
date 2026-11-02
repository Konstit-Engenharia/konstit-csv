import iconv from 'iconv-lite';
import {
  bench,
  summary,
} from 'mitata';
import {
  csv,
  parseCsvBuffer,
} from '../src/index.ts';

// Compares native predicate pushdown with the equivalent post-materialization
// JavaScript filter. Fixture construction stays outside the timed callbacks.
const LARGE_ROWS = Number(Bun.env['CSV_MATERIALIZE_FILTER_ROWS'] ?? 50_000);
const SMALL_ROWS = Number(Bun.env['CSV_MATERIALIZE_FILTER_SMALL_ROWS'] ?? 64);
for (const [name, value,] of [['CSV_MATERIALIZE_FILTER_ROWS', LARGE_ROWS], ['CSV_MATERIALIZE_FILTER_SMALL_ROWS', SMALL_ROWS]] as const) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}
const COLUMN_COUNT = 30;
const FILTER_COLUMNS = {
  status: 5,
  tail: 19,
} as const;
const PROJECTED_COLUMNS = [0, 2, 5, 19, 29] as const;
const nativeFilter = csv.all(
  csv.column(FILTER_COLUMNS.status).equals('02'),
  csv.column(FILTER_COLUMNS.tail).doesNotEqual('EX'),
);
const largeFixture = makeFixture(LARGE_ROWS);
const smallFixture = makeFixture(SMALL_ROWS);

console.log({
  columnCount: COLUMN_COUNT,
  filterColumns: FILTER_COLUMNS,
  largeBytes: largeFixture.input.byteLength,
  largeRows: LARGE_ROWS,
  projectedColumns: PROJECTED_COLUMNS,
  smallBytes: smallFixture.input.byteLength,
  smallRows: SMALL_ROWS,
});

summary(() => {
  registerAllColumnBenchmarks('large', largeFixture);
});
summary(() => {
  registerAllColumnBenchmarks('small', smallFixture);
});
summary(() => {
  bench('native filtered Latin-1 materialization (projected)', async () => {
    const rows = await csv.parse(largeFixture.input, {
      columns: PROJECTED_COLUMNS,
      delimiter: ';',
      encoding: 'iso88591',
      where: nativeFilter,
    });
    assertStats('native filtered Latin-1 materialization (projected)', consumeRows(rows), largeFixture.projected);
  });
  bench('JavaScript post-filter after full materialization (projected)', () => {
    const rows = parseCsvBuffer(largeFixture.input, { delimiter: ';', encoding: 'iso88591' });
    assertStats(
      'JavaScript post-filter after full materialization (projected)',
      consumePostFiltered(rows, PROJECTED_COLUMNS),
      largeFixture.projected,
    );
  });
});

interface MaterializeStats {
  cells: number;
  chars: number;
  rows: number;
}

interface Fixture {
  all: MaterializeStats;
  input: Buffer;
  projected: MaterializeStats;
}

function registerAllColumnBenchmarks(label: string, fixture: Fixture): void {
  bench(`native filtered Latin-1 materialization (${label}, all columns)`, async () => {
    const rows = await csv.parse(fixture.input, {
      delimiter: ';',
      encoding: 'iso88591',
      where: nativeFilter,
    });
    assertStats(`native filtered Latin-1 materialization (${label}, all columns)`, consumeRows(rows), fixture.all);
  });

  bench(`JavaScript post-filter after full materialization (${label}, all columns)`, () => {
    const rows = parseCsvBuffer(fixture.input, { delimiter: ';', encoding: 'iso88591' });
    assertStats(
      `JavaScript post-filter after full materialization (${label}, all columns)`,
      consumePostFiltered(rows),
      fixture.all,
    );
  });
}

function makeFixture(rows: number): Fixture {
  let text = '';
  const all: MaterializeStats = emptyStats();
  const projected: MaterializeStats = emptyStats();
  for (let rowIndex = 0; rowIndex < rows; ++rowIndex) {
    const values = makeRow(rowIndex);
    text += `${values.map(quoteField).join(';')}\n`;
    if (values[FILTER_COLUMNS.status] !== '02' || values[FILTER_COLUMNS.tail] === 'EX') {
      continue;
    }
    addStats(all, values);
    addStats(projected, PROJECTED_COLUMNS.map((column) => values[column] ?? ''));
  }
  return {
    all,
    input: iconv.encode(text, 'latin1'),
    projected,
  };
}

function makeRow(rowIndex: number): string[] {
  return Array.from({ length: COLUMN_COUNT }, (_, column) => {
    if (column === 0) {
      return String(rowIndex);
    }
    if (column === 1) {
      return `João ${rowIndex}`;
    }
    if (column === 2) {
      return rowIndex % 2 === 0 ? 'SP' : 'RJ';
    }
    if (column === 4) {
      return `São ${rowIndex}`;
    }
    if (column === FILTER_COLUMNS.status) {
      return rowIndex % 5 === 0 ? '02' : '01';
    }
    if (column === FILTER_COLUMNS.tail) {
      return rowIndex % 7 === 0 ? 'EX' : 'OK';
    }
    return `v${column}-${rowIndex}`;
  });
}

function consumeRows(rows: readonly string[][]): MaterializeStats {
  const stats = emptyStats();
  for (const row of rows) {
    addStats(stats, row);
  }
  return stats;
}

function consumePostFiltered(rows: readonly string[][], columns?: readonly number[]): MaterializeStats {
  const stats = emptyStats();
  for (const row of rows) {
    if (row[FILTER_COLUMNS.status] !== '02' || row[FILTER_COLUMNS.tail] === 'EX') {
      continue;
    }
    if (columns === undefined) {
      addStats(stats, row);
    } else {
      addStats(stats, columns.map((column) => row[column] ?? ''));
    }
  }
  return stats;
}

function addStats(stats: MaterializeStats, row: readonly string[]): void {
  ++stats.rows;
  stats.cells += row.length;
  for (const value of row) {
    stats.chars += value.length;
  }
}

function emptyStats(): MaterializeStats {
  return { cells: 0, chars: 0, rows: 0 };
}

function assertStats(name: string, actual: MaterializeStats, expected: MaterializeStats): void {
  if (actual.rows !== expected.rows || actual.cells !== expected.cells || actual.chars !== expected.chars) {
    throw new Error(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function quoteField(value: string): string {
  return /[;"\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
