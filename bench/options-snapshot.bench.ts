import {
  bench,
  summary,
} from 'mitata';
import {
  createReadStream,
  rmSync,
} from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  csv,
  NativeCsvParser,
} from '../src/index.ts';
import type {
  CsvNativeFilter,
  CsvRow,
} from '../src/index.ts';

// Measures complete file operations with a fixed projection/filter configuration.
// Manual file streaming is the baseline. The chunk sizes expose the cost of
// crossing the stream and parser boundaries at different frequencies.
const ROW_COUNT = 8_192;
const COLUMN_COUNT = 24;
const columns = [0, 5, 12, 23] as const;
const values = Array.from({ length: 32 }, (_, index) => `S${index}`);
const filters: readonly CsvNativeFilter[] = [
  { column: 5, values },
  { column: 12, prefix: 'v12-' },
];
const where = csv.all(csv.column(5).isOneOf(values), csv.column(12).startsWith('v12-'));
const directory = await mkdtemp(join(tmpdir(), 'csv-options-bench-'));
process.once('exit', () => rmSync(directory, { recursive: true, force: true }));
let text = '';
let expectedChars = 0;
for (let index = 0; index < ROW_COUNT; ++index) {
  const row = Array.from({ length: COLUMN_COUNT }, (_, column) => column === 5 ? `S${index % 64}` : `v${column}-é${index}`);
  text += `${row.join(';')}\n`;
  if (index % 64 < 32) {
    for (const column of columns) {
      expectedChars += row[column]?.length ?? 0;
    }
  }
}

for (const encoding of ['utf8', 'latin1'] as const) {
  const path = join(directory, `${encoding}.csv`);
  await Bun.write(path, Buffer.from(text, encoding));
  for (const chunkSize of [1_024, 1024 * 1024]) {
    const label = `${encoding}, ${chunkSize / 1024} KiB chunks`;
    const options = { chunkSize, columns, delimiter: ';' as const, encoding, where };
    summary(() => {
      bench(`manual projected rows (${label})`, async () => {
        using parser = new NativeCsvParser({ delimiter: ';', encoding, columns, filters });
        let rows = 0;
        let chars = 0;
        for await (const chunk of createReadStream(path, { highWaterMark: chunkSize })) {
          using batch = parser.writeBatch(chunk as Buffer);
          const materialized = batch.rows();
          rows += materialized.length;
          chars += consumeRows(materialized);
        }
        using batch = parser.endBatch();
        const materialized = batch.rows();
        rows += materialized.length;
        chars += consumeRows(materialized);
        assertResult(rows, chars);
      });
      bench(`csv.rows prepared options (${label})`, async () => {
        let rows = 0;
        let chars = 0;
        for await (const batch of csv.rows(path, options)) {
          rows += batch.length;
          chars += consumeRows(batch);
        }
        assertResult(rows, chars);
      });
      bench(`csv.count prepared options (${label})`, async () => {
        const rows = await csv.count(path, options);
        if (rows !== ROW_COUNT / 2) {
          throw new Error(`unexpected row count: ${rows}`);
        }
      });
    });
  }
}

function consumeRows(rows: readonly CsvRow[]): number {
  let chars = 0;
  for (const row of rows) {
    if (row.length !== columns.length) {
      throw new Error(`unexpected projected column count: ${row.length}`);
    }
    for (const field of row) {
      chars += field.length;
    }
  }
  return chars;
}

function assertResult(rows: number, chars: number): void {
  if (rows !== ROW_COUNT / 2 || chars !== expectedChars) {
    throw new Error(`unexpected materialization result: ${rows} rows, ${chars} characters`);
  }
}
