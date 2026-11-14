import {
  bench,
  summary,
} from 'mitata';
import { NativeCsvParser } from '../src/index.ts';
import type { CsvNativeFilterProgramEntry } from '../src/index.ts';

// Measures how chunk size affects filtered counts and projected materialization.
// Both sizes process the same bytes with one parser configuration per stream.
const ROW_COUNT = 8_192;
const columns = [0, 5, 12, 23] as const;
const program: readonly CsvNativeFilterProgramEntry[] = [
  { column: 5, values: Array.from({ length: 32 }, (_, index) => `S${index}`) },
  { column: 12, prefix: 'v12-' },
  { operator: 'all', operandCount: 2 },
];
let text = '';
let expectedChars = 0;
for (let index = 0; index < ROW_COUNT; ++index) {
  const row = Array.from({ length: 24 }, (_, column) => column === 5 ? `S${index % 64}` : `v${column}-é${index}`);
  text += `${row.join(';')}\n`;
  if (index % 64 < 32) {
    for (const column of columns) {
      expectedChars += row[column]?.length ?? 0;
    }
  }
}
const input = Buffer.from(text);

summary(() => {
  for (const chunkSize of [1_024, 1024 * 1024]) {
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < input.length; offset += chunkSize) {
      chunks.push(input.subarray(offset, offset + chunkSize));
    }
    // An empty final chunk also measures finishing a stream through the same path.
    chunks.push(Buffer.alloc(0));
    const finalIndex = chunks.length - 1;
    const label = `${chunkSize / 1024} KiB chunks`;
    bench(`prepared filtered count (${label})`, () => {
      using parser = new NativeCsvParser({ delimiter: ';', filterProgram: program });
      let rows = 0;
      for (const [index, chunk,] of chunks.entries()) {
        rows += parser.writeCount(chunk, index === finalIndex);
      }
      assertCount(rows);
    });
    bench(`prepared projected materialization (${label})`, () => {
      using parser = new NativeCsvParser({ delimiter: ';', columns, filterProgram: program });
      let rows = 0;
      let chars = 0;
      for (const [index, chunk,] of chunks.entries()) {
        using batch = parser.writeBatch(chunk, index === finalIndex);
        const materialized = batch.rows();
        rows += materialized.length;
        chars += consumeRows(materialized);
      }
      assertResult(rows, chars);
    });
  }
});

function consumeRows(rows: readonly string[][]): number {
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

function assertCount(rows: number): void {
  if (rows !== ROW_COUNT / 2) {
    throw new Error(`unexpected row count: ${rows}`);
  }
}

function assertResult(rows: number, chars: number): void {
  assertCount(rows);
  if (chars !== expectedChars) {
    throw new Error(`unexpected materialized character count: ${chars}`);
  }
}
