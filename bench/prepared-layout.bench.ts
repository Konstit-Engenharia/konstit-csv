import {
  bench,
  summary,
} from 'mitata';
import { strict as assert } from 'node:assert';
import {
  type CsvNativeFilter,
  NativeCsvParser,
} from '../src/index.ts';
import { matchesBenchmarkName } from './benchmark-filter.ts';

// Compares prepared-parser layouts across native builds without filesystem I/O or
// string materialization in the timed operation. Run a group with, for example:
// bun run bench -- prepared-layout.bench.ts --filter '^prepared/selection/'
// CSV_NATIVE_LIBRARY_PATH selects the native build used for the same workloads.
// The parse cases reuse one prepared parser and include stream reset, parsing,
// batch ownership, and row-count consumption. The setup group measures creation.
const NORMAL_CHUNKS = 24;
const ROWS_PER_CHUNK = 1_024;
const LONG_ROWS = 200;
const LONG_PREFIX_BYTES = 16 * 1024;
const LONG_FIELD_BYTES = 48 * 1024;
const WIDE_ROWS = 2_048;
const WIDE_COLUMNS = 256;
const PREDICATE_SUFFIX = 'p'.repeat(124);
const MATCH_VALUE = `keep:${PREDICATE_SUFFIX}`;
const REJECT_VALUE = `drop:${PREDICATE_SUFFIX}`;
const SELECTED_COLUMNS = [0, 5, 11] as const;

type Selectivity = 'sparse' | 'dense' | 'alternating';
type OutputMode = 'batch' | 'count';

interface Fixture {
  readonly chunks: readonly Buffer[];
  readonly rowCount: number;
  readonly matchingRows: readonly number[];
  row(row: number): readonly string[];
}

// Sparse/dense chunks share row widths and chunk boundaries. Alternating chunks
// switch between those distributions so estimates must adapt to selectivity.
summary(() => {
  for (const selectivity of ['sparse', 'dense', 'alternating'] as const) {
    const name = `prepared/selection/${selectivity}`;
    const controlName = 'prepared/selection/unfiltered-control';
    if (!matchesBenchmarkName(name) && !(selectivity === 'dense' && matchesBenchmarkName(controlName))) {
      continue;
    }
    const fixture = makeNormalFixture(selectivity);
    registerParse(name, fixture, SELECTED_COLUMNS, [{ column: 3, value: MATCH_VALUE }]);
    if (selectivity === 'dense') {
      registerParse(controlName, fixture, SELECTED_COLUMNS);
    }
  }
});

// A completed 16 KiB selected field precedes a 48 KiB selected field that spans
// small chunks. A single-chunk control isolates repeated completed-prefix carry.
summary(() => {
  for (const selectivity of ['sparse', 'dense'] as const) {
    const prefix = `prepared/chunks/${selectivity}`;
    const cases = [['4KiB', 4 * 1024], ['single-chunk', undefined]] as const;
    if (!cases.some(([name,]) => matchesBenchmarkName(`${prefix}/${name}`))) {
      continue;
    }
    const fixture = makeLongFixture(selectivity);
    const input = fixture.chunks[0];
    assert.ok(input);
    for (const [name, chunkSize,] of cases) {
      registerParse(
        `${prefix}/${name}`,
        { ...fixture, chunks: chunkSize === undefined ? fixture.chunks : splitChunks(input, chunkSize) },
        [0, 1, 4],
        [{ column: 3, value: MATCH_VALUE }],
      );
    }
  }
});

