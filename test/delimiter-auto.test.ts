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
  countCsvFile,
  csv,
  NativeCsvParser,
  parseCsvFile,
  parseCsvFileProjected,
} from '../src/index.ts';

const tabSource = Buffer.from('id\tname\tstate\n1\t"Ana, Maria"\tbr\n2\t"Bia\nSilva"\tus\n');
const tabRows = [
  ['id', 'name', 'state'],
  ['1', 'Ana, Maria', 'br'],
  ['2', 'Bia\nSilva', 'us'],
];
const semicolonSource = Buffer.from('id;name;state\n1;"Ana, Maria";br\n2;Bia;us\n');
const detectedDelimiters = [',', '\t', ';', '|', ':', '^', '~'] as const;

let temporaryDirectory: string;
let tabPath: string;
let semicolonPath: string;

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'csv-parser-delimiter-auto-'));
  tabPath = join(temporaryDirectory, 'input.tsv');
  semicolonPath = join(temporaryDirectory, 'input.txt');
  await Promise.all([
    Bun.write(tabPath, tabSource),
    Bun.write(semicolonPath, semicolonSource),
    Bun.write(join(temporaryDirectory, 'input.tsv.gz'), Bun.gzipSync(tabSource)),
    Bun.write(join(temporaryDirectory, 'tie.csv'), 'left,right;value\n1,2;3\n'),
    Bun.write(join(temporaryDirectory, 'tie.txt'), 'left,right;value\n1,2;3\n'),
    Bun.write(join(temporaryDirectory, 'single-column.txt'), 'alpha\nbeta\n'),
    Bun.write(join(temporaryDirectory, 'empty.csv'), ''),
    Bun.write(
      join(temporaryDirectory, 'large.tsv'),
      `id\tvalue\n${Array.from({ length: 10_000 }, (_, index) => `${String(index)}\tvalue-${String(index)}\n`).join('')}`,
    ),
    ...detectedDelimiters.map((delimiter, index) =>
      Bun.write(join(temporaryDirectory, `delimiter-${String(index)}.txt`), `left${delimiter}right\n1${delimiter}2\n`)
    ),
  ]);
});

afterAll(async () => {
  await rm(temporaryDirectory, { force: true, recursive: true });
});

