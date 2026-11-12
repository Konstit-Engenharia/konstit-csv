import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import {
  mkdtemp,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  brotliCompressSync,
  deflateRawSync,
  deflateSync,
} from 'node:zlib';
import {
  countCsvFile,
  csv,
  type CsvShardingOptions,
  parseCsvFile,
  parseCsvFileProjected,
} from '../src/index.ts';
import { createZip } from './zip-fixture.ts';

const source = Buffer.from('id;name;state\n1;"Ana\nMaria";SP\n2;Bia;RJ\n3;Caio;SP\n');
const expectedRows = [
  ['id', 'name', 'state'],
  ['1', 'Ana\nMaria', 'SP'],
  ['2', 'Bia', 'RJ'],
  ['3', 'Caio', 'SP'],
];
const formats = ['gzip', 'deflate', 'deflate-raw', 'brotli', 'zstd'] as const satisfies readonly Bun.CompressionFormat[];

let temporaryDirectory: string;

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'csv-parser-compression-'));
  await Promise.all(
    formats.map((format) => Bun.write(compressedPath(format), compress(source, format))),
  );
  await Bun.write(join(temporaryDirectory, 'corrupt.csv.gz'), compress(source, 'gzip').subarray(0, 8));
  await Bun.write(join(temporaryDirectory, 'signature-only'), compress(source, 'gzip'));
  await Bun.write(join(temporaryDirectory, 'mismatch.br'), compress(source, 'gzip'));
  await Bun.write(join(temporaryDirectory, 'ambiguous.deflate'), compress(source, 'deflate-raw'));
  await Bun.write(join(temporaryDirectory, 'plain.csv.gz'), source);
  await Bun.write(join(temporaryDirectory, 'plain.tsv'), source);
  await Bun.write(
    join(temporaryDirectory, 'input.zip'),
    createZip([
      { data: Buffer.from('ignored'), method: 0, name: 'README.txt' },
      { data: source, dataDescriptor: true, method: 8, name: 'nested/input.tsv' },
    ]),
  );
  await Bun.write(
    join(temporaryDirectory, 'stored.zip'),
    createZip([{ data: source, method: 0, name: 'input.tsv' }]),
  );
  await Bun.write(
    join(temporaryDirectory, 'single-file.zip'),
    createZip([
      { data: Buffer.alloc(0), method: 0, name: 'nested/' },
      { data: source, method: 8, name: 'nested/input.tsv' },
    ]),
  );
  await Bun.write(join(temporaryDirectory, 'empty.zip'), createZip([]));
  await Bun.write(
    join(temporaryDirectory, 'corrupt.zip'),
    createZip([{ crc32: (Bun.hash.crc32(source) ^ 1) >>> 0, data: source, method: 8, name: 'input.tsv' }]),
  );
  await Bun.write(
    join(temporaryDirectory, 'duplicate.zip'),
    createZip([
      { data: source, method: 8, name: 'input.tsv' },
      { data: source, method: 8, name: 'input.tsv' },
    ]),
  );
  await Bun.write(
    join(temporaryDirectory, 'encrypted.zip'),
    createZip([{ data: source, flags: 1, method: 8, name: 'input.tsv' }]),
  );
  await Bun.write(
    join(temporaryDirectory, 'unsupported.zip'),
    createZip([{ data: source, method: 99, name: 'input.tsv' }]),
  );
  await Bun.write(
    join(temporaryDirectory, 'high-ratio.zip'),
    createZip([{ data: Buffer.from('a;b\n'.repeat(4_096)), method: 8, name: 'input.tsv' }]),
  );
});

afterAll(async () => {
  await rm(temporaryDirectory, { force: true, recursive: true });
});