// The same long, unescaped predicate is either filter-only or also projected.
// Equality/prefix and count controls distinguish predicate scratch work from
// selected-field storage and from output-batch allocation.
summary(() => {
  for (const selectivity of ['sparse', 'dense'] as const) {
    const cases: readonly [string, readonly number[] | undefined, readonly CsvNativeFilter[], OutputMode][] = [
      [`${selectivity}/filter-only/equals`, SELECTED_COLUMNS, [{ column: 3, value: MATCH_VALUE }], 'batch'],
      [`${selectivity}/selected/equals`, [0, 3, 5, 11], [{ column: 3, value: MATCH_VALUE }], 'batch'],
      [`${selectivity}/filter-only/prefix`, SELECTED_COLUMNS, [{ column: 3, prefix: 'keep:' }], 'batch'],
      [`${selectivity}/selected/prefix`, [0, 3, 5, 11], [{ column: 3, prefix: 'keep:' }], 'batch'],
    ];
    const extraCases: readonly [string, readonly number[] | undefined, readonly CsvNativeFilter[], OutputMode][] = selectivity === 'sparse'
      ? [
        ['sparse/filter-only/bytes-equals', SELECTED_COLUMNS, [{ column: 3, value: Buffer.from(MATCH_VALUE) }], 'batch'],
        ['sparse/count/equals', undefined, [{ column: 3, value: MATCH_VALUE }], 'count'],
        ['sparse/count/prefix', undefined, [{ column: 3, prefix: 'keep:' }], 'count'],
      ]
      : [];
    if (![...cases, ...extraCases].some(([name,]) => matchesBenchmarkName(`prepared/predicates/${name}`))) {
      continue;
    }
    const fixture = makeNormalFixture(selectivity);
    for (const [name, columns, filters, mode,] of [...cases, ...extraCases]) {
      registerParse(`prepared/predicates/${name}`, fixture, columns, filters, mode);
    }
  }
});

// Source-order projection is the baseline for a reordered projection of the same
// width; the narrow control shows the cost of visiting many selected columns.
summary(() => {
  const ordered = Array.from({ length: WIDE_COLUMNS }, (_, column) => column);
  const cases = [
    ['narrow-control', [WIDE_COLUMNS - 1, 0, WIDE_COLUMNS / 2]],
    ['ordered-wide', ordered],
    ['reordered-wide', ordered.toReversed()],
  ] as const;
  if (!cases.some(([name,]) => matchesBenchmarkName(`prepared/projection/${name}`))) {
    return;
  }
  const fixture = makeWideFixture();
  for (const [name, columns,] of cases) {
    registerParse(`prepared/projection/${name}`, fixture, columns);
  }
});

// Isolates construction, projection normalization, native preparation, and
// disposal. Equal-width ordered/reordered controls expose setup complexity.
summary(() => {
  for (const width of [16, 256, 1_024]) {
    const ordered = Array.from({ length: width }, (_, column) => column);
    for (const [order, columns,] of [['ordered', ordered], ['reordered', ordered.toReversed()]] as const) {
      const name = `prepared/setup/${width}/${order}`;
      if (!matchesBenchmarkName(name)) {
        continue;
      }
      bench(name, () => {
        using parser = new NativeCsvParser({ delimiter: ';', columns });
        return parser.closed;
      });
    }
  }
});

function registerParse(
  name: string,
  fixture: Fixture,
  columns: readonly number[] | undefined,
  filters?: readonly CsvNativeFilter[],
  mode: OutputMode = 'batch',
): void {
  if (!matchesBenchmarkName(name)) {
    return;
  }
  const options = { delimiter: ';', columns, filters };
  const expectedRows = filters === undefined ? fixture.rowCount : fixture.matchingRows.length;
  validateOutput(name, fixture, columns, filters, mode);
  console.info({
    benchmark: name,
    bytes: fixture.chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
    chunks: fixture.chunks.length,
    inputRows: fixture.rowCount,
    outputRows: expectedRows,
    projectedColumns: columns?.length ?? 0,
  });
  bench(name, function*() {
    using parser = new NativeCsvParser(options);
    yield () => {
      parser.reset();
      let rows = 0;
      if (mode === 'count') {
        for (const chunk of fixture.chunks) {
          rows += parser.writeCount(chunk);
        }
        rows += parser.endCount();
      } else {
        for (const chunk of fixture.chunks) {
          using batch = parser.writeBatch(chunk);
          rows += batch.rowCount;
        }
        using batch = parser.endBatch();
        rows += batch.rowCount;
      }
      if (rows !== expectedRows) {
        throw new Error(`${name}: expected ${expectedRows} rows, received ${rows}`);
      }
      return rows;
    };
  });
}