describe('automatic delimiter detection', () => {
  test('detects every supported delimiter candidate', async () => {
    for (let index = 0; index < detectedDelimiters.length; ++index) {
      const rows: string[][] = [];
      for await (
        const batch of csv.rows(join(temporaryDirectory, `delimiter-${String(index)}.txt`), { delimiter: 'auto' })
      ) {
        rows.push(...batch);
      }
      expect(rows).toEqual([
        ['left', 'right'],
        ['1', '2'],
      ]);
    }
  });

  test('detects a quoted TSV and replays all probe bytes', async () => {
    const rows: string[][] = [];
    for await (const batch of csv.rows(tabPath, { chunkSize: 3, delimiter: 'auto' })) {
      rows.push(...batch);
    }

    expect(rows).toEqual(tabRows);
    expect(await csv.count(tabPath, { delimiter: 'auto', where: csv.column(2).equals('br') })).toBe(1);
    expect(await csv.count(join(temporaryDirectory, 'large.tsv'), { chunkSize: 1024, delimiter: 'auto' })).toBe(10_001);
  });

  test('probes decompressed data after removing the compression extension', async () => {
    expect(
      await csv.count(join(temporaryDirectory, 'input.tsv.gz'), {
        compression: 'auto',
        delimiter: 'auto',
      }),
    ).toBe(3);
  });

  test('replays ordered rows across the probe and reused read-ahead buffers', async () => {
    const path = join(temporaryDirectory, 'large.tsv');
    let index = 0;
    for await (const batch of csv.rows(path, { chunkSize: 997, delimiter: 'auto', reuseArrays: true })) {
      for (const row of batch) {
        expect(row).toEqual(index === 0 ? ['id', 'value'] : [String(index - 1), `value-${index - 1}`]);
        ++index;
      }
    }
    expect(index).toBe(10_001);
  });

  test('supports projected batches, filtered counts, and direct file helpers', async () => {
    const batchRows: string[][] = [];
    for await (using batch of csv.batches(semicolonPath, { delimiter: 'auto' })) {
      batchRows.push(...batch.rows());
    }

    const projected: string[] = [];
    for await (using batch of csv.batches(semicolonPath, { columns: [0, 2], delimiter: 'auto' })) {
      for (let rowIndex = 0; rowIndex < batch.rowCount; ++rowIndex) {
        projected.push(`${batch.fieldBuffer(rowIndex, 0)?.toString()}|${batch.fieldBuffer(rowIndex, 1)?.toString()}`);
      }
    }

    const directRows: string[][] = [];
    for await (const batch of parseCsvFile(semicolonPath, { delimiter: 'auto' })) {
      directRows.push(...batch);
    }
    const directProjected: string[][] = [];
    for await (
      const batch of parseCsvFileProjected(semicolonPath, {
        delimiter: 'auto',
        columns: [0, 2],
      })
    ) {
      directProjected.push(...batch);
    }

    expect(batchRows).toEqual([
      ['id', 'name', 'state'],
      ['1', 'Ana, Maria', 'br'],
      ['2', 'Bia', 'us'],
    ]);
    expect(projected).toEqual(['id|state', '1|br', '2|us']);
    expect(directRows).toEqual(batchRows);
    expect(directProjected).toEqual([
      ['id', 'state'],
      ['1', 'br'],
      ['2', 'us'],
    ]);
    expect(await countCsvFile(semicolonPath, { delimiter: 'auto' })).toBe(3);
    expect(await csv.count(semicolonPath, { delimiter: 'auto', where: csv.column(2).equals('br') })).toBe(1);
    expect(await csv.count(semicolonPath, { delimiter: 'auto', where: csv.column(2).isOneOf(['br', 'us']) })).toBe(2);
    expect(await csv.count(semicolonPath, { delimiter: 'auto', where: csv.column(1).startsWith('A') })).toBe(1);
  });

  test('uses a confirmed extension hint to resolve a probe tie', async () => {
    const rows: string[][] = [];
    for await (const batch of csv.rows(join(temporaryDirectory, 'tie.csv'), { delimiter: 'auto' })) {
      rows.push(...batch);
    }
    expect(rows).toEqual([
      ['left', 'right;value'],
      ['1', '2;3'],
    ]);
  });

  test('rejects ambiguous, empty, and single-column probes', async () => {
    expect((await rejectedError(csv.count(join(temporaryDirectory, 'tie.txt'), { delimiter: 'auto' }))).message)
      .toContain('delimiter auto-detection is ambiguous');
    expect(
      (await rejectedError(csv.count(join(temporaryDirectory, 'single-column.txt'), { delimiter: 'auto' }))).message,
    ).toContain('no supported delimiter has a stable positive count');
    expect((await rejectedError(csv.count(join(temporaryDirectory, 'empty.csv'), { delimiter: 'auto' }))).message)
      .toContain('contains no complete non-empty row');
  });

  test('rejects automatic detection for in-memory and byte-offset APIs', async () => {
    expect((await rejectedError(csv.parse(tabSource, { delimiter: 'auto' }))).message).toContain(
      'parse() does not support automatic delimiter detection',
    );
    expect(() => new NativeCsvParser({ delimiter: 'auto' })).toThrow(
      'automatic delimiter detection is only supported by file APIs',
    );
    expect(() => csv.findCsvSafeSplitOffsets('unused.tsv', 2, { delimiter: 'auto' })).toThrow(
      'CSV split offset scanning does not support automatic delimiter detection',
    );
    expect(() => csv.findCsvSafeShards('unused.tsv', 2, { delimiter: 'auto' })).toThrow(
      'CSV shard scanning does not support automatic delimiter detection',
    );
  });
});

async function rejectedError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('expected promise to reject');
}
