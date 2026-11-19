import {
  afterAll,
  beforeAll,
  expect,
  test,
} from 'bun:test';
import { rejects } from 'node:assert/strict';
import {
  mkdtemp,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  csv,
  type CsvBatchesOptions,
  type CsvRowsOptions,
  type CsvShardingOptions,
  NativeCsvParser,
  type NativeCsvParserOptions,
  type NativeCsvRawRecordBatch,
  parseCsvFileProjected,
} from '../src/index.ts';

const literal = { delimiter: '\t', quote: false, recordDelimiter: '\n' } as const;
const raw = { ...literal, output: 'raw-records' } as const;
const brazil = csv.column(1).isOneOf(['br', 'BR', 'Br', 'bR']);
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'csv-literal-records-'));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

test('literal TSV streams gzip through the ordinary rows, count, and field-batch APIs', async () => {
  const path = join(directory, 'literal.tsv.gz');
  await Bun.write(path, Bun.gzipSync('pt\tbr\t"Rua A\r\npt\tBR\tRua B\r\n'));
  const options = { ...literal, compression: 'gzip', where: brazil } as const;
  const expected = [['pt', 'br', '"Rua A\r'], ['pt', 'BR', 'Rua B\r']];
  const rows = [];
  for await (const batch of csv.rows(path, options)) {
    rows.push(...batch);
  }
  expect(rows).toEqual(expected);
  const fields = [];
  for await (using batch of csv.batches(path, { ...options, output: 'fields' })) {
    fields.push(...batch.rows());
  }
  expect(fields).toEqual(expected);
  expect(await csv.count(path, options)).toBe(2);
});

test('raw records retain malformed text bytes, line endings, and physical widths through gzip and split chunks', async () => {
  const path = join(directory, 'mixed.tsv.gz');
  const plain = join(directory, 'mixed.tsv');
  const accepted = [
    Buffer.from('pt\tbr\t"Rua A\r\n'),
    Buffer.from('pt\tBR\n'),
    Buffer.from('pt\tBr\tRua \xff\x00\x80\textra\n', 'latin1'),
    Buffer.from(`pt\tbR\t${'x'.repeat(2 * 1024 * 1024)}\r\n`),
    Buffer.from('pt\tbr\t'),
  ];
  const source = Buffer.concat([
    Buffer.from('skip\tbr\tignore\npt\tar\t"unclosed\r\n'),
    ...accepted.slice(0, 3),
    Buffer.from('br\n\npt\tbr\r\n'),
    ...accepted.slice(3),
  ]);
  await Bun.write(path, Bun.gzipSync(source));
  await Bun.write(plain, source);
  for (const [file, compression, chunkSize,] of [[path, 'gzip', 4096], [plain, 'none', 101]] as const) {
    const bytes: Buffer[] = [];
    const counts: number[] = [];
    for await (
      using batch of csv.batches(file, {
        ...raw,
        compression,
        chunkSize,
        where: brazil,
        skipRows: 1,
      })
    ) {
      for (let i = 0; i < batch.rowCount; i++) {
        bytes.push(Buffer.from(batch.rowBytes(i)));
        counts.push(batch.rowFieldCount(i));
      }
    }
    expect(bytes).toEqual(accepted);
    expect(counts).toEqual([3, 2, 4, 3, 3]);
  }
});

test('raw filters use physical columns and support native Latin-1 comparisons, limits, and empty fields', async () => {
  const path = join(directory, 'latin1.tsv');
  await Bun.write(path, Buffer.from('\n\tbr\t\xe9\n\tBR\ta\textra\n\tbr\t\xe9\r\n\tbr\t', 'latin1'));
  const options = {
    ...raw,
    encoding: 'latin1',
    compression: 'none',
    chunkSize: 1,
    where: csv.all(brazil, csv.column(0).equals(''), csv.column(2).startsWith('é')),
    limit: 1,
  } as const;
  const records = [];
  for await (using batch of csv.batches(path, options)) {
    records.push(Buffer.from(batch.rowBytes(0)));
  }
  expect(records).toEqual([Buffer.from('\tbr\t\xe9\n', 'latin1')]);

  const widths = [];
  for await (using batch of csv.batches(path, { ...raw, compression: 'none', limit: 2 })) {
    for (let index = 0; index < batch.rowCount; ++index) {
      widths.push(batch.rowFieldCount(index));
    }
  }
  expect(widths).toEqual([1, 3]);
});

test('a raw membership filter matches whole present fields, including two-byte binary and UTF-8 values', async () => {
  const path = join(directory, 'membership.tsv');
  const binary = Buffer.from([0, 0xff]);
  const rows = [
    Buffer.from('pt\n'),
    Buffer.from('pt\t\n'),
    Buffer.from('pt\tbr\tfull\r\n'),
    Buffer.from('pt\tbr\r\n'),
    Buffer.from('pt\tbrz\textra\n'),
    Buffer.from('pt\tb\tr\n'),
    Buffer.from('pt\té\t\n'),
    Buffer.concat([Buffer.from('pt\t'), binary, Buffer.from('\n')]),
    Buffer.from('pt\tbR'),
  ] as const;
  await Bun.write(path, Buffer.concat(rows));
  for (
    const [values, indexes, widths,] of [
      [['br', 'bR', 'é', binary], [2, 6, 7, 8], [3, 3, 2, 2]],
      [['br', 'b\t'], [2], [3]],
      [['brz', 'b'], [4, 5], [3, 3]],
      [[''], [1], [2]],
    ] as const
  ) {
    const actualBytes = [];
    const actualWidths = [];
    for await (using batch of csv.batches(path, { ...raw, chunkSize: 7, where: csv.column(1).isOneOf(values) })) {
      for (let index = 0; index < batch.rowCount; ++index) {
        actualBytes.push(Buffer.from(batch.rowBytes(index)));
        actualWidths.push(batch.rowFieldCount(index));
      }
    }
    expect(actualBytes).toEqual(indexes.map((index) => rows[index]));
    expect(actualWidths).toEqual([...widths]);
  }
});