function validateOutput(
  name: string,
  fixture: Fixture,
  columns: readonly number[] | undefined,
  filters: readonly CsvNativeFilter[] | undefined,
  mode: OutputMode,
): void {
  const rowIndexes = filters === undefined
    ? Array.from({ length: fixture.rowCount }, (_, row) => row)
    : fixture.matchingRows;
  using parser = new NativeCsvParser({ delimiter: ';', columns, filters });
  let rowIndex = 0;
  for (let chunkIndex = 0; chunkIndex <= fixture.chunks.length; ++chunkIndex) {
    const chunk = fixture.chunks[chunkIndex] ?? Buffer.alloc(0);
    const final = chunkIndex === fixture.chunks.length;
    if (mode === 'count') {
      rowIndex += parser.writeCount(chunk, final);
      continue;
    }
    using batch = parser.writeBatch(chunk, final);
    for (const actual of batch.rows()) {
      const sourceRow = rowIndexes[rowIndex++];
      assert.ok(sourceRow !== undefined, `${name}: unexpected output row`);
      const expected = fixture.row(sourceRow);
      assert.deepEqual(actual, columns?.map((column) => expected[column]) ?? expected, `${name}: row ${sourceRow}`);
    }
  }
  assert.equal(rowIndex, rowIndexes.length, `${name}: output row count`);
}

function makeNormalFixture(selectivity: Selectivity): Fixture {
  const matchingRows: number[] = [];
  const chunks: Buffer[] = [];
  const rowCount = NORMAL_CHUNKS * ROWS_PER_CHUNK;
  const row = (index: number): readonly string[] => {
    const accepted = matchesSelectivity(index, selectivity);
    return Array.from({ length: 12 }, (_, column) => {
      if (column === 0) {
        return index.toString().padStart(6, '0');
      }
      return column === 3 ? accepted ? MATCH_VALUE : REJECT_VALUE : `c${column.toString().padStart(2, '0')}-payload`;
    });
  };
  for (let chunk = 0; chunk < NORMAL_CHUNKS; ++chunk) {
    let text = '';
    for (let offset = 0; offset < ROWS_PER_CHUNK; ++offset) {
      const index = chunk * ROWS_PER_CHUNK + offset;
      text += `${row(index).join(';')}\n`;
      if (matchesSelectivity(index, selectivity)) {
        matchingRows.push(index);
      }
    }
    chunks.push(Buffer.from(text));
  }
  return { chunks, rowCount, matchingRows, row };
}

function makeLongFixture(selectivity: 'sparse' | 'dense'): Fixture {
  const prefix = 'x'.repeat(LONG_PREFIX_BYTES);
  const payload = 'y'.repeat(LONG_FIELD_BYTES);
  const matchingRows: number[] = [];
  const row = (index: number): readonly string[] => [
    prefix,
    payload,
    index.toString(),
    matchesSelectivity(index, selectivity) ? MATCH_VALUE : REJECT_VALUE,
    'selected-tail',
  ];
  let text = '';
  for (let index = 0; index < LONG_ROWS; ++index) {
    text += `${row(index).join(';')}\n`;
    if (matchesSelectivity(index, selectivity)) {
      matchingRows.push(index);
    }
  }
  return { chunks: [Buffer.from(text)], rowCount: LONG_ROWS, matchingRows, row };
}

function makeWideFixture(): Fixture {
  const fields = Array.from({ length: WIDE_COLUMNS }, (_, column) => `v${column.toString().padStart(3, '0')}`);
  const text = `${fields.join(';')}\n`.repeat(WIDE_ROWS);
  return {
    chunks: splitChunks(Buffer.from(text), 256 * 1024),
    rowCount: WIDE_ROWS,
    matchingRows: [],
    row: () => fields,
  };
}

function matchesSelectivity(row: number, selectivity: Selectivity): boolean {
  const sparseMatch = row % ROWS_PER_CHUNK % 100 === 0;
  switch (selectivity) {
    case 'sparse':
      return sparseMatch;
    case 'dense':
      return !sparseMatch;
    case 'alternating':
      return Math.floor(row / ROWS_PER_CHUNK) % 2 === 0 ? !sparseMatch : sparseMatch;
  }
}

function splitChunks(input: Buffer, chunkSize: number): readonly Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < input.byteLength; offset += chunkSize) {
    chunks.push(input.subarray(offset, offset + chunkSize));
  }
  return chunks;
}
