import {
  afterAll,
  beforeAll,
  describe,
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
  countCsvFile,
  csv,
  NativeCsvParser,
  parseCsvFileProjected,
} from '../src/index.ts';

let directory = '';
let validPath = '';
let invalidPath = '';
const valid = 'keep;"é\nline";1\nignore;value;2\nkeep;tail;3';
const invalid = `${valid}\nignore;short`;
const mismatch = /fixed row column count mismatch/;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'csv-fixed-projection-'));
  validPath = join(directory, 'valid.csv');
  invalidPath = join(directory, 'invalid.csv');
  await Bun.write(validPath, valid);
  await Bun.write(invalidPath, invalid);
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function collect(stream: AsyncIterable<string[][]>): Promise<string[][]> {
  const rows: string[][] = [];
  for await (const batch of stream) {
    rows.push(...batch);
  }
  return rows;
}

describe('fixed columns with projection and filters', () => {
  test('validates physical rows before projection and filtering in both encodings', async () => {
    for (const encoding of ['utf8', 'latin1'] as const) {
      const options = { columns: [2, 0] as const, delimiter: ';', encoding, fixedColumns: 3, where: csv.column(0).equals('keep') };
      const bytes = Buffer.from(valid, encoding);
      expect(await csv.parse(bytes, options)).toEqual([['1', 'keep'], ['3', 'keep']]);
      expect(await csv.parse(bytes, { ...options, where: undefined })).toHaveLength(3);
      for (const bad of ['keep;only', 'ignore;too;many;fields\n', `${valid}\nignore;short`]) {
        await rejects(csv.parse(Buffer.from(bad, encoding), options), mismatch);
      }
    }
  });

  test('checks split and final rows across serial streaming surfaces and counts', async () => {
    const options = { chunkSize: 2, columns: [2, 0] as const, delimiter: ';', fixedColumns: 3, where: csv.column(0).equals('keep') };
    expect(await collect(csv.rows(validPath, options))).toEqual([['1', 'keep'], ['3', 'keep']]);
    await rejects(collect(csv.rows(invalidPath, options)), mismatch);
    await rejects(collect(csv.rows(invalidPath, { ...options, where: undefined })), mismatch);
    await rejects(
      (async () => {
        for await (using batch of csv.batches(invalidPath, options)) {
          expect(batch.rowCount).toBeGreaterThan(0);
        }
      })(),
      mismatch,
    );
    await rejects(
      collect(parseCsvFileProjected(invalidPath, {
        chunkSize: 2,
        delimiter: ';',
        fixedColumns: 3,
        columns: [2, 0],
        filters: [{ column: 0, value: 'keep' }],
      })),
      mismatch,
    );
    await rejects(csv.count(invalidPath, options), mismatch);
    await rejects(csv.count(invalidPath, { delimiter: ';', fixedColumns: 3 }), mismatch);
    await rejects(countCsvFile(invalidPath, { delimiter: ';', fixedColumns: 3 }), mismatch);
    expect(await csv.count(validPath, options)).toBe(2);
    expect(await csv.count(validPath, { delimiter: ';', fixedColumns: 3 })).toBe(3);
  });

  test('validates fixed columns when counting chunks directly', () => {
    using parser = new NativeCsvParser({ delimiter: ';', fixedColumns: 3 });
    expect(parser.writeCount(Buffer.from('a;b;c\nx;'))).toBe(1);
    expect(() => parser.writeCount(Buffer.from('y'), true)).toThrow(mismatch);
  });
});