test('dialect options are independent and apply across chunk boundaries', () => {
  using noQuotes = new NativeCsvParser({ delimiter: '\t', quote: false, skipRows: 1 });
  expect(noQuotes.write(Buffer.from('a\t"skip\r'))).toEqual([]);
  expect(noQuotes.write(Buffer.from('\n"b\tc\rd\te\n'))).toEqual([['"b', 'c'], ['d', 'e']]);

  using lf = new NativeCsvParser({ delimiter: '\t', recordDelimiter: '\n' });
  const text = Buffer.from('"a\nline"\tx\ry\n"z"\r\nend');
  const expected = [['a\nline', 'x\ry'], ['z\r'], ['end']];
  for (let split = 0; split <= text.length; ++split) {
    lf.reset();
    expect([...lf.write(text.subarray(0, split)), ...lf.write(text.subarray(split), true)]).toEqual(expected);
  }
});

test('delimiter detection reads literal rows with explicit or detected encoding', async () => {
  const path = join(directory, 'detected.tsv');
  await Bun.write(path, Buffer.from('pt\tbr\t"Ol\xe1\r\npt\tBR\tfim\n', 'latin1'));
  for (const encoding of ['auto', 'latin1'] as const) {
    const rows = [];
    for await (
      const batch of csv.rows(path, {
        ...literal,
        delimiter: 'auto',
        encoding,
        where: brazil,
        columns: [2, 0],
        transform: [csv.column(0).upper()],
        chunkSize: 1,
      })
    ) {
      rows.push(...batch);
    }
    expect(rows).toEqual([['"Olá\r', 'PT'], ['fim', 'PT']]);
  }
  const rows = [];
  for await (const batch of parseCsvFileProjected(path, { ...literal, columns: [2], encoding: 'latin1', delimiter: 'auto' })) {
    rows.push(...batch);
  }
  expect(rows).toEqual([['"Olá\r'], ['fim']]);
});

test('breaking raw gzip iteration closes a using batch, and full iteration reports truncation', async () => {
  const path = join(directory, 'early-exit.tsv.gz');
  const compressed = Bun.gzipSync(`pt\tbr\tfirst\r\n${'pt\tBR\tnext\n'.repeat(250_000)}pt\tBR\tlast`);
  await Bun.write(path, compressed);
  const options = { ...raw, where: brazil, compression: 'gzip' } as const;
  const iterator = csv.batches(path, options);
  let borrowed: NativeCsvRawRecordBatch | undefined;
  for await (using batch of iterator) {
    borrowed = batch;
    expect(batch.closed).toBe(false);
    expect(batch.rowBytes(0)).toEqual(Buffer.from('pt\tbr\tfirst\r\n'));
    expect(() => batch.rowBytes(-1)).toThrow(RangeError);
    expect(() => batch.rowFieldCount(batch.rowCount)).toThrow(RangeError);
    break;
  }
  expect(borrowed?.closed).toBe(true);
  expect(() => borrowed?.rowBytes(0)).toThrow('batch is closed');
  borrowed?.close();
  expect((await iterator.next()).done).toBe(true);
  const truncated = join(directory, 'truncated.tsv.gz');
  await Bun.write(truncated, compressed.subarray(0, -4));
  await rejects(
    Array.fromAsync(csv.batches(truncated, options), (batch) => {
      using owned = batch;
      return owned.rowCount;
    }),
    /unexpected end of file/u,
  );
});

test('raw batches validate fixed widths before filtering, including skipped rows', async () => {
  const path = join(directory, 'ragged.tsv');
  await Bun.write(path, 'pt\tar\npt\tbr\tmatch\n');
  await rejects(
    Array.fromAsync(csv.batches(path, {
      ...raw,
      where: brazil,
      fixedColumns: 3,
      skipRows: 1,
    })),
    /fixed row column count mismatch/u,
  );
});

test('unsupported dialect and raw batch options fail explicitly', async () => {
  const path = join(directory, 'unsupported.tsv');
  await Bun.write(path, 'pt\tbr\tx\n');
  for (
    const [bad, message,] of [
      [{ quote: true }, 'requires quote: false'],
      [{ recordDelimiter: undefined }, 'requires quote: false'],
      [{ columns: [1] }, 'does not support projection'],
      [{ transform: [csv.column(0).upper()] }, 'does not support projection'],
      [{ strict: true }, 'does not support projection'],
      [{ encoding: 'auto' }, 'requires a native UTF-8 or Latin-1 encoding'],
      [{ encoding: 'utf-16le' }, 'requires a native UTF-8 or Latin-1 encoding'],
      [{ output: 'text' }, 'output must be fields or raw-records'],
    ] as const
  ) {
    await rejects(csv.batches(path, { ...raw, ...bad } as unknown as CsvBatchesOptions).next(), new RegExp(message, 'u'));
  }
  await rejects(csv.rows(path, { quote: 'off' } as unknown as CsvRowsOptions).next(), /quote must be a boolean/u);
  expect(() => new NativeCsvParser({ recordDelimiter: '\r' } as unknown as NativeCsvParserOptions)).toThrow('recordDelimiter must be LF');
  expect(() => new NativeCsvParser({ ...literal, strict: true })).toThrow('requires the default');
  expect(() => csv.findCsvSafeShards(path, 2, literal as CsvShardingOptions)).toThrow('requires the default');
});
