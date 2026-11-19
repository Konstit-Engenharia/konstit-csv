import {
  bench,
  summary,
} from 'mitata';
import assert from 'node:assert/strict';
import { open } from 'node:fs/promises';
import { readCsvFileChunks } from '../src/file-stream.ts';
import { readGzipFileChunks } from '../src/gzip-reader.ts';
import { latin1Rows } from '../src/latin1-rows.ts';
import {
  DEFAULT_CHUNK_SIZE,
  latin1RowsParser,
} from '../src/native.ts';
import { countFileChunks } from '../src/parser.ts';

const variants = ['bun', 'native-sync', 'native-read-ahead'] as const;
const workloads = ['count', 'rows'] as const;
const path = Bun.env['CSV_BENCH_GZIP_FILE'] ?? 'corpus/large/example.csv.gz';
const chunkSize = Number(Bun.env['CSV_BENCH_CHUNK_SIZE'] ?? DEFAULT_CHUNK_SIZE);
const expectedRows = Number(Bun.env['CSV_BENCH_GZIP_ROWS'] ?? 29_093_533);
const expectedCharacters = Number(Bun.env['CSV_BENCH_GZIP_CHARS'] ?? 4_162_040_956);
const parserOptions = { delimiter: ';', encoding: 'latin1', fixedColumns: 30 } as const;

// Use the same CSV parsers for all variants. The synchronous native variant
// isolates the effect of overlapping the next inflate with the current parse.
async function scan(variant: typeof variants[number], workload: typeof workloads[number]): Promise<void> {
  let chunks: AsyncIterable<Uint8Array>;
  switch (variant) {
    case 'bun':
      chunks = Bun.file(path).stream().pipeThrough(new DecompressionStream('gzip', { highWaterMark: chunkSize }));
      break;
    case 'native-sync':
      chunks = readSynchronousGzip(path);
      break;
    case 'native-read-ahead':
      chunks = readCsvFileChunks(path, { compression: 'gzip', chunkSize }, workload === 'rows' ? 'read-ahead' : 'count');
      break;
  }
  if (workload === 'count') {
    const count = await countFileChunks({
      ...parserOptions,
      parserEncoding: parserOptions.encoding,
      chunks: () => chunks,
      [Symbol.asyncDispose]: () => Promise.resolve(),
    }, parserOptions);
    assert.equal(count, expectedRows);
    return;
  }

  let rows = 0;
  let cells = 0;
  let characters = 0;
  for await (
    const batch of latin1Rows(chunks, parserOptions.delimiter, undefined, undefined, latin1RowsParser(parserOptions.fixedColumns), [])
  ) {
    rows += batch.length;
    for (const row of batch) {
      cells += row.length;
      for (const field of row) {
        characters += field.length;
      }
    }
  }
  assert.equal(rows, expectedRows);
  assert.equal(cells, expectedRows * parserOptions.fixedColumns);
  assert.equal(characters, expectedCharacters);
}

async function* readSynchronousGzip(path: string): AsyncGenerator<Uint8Array, void> {
  await using file = await open(path, 'r');
  yield* readGzipFileChunks(file.fd, chunkSize, true, false);
}

if (import.meta.main) {
  // A single complete scan for runs in fresh processes.
  const variant = variants.find((value) => value === Bun.argv[2]);
  const workload = workloads.find((value) => value === Bun.argv[3]);
  assert(variant !== undefined && workload !== undefined, 'expected a gzip variant and workload');
  await scan(variant, workload);
} else {
  for (const workload of workloads) {
    summary(() => {
      for (const variant of variants) {
        bench(`gzip ${workload}: ${variant} (${chunkSize} byte chunks)`, () => scan(variant, workload)).baseline(variant === 'bun');
      }
    });
  }
}
