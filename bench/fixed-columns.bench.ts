import {
  bench,
  summary,
} from 'mitata';
import assert from 'node:assert/strict';
import {
  createReadStream,
  statSync,
} from 'node:fs';
import { prepareCsvFileInput } from '../src/file-stream.ts';
import {
  csv,
  NativeCsvParser,
} from '../src/index.ts';

// Measures the supported fixed-column materialization path against the general parser baseline.
const GENERATED_ROWS = Number(Bun.env['CSV_BENCH_GENERATED_ROWS'] ?? 5_000_000);
const FILE = Bun.env['CSV_BENCH_FILE'] ?? await generateFixture(GENERATED_ROWS);
const CHUNK_SIZE = Number(Bun.env['CSV_BENCH_CHUNK_SIZE'] ?? 8 * 1024 * 1024);
const DELIMITER = Bun.env['CSV_BENCH_DELIMITER'] ?? ';';
const FIXED_COLUMNS = Number(Bun.env['CSV_BENCH_FIXED_COLUMNS'] ?? await inferFixedColumns(FILE, DELIMITER));
const bytes = statSync(FILE).size;

const cases = [
  ['native batch parser', () => countRows(false)],
  ['native fixed-column batch parser', () => countRows(true)],
] as const;

console.log({
  file: FILE,
  bytes,
  chunkSize: CHUNK_SIZE,
  delimiter: DELIMITER,
  fixedColumns: FIXED_COLUMNS,
});

summary(async () => {
  for (const [name, fn,] of cases) {
    bench(name, async () => await fn());
  }
});

// Compare end-to-end counting with the same file reader, chunk size and physical width check.
const options = { delimiter: DELIMITER, fixedColumns: FIXED_COLUMNS, chunkSize: CHUNK_SIZE };
async function countViaBatches(): Promise<number> {
  await using input = await prepareCsvFileInput(FILE, options, 'count');
  using parser = new NativeCsvParser({ ...options, encoding: input.parserEncoding, delimiter: input.delimiter });
  let rows = 0;
  for await (const chunk of input.chunks()) {
    using batch = parser.writeBatch(chunk);
    rows += batch.rowCount;
  }
  using last = parser.endBatch();
  return rows + last.rowCount;
}

const expected = Bun.env['CSV_BENCH_FILE'] === undefined ? GENERATED_ROWS : await countViaBatches();
summary(() => {
  bench('fixed count / batch rowCount', async () => assert.equal(await countViaBatches(), expected));
  bench('fixed count / csv.count', async () => assert.equal(await csv.count(FILE, options), expected));
});

async function countRows(fixedColumns: boolean): Promise<number> {
  using parser = new NativeCsvParser({
    delimiter: DELIMITER,
    fixedColumns: fixedColumns ? FIXED_COLUMNS : undefined,
  });
  let rows = 0;
  for await (const chunk of createReadStream(FILE, { highWaterMark: CHUNK_SIZE })) {
    using batch = parser.writeBatch(chunk as Buffer);
    rows += batch.rowCount;
  }
  using batch = parser.endBatch();
  rows += batch.rowCount;
  return rows;
}

async function inferFixedColumns(path: string, delimiter: string): Promise<number> {
  const file = Bun.file(path);
  const reader = file.stream().getReader();
  const decoder = new TextDecoder();
  let line = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const text = decoder.decode(value, { stream: true });
      const newline = text.indexOf('\n');
      if (newline >= 0) {
        line += text.slice(0, newline).replace(/\r$/, '');
        break;
      }
      line += text;
    }
  } finally {
    reader.releaseLock();
  }
  return countCsvColumns(line, delimiter);
}

async function generateFixture(rows: number): Promise<string> {
  const path = `/tmp/csv-fixed-columns-${rows}.csv`;
  const writer = Bun.file(path).writer();
  for (let row = 0; row < rows; ++row) {
    void writer.write(`${row};Ana${row % 10};SP\n`);
  }
  await writer.end();
  return path;
}

function countCsvColumns(row: string, delimiter: string): number {
  if (row.length === 0) {
    return 0;
  }
  let columns = 1;
  let inQuotes = false;
  for (let index = 0; index < row.length; ++index) {
    const char = row[index];
    if (char === '"') {
      if (inQuotes && row[index + 1] === '"') {
        ++index;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (!inQuotes && char === delimiter) {
      ++columns;
    }
  }
  return columns;
}
