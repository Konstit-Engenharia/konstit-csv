import {
  bench,
  summary,
} from 'mitata';
import assert from 'node:assert/strict';
import { csv } from '../src/index.ts';

// Compare the complete read, decode and materialization of the same 30-column
// Latin-1 corpus. Consume every field before the next batch reuses the arrays.
const file = 'corpus/large/example.csv';
const options = {
  chunkSize: Number(Bun.env['CSV_BENCH_CHUNK_SIZE'] ?? 1024 * 1024),
  delimiter: ';',
  encoding: 'latin1',
  fixedColumns: 30,
  reuseArrays: true,
} as const;
summary(() => {
  for (const path of [file, `${file}.zip`]) {
    bench(`${path} (${options.chunkSize} byte chunks)`, async () => {
      let rows = 0;
      let cells = 0;
      let chars = 0;
      for await (const batch of csv.rows(path, options)) {
        rows += batch.length;
        for (const row of batch) {
          cells += row.length;
          for (const value of row) {
            chars += value.length;
          }
        }
      }
      assert.equal(rows, 29_093_533);
      assert.equal(cells, rows * options.fixedColumns);
      assert.equal(chars, 4_162_040_956);
    }).baseline(path === file);
  }
});
