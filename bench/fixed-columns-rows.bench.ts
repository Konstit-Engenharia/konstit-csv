import {
  bench,
  summary,
} from 'mitata';
import assert from 'node:assert/strict';
import {
  csv,
  type CsvRowsOptions,
} from '../src/index.ts';

// Measure how fixed-width row indexing affects end-to-end string materialization.
// Consume the field strings before the next batch can reuse the arrays.
const file = Bun.env['CSV_BENCH_FILE'] ?? 'corpus/bench/regression-smoke-25000-rows.csv';
const fixedColumns = Number(Bun.env['CSV_BENCH_FIXED_COLUMNS'] ?? 5);
const encoding = Bun.env['CSV_BENCH_ENCODING'] ?? 'utf8';
if (encoding !== 'utf8' && encoding !== 'latin1') {
  throw new Error('CSV_BENCH_ENCODING must be utf8 or latin1');
}
const options = {
  delimiter: Bun.env['CSV_BENCH_DELIMITER'] ?? ',',
  encoding,
  chunkSize: Number(Bun.env['CSV_BENCH_CHUNK_SIZE'] ?? 1024 * 1024),
  fixedColumns: Bun.env['CSV_BENCH_VALIDATE_WIDTH'] === '0' ? undefined : fixedColumns,
} satisfies CsvRowsOptions;

async function consume(options: CsvRowsOptions<readonly number[] | undefined>): Promise<[number, number, number]> {
  let rows = 0;
  let fields = 0;
  let characters = 0;
  for await (const batch of csv.rows(file, options)) {
    rows += batch.length;
    for (const row of batch) {
      fields += row.length;
      for (const field of row) {
        characters += field.length;
      }
    }
  }
  return [rows, fields, characters];
}

const projection = fixedColumns === 1 ? [0] : [fixedColumns - 1, 0];
for (const [name, columns,] of [['all', undefined], ['projected', projection]] as const) {
  const expected = await consume({ ...options, columns, fixedColumns: undefined });
  for (const reuseArrays of [false, true]) {
    summary(() => {
      bench(`${name} / ${reuseArrays ? 'reuse' : 'allocate'}`, async () => {
        assert.deepEqual(await consume({ ...options, columns, reuseArrays }), expected);
      });
    });
  }
}