describe('compressed CSV file streams', () => {
  test('streams every Bun compression format through rows and count', async () => {
    for (const compression of formats) {
      const rows: string[][] = [];
      for await (
        const batch of csv.rows(compressedPath(compression), {
          chunkSize: 11,
          compression,
          delimiter: ';',
        })
      ) {
        rows.push(...batch);
      }

      expect(rows).toEqual(expectedRows);
      expect(await csv.count(compressedPath(compression), { chunkSize: 13, compression, delimiter: ';' })).toBe(4);
    }
  });

  test('auto-detects every supported compression format', async () => {
    for (const format of formats) {
      const rows: string[][] = [];
      for await (
        const batch of csv.rows(compressedPath(format), {
          chunkSize: 11,
          compression: 'auto',
          delimiter: ';',
        })
      ) {
        rows.push(...batch);
      }
      expect(rows).toEqual(expectedRows);
    }
  });

  test('auto-detects strong signatures without a file extension', async () => {
    expect(
      await csv.count(join(temporaryDirectory, 'signature-only'), {
        compression: 'auto',
        delimiter: ';',
      }),
    ).toBe(4);
  });

  test('rejects extension mismatches and ambiguous input', async () => {
    const mismatch = await rejectedError(
      csv.count(join(temporaryDirectory, 'mismatch.br'), { compression: 'auto', delimiter: ';' }),
    );
    expect(mismatch.message).toContain('extension .br indicates brotli, but the file signature indicates gzip');

    const ambiguous = await rejectedError(
      csv.count(join(temporaryDirectory, 'ambiguous.deflate'), { compression: 'auto', delimiter: ';' }),
    );
    expect(ambiguous.message).toContain('auto-detection is ambiguous for .deflate input');

    const invalidGzip = await rejectedError(
      csv.count(join(temporaryDirectory, 'plain.csv.gz'), { compression: 'auto', delimiter: ';' }),
    );
    expect(invalidGzip.message).toContain('extension .gz does not match the file signature');

    const unknownPath = join(temporaryDirectory, 'plain.bin');
    await Bun.write(unknownPath, source);
    const unknown = await rejectedError(csv.count(unknownPath, { delimiter: ';' }));
    expect(unknown.message).toContain('no supported signature or extension');
    expect(await csv.count(unknownPath, { compression: 'none', delimiter: ';' })).toBe(4);
  });

  test('auto reads uncompressed delimited text and plain text MIME types', async () => {
    for (const suffix of ['csv', 'tsv', 'txt', 'text', 'psv', 'tab', 'ssv', 'CSV']) {
      const path = join(temporaryDirectory, `plain.${suffix}`);
      await Bun.write(path, source);
      expect((await Array.fromAsync(csv.rows(path, { compression: 'auto', delimiter: ';', chunkSize: 2 }))).flat())
        .toEqual(expectedRows);
      expect(await countCsvFile(path, { delimiter: ';' })).toBe(4);
    }
  });

  test('compressed signatures take precedence over text MIME types with tiny reads', async () => {
    const path = join(temporaryDirectory, 'signature.csv');
    for (const format of ['gzip', 'zstd', 'deflate'] as const) {
      await Bun.write(path, compress(source, format));
      expect((await Array.fromAsync(csv.rows(path, { delimiter: ';', chunkSize: 1 }))).flat()).toEqual(expectedRows);
    }
    await Bun.write(path, compress(source, 'gzip').subarray(0, 8));
    expect((await rejectedError(csv.count(path))).message).not.toBe('');
    await Bun.write(path, createZip([{ data: source, name: 'input.csv', method: 0 }]));
    expect((await rejectedError(csv.count(path))).message).toContain('ZIP');
  });

  test('reads printable zlib-header collisions as plain CSV without hiding invalid compressed files', async () => {
    const path = join(temporaryDirectory, 'header.csv');
    for (const first of ['H,name', 'x^,name', '80,name']) {
      await Bun.write(path, `${first}\n1,Ana\n`);
      expect((await Array.fromAsync(csv.rows(path, { chunkSize: 1 }))).flat()).toEqual([first.split(','), ['1', 'Ana']]);
    }
    const invalid = join(temporaryDirectory, 'header.zlib');
    await Bun.write(invalid, 'H,name\n1,Ana\n');
    expect((await rejectedError(csv.count(invalid))).message).not.toBe('');
  });

  test('streams compressed input through batch and callback APIs', async () => {
    const path = compressedPath('gzip');
    const batchRows: string[][] = [];
    for await (using batch of csv.batches(path, { chunkSize: 9, compression: 'gzip', delimiter: ';' })) {
      batchRows.push(...batch.rows());
    }

    const columnarRows: string[] = [];
    await csv.withColumnarBatches(
      path,
      { chunkSize: 7, columns: [0, 2] as const, compression: 'gzip', delimiter: ';' },
      (batch) => {
        for (let rowIndex = 0; rowIndex < batch.rowCount; ++rowIndex) {
          columnarRows.push(
            `${batch.fieldBuffer(rowIndex, 0)?.toString()}|${batch.fieldBuffer(rowIndex, 1)?.toString()}`,
          );
        }
      },
    );

    expect(batchRows).toEqual(expectedRows);
    expect(columnarRows).toEqual(['id|state', '1|SP', '2|RJ', '3|SP']);
  });

  test('supports compressed input through the direct file helpers', async () => {
    const path = compressedPath('gzip');
    const rows: string[][] = [];
    for await (const batch of parseCsvFile(path, { chunkSize: 9, compression: 'gzip', delimiter: ';' })) {
      rows.push(...batch);
    }

    const projectedRows: string[][] = [];
    for await (
      const batch of parseCsvFileProjected(path, {
        chunkSize: 7,
        compression: 'gzip',
        delimiter: ';',
        selectedColumns: [0, 2],
      })
    ) {
      projectedRows.push(...batch);
    }

    expect(rows).toEqual(expectedRows);
    expect(projectedRows).toEqual([
      ['id', 'state'],
      ['1', 'SP'],
      ['2', 'RJ'],
      ['3', 'SP'],
    ]);
    expect(await countCsvFile(path, { compression: 'gzip', delimiter: ';' })).toBe(4);
    expect(await csv.count(path, { compression: 'gzip', delimiter: ';', where: csv.column(2).equals('SP') })).toBe(2);
    expect(await csv.count(path, { compression: 'gzip', delimiter: ';', where: csv.column(2).isOneOf(['SP', 'RJ']) })).toBe(3);
    expect(await csv.count(path, { compression: 'gzip', delimiter: ';', where: csv.column(1).startsWith('B') })).toBe(1);
  });

  test('propagates decompression errors', async () => {
    const error = await rejectedError(
      csv.count(join(temporaryDirectory, 'corrupt.csv.gz'), { compression: 'gzip', delimiter: ';' }),
    );
    expect(error.message.length).toBeGreaterThan(0);
  });

  test('streams a selected deflated ZIP entry through serial APIs', async () => {
    const compression = { entry: 'nested/input.tsv', format: 'zip' } as const;
    const rows: string[][] = [];
    for await (
      const batch of csv.rows(join(temporaryDirectory, 'input.zip'), {
        chunkSize: 5,
        compression,
        delimiter: 'auto',
      })
    ) {
      rows.push(...batch);
    }

    expect(rows).toEqual(expectedRows);
    expect(
      await csv.count(join(temporaryDirectory, 'input.zip'), {
        chunkSize: 7,
        compression,
        delimiter: ';',
      }),
    ).toBe(4);
  });

  test('captures nested ZIP settings before iteration without freezing the caller', async () => {
    const compression = { entry: 'nested/input.tsv', format: 'zip' as const, maxDecompressedBytes: source.byteLength };
    const options = { chunkSize: 1, compression, delimiter: ';' };
    const stream = csv.rows(join(temporaryDirectory, 'input.zip'), options);
    const count = csv.count(join(temporaryDirectory, 'input.zip'), options);
    expect(options.compression).toBe(compression);
    expect(Object.isFrozen(compression)).toBe(false);
    compression.entry = 'README.txt';
    compression.maxDecompressedBytes = 1;
    expect(await count).toBe(4);
    const rows: string[][] = [];
    for await (const batch of stream) {
      rows.push(...batch);
    }
    expect(rows).toEqual(expectedRows);
    expect(compression.entry).toBe('README.txt');
    expect(compression.maxDecompressedBytes).toBe(1);
  });

  test('streams a stored ZIP entry', async () => {
    expect(
      await csv.count(join(temporaryDirectory, 'stored.zip'), {
        chunkSize: 3,
        compression: { entry: 'input.tsv', format: 'zip' },
        delimiter: ';',
      }),
    ).toBe(4);
  });

  test('selects the only file in a ZIP when entry is \'*\'', async () => {
    expect(
      await csv.count(join(temporaryDirectory, 'single-file.zip'), {
        chunkSize: 3,
        compression: { entry: '*', format: 'zip' },
        delimiter: ';',
      }),
    ).toBe(4);
  });

  test('rejects entry \'*\' unless the ZIP contains exactly one file', async () => {
    const options = {
      compression: { entry: '*', format: 'zip' } as const,
      delimiter: ';' as const,
    };

    expect((await rejectedError(csv.count(join(temporaryDirectory, 'input.zip'), options))).message).toContain(
      'entry \'*\' requires exactly one file',
    );
    expect((await rejectedError(csv.count(join(temporaryDirectory, 'empty.zip'), options))).message).toContain(
      'entry \'*\' requires exactly one file',
    );
  });

  test('rejects invalid ZIP archives and configured limits', async () => {
    const options = (entry = 'input.tsv') => ({
      compression: { entry, format: 'zip' } as const,
      delimiter: ';' as const,
    });

    expect(
      (await rejectedError(csv.count(join(temporaryDirectory, 'input.zip'), options('missing.tsv')))).message,
    ).toContain('requested ZIP entry was not found');
    expect(
      (await rejectedError(csv.count(join(temporaryDirectory, 'corrupt.zip'), options()))).message,
    ).toContain('CRC32 check failed');
    expect(
      (await rejectedError(csv.count(join(temporaryDirectory, 'duplicate.zip'), options()))).message,
    ).toContain('duplicate entries');
    expect(
      (await rejectedError(csv.count(join(temporaryDirectory, 'encrypted.zip'), options()))).message,
    ).toContain('encrypted ZIP entries are not supported');
    expect(
      (await rejectedError(csv.count(join(temporaryDirectory, 'unsupported.zip'), options()))).message,
    ).toContain('compression method is not supported');
    expect(
      (
        await rejectedError(
          csv.count(join(temporaryDirectory, 'stored.zip'), {
            compression: { entry: 'input.tsv', format: 'zip', maxDecompressedBytes: source.byteLength - 1 },
            delimiter: ';',
          }),
        )
      ).message,
    ).toContain('maximum decompressed byte count');
    expect(
      (
        await rejectedError(
          csv.count(join(temporaryDirectory, 'high-ratio.zip'), {
            compression: { entry: 'input.tsv', format: 'zip', maxCompressionRatio: 2 },
            delimiter: ';',
          }),
        )
      ).message,
    ).toContain('maximum compression ratio');
  });

  test('rejects compression for the in-memory parse API at runtime', async () => {
    const options = { compression: 'gzip' } as unknown as Parameters<typeof csv.parse>[1];
    expect((await rejectedError(csv.parse(source, options))).message).toContain('parse() does not support compression');
  });

  test('rejects compressed input for byte-offset sharding APIs', () => {
    const invalidSharding = { compression: 'gzip' } as unknown as CsvShardingOptions;

    expect(() => csv.findCsvSafeSplitOffsets('unused.csv.gz', 2, invalidSharding)).toThrow(
      'CSV split offset scanning does not support compressed input',
    );
    expect(() => csv.findCsvSafeShards('unused.csv.gz', 2, invalidSharding)).toThrow(
      'CSV shard scanning does not support compressed input',
    );
  });
});

function compressedPath(format: Bun.CompressionFormat): string {
  const extensionByFormat = {
    'brotli': 'br',
    'deflate': 'zlib',
    'deflate-raw': 'deflate-raw',
    'gzip': 'gz',
    'zstd': 'zst',
  } satisfies Record<Bun.CompressionFormat, string>;
  return join(temporaryDirectory, `input.tsv.${extensionByFormat[format]}`);
}

function compress(input: Uint8Array<ArrayBuffer>, format: Bun.CompressionFormat): Uint8Array {
  switch (format) {
    case 'brotli':
      return brotliCompressSync(input);
    case 'deflate':
      return deflateSync(input);
    case 'deflate-raw':
      return deflateRawSync(input);
    case 'gzip':
      return Bun.gzipSync(input);
    case 'zstd':
      return Bun.zstdCompressSync(input);
  }
}

async function rejectedError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('expected promise to reject');
}
