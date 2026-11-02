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
  csv,
  type CsvFilter,
  type CsvRowsOptions,
} from '../src/index.ts';

let directory = '';
let bytesPath = '';
let filtersPath = '';
let mutationPath = '';
const allBytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index)).toString('latin1');
const byteRows = [['', allBytes, 'é"\r\nÿ'], ['tail', '\0\x80\x9f', '']];
const filterRows = [
  ['1', 'Érico', 'São', 'quoted "é"'],
  ['2', 'João', 'Rio', 'line\nbreak'],
  ['3', 'Åsa', 'São', '\x80\x9fÿ'],
  ['4', 'Érico'],
];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'csv-latin1-materialization-'));
  bytesPath = join(directory, 'bytes.csv');
  filtersPath = join(directory, 'filters.csv');
  mutationPath = join(directory, 'mutation.csv');
  await Bun.write(mutationPath, Buffer.from('é;ÿ\né;ÿ\né;ÿ\né;ÿ', 'latin1'));
  for (const [path, rows,] of [[bytesPath, byteRows], [filtersPath, filterRows]] as const) {
    const text = rows.map((row) => row.map((field) => `"${field.replaceAll('"', '""')}"`).join(';')).join('\r\n');
    await Bun.write(path, Buffer.from(text, 'latin1'));
  }
});

afterAll(async () => {
  await rm(directory, { force: true, recursive: true });
});

async function collect(path: string, options: CsvRowsOptions<readonly number[] | undefined> = {}): Promise<string[][]> {
  const result: string[][] = [];
  for await (const rows of csv.rows(path, { delimiter: ';', encoding: 'latin1', ...options })) {
    result.push(...rows);
  }
  return result;
}

describe('private Latin1 row materialization compatibility', () => {
  test('refreshes replaced projection options between chunks and before final rows', async () => {
    for (const alias of ['columns', 'selectedColumns'] as const) {
      const options = { chunkSize: 4, [alias]: [0], delimiter: ';' as const, encoding: 'latin1' as const };
      const stream = csv.rows(mutationPath, options);
      try {
        expect((await stream.next()).value).toEqual([['é']]);
        options[alias] = [1];
        expect((await stream.next()).value).toEqual([['ÿ']]);
        options[alias] = [];
        expect((await stream.next()).value).toEqual([[]]);
        options[alias] = [1, 0];
        expect((await stream.next()).value).toEqual([['ÿ', 'é']]);
        expect((await stream.next()).done).toBe(true);
      } finally {
        await stream.return();
      }
    }
  });

  test('rejects conflicting projection aliases introduced between batches', async () => {
    expect.assertions(2);
    const options = { chunkSize: 4, columns: [0], delimiter: ';' as const, encoding: 'latin1' as const };
    const stream = csv.rows(mutationPath, options);
    try {
      expect((await stream.next()).value).toEqual([['é']]);
      Object.assign(options, { selectedColumns: [1] });
      try {
        await stream.next();
      } catch (error) {
        expect(error).toMatchObject({ message: 'use columns or selectedColumns, not both' });
      }
    } finally {
      await stream.return();
    }
  });

  test('refreshes mutable projection arrays between chunks and before final rows', async () => {
    const columns = [0];
    const stream = csv.rows(mutationPath, { chunkSize: 4, columns, delimiter: ';', encoding: 'latin1' });
    try {
      expect((await stream.next()).value).toEqual([['é']]);
      columns.push(1);
      expect((await stream.next()).value).toEqual([['é', 'ÿ']]);
      columns.length = 0;
      expect((await stream.next()).value).toEqual([[]]);
      columns.push(1);
      expect((await stream.next()).value).toEqual([['ÿ']]);
      expect((await stream.next()).done).toBe(true);
    } finally {
      await stream.return();
    }
  });

  test('keeps filter values isolated from caller mutation between chunks', async () => {
    const value = Buffer.from('Érico');
    const values = [value];
    const where = csv.column(1).isOneOf(values);
    const rows: string[][] = [];
    for await (const batch of csv.rows(filtersPath, { chunkSize: 1, delimiter: ';', encoding: 'latin1', where })) {
      rows.push(...batch);
      value.fill(0);
      values.push(Buffer.from('João'));
    }
    expect(rows).toEqual([filterRows[0] ?? [], filterRows[3] ?? []]);
  });

  test('retains every Latin1 code point across quoted chunk boundaries and batch destruction', async () => {
    for (const chunkSize of [1, 2, 7, 64, 1024]) {
      expect(await collect(bytesPath, { chunkSize })).toEqual(byteRows);
      expect(await collect(bytesPath, { chunkSize, columns: [2, 0, 1, 9] })).toEqual(
        byteRows.map((row) => [row[2] ?? '', row[0] ?? '', row[1] ?? '', '']),
      );
      expect(await collect(bytesPath, { chunkSize, columns: [] })).toEqual([[], []]);
    }
  });

  test('keeps public native batch fields UTF-8 encoded', async () => {
    const rows: string[][] = [];
    for await (const batch of csv.batches(bytesPath, { delimiter: ';', encoding: 'latin1', chunkSize: 7 })) {
      try {
        for (const row of batch.rows()) {
          rows.push(row);
        }
        if (batch.rowCount > 0 && rows.length === 1) {
          expect(batch.fieldBuffer(0, 1)).toEqual(Buffer.from(allBytes, 'utf8'));
        }
      } finally {
        batch.close();
      }
    }
    expect(rows).toEqual(byteRows);
  });

  test('preserves UTF-8 filter values, Unicode regexes, boolean programs and missing columns', async () => {
    const cases: readonly [CsvFilter, readonly number[]][] = [
      [csv.column(1).equals('Érico'), [0, 3]],
      [csv.column(1).equals(Buffer.from('Érico')), [0, 3]],
      [csv.column(1).doesNotEqual('Érico'), [1, 2]],
      [csv.column(1).isOneOf(['Åsa', 'João', 'x', 'y', 'z', 'a', 'b', 'c', 'd', 'e']), [1, 2]],
      [csv.column(1).isNoneOf(['Åsa', 'João']), [0, 3]],
      [csv.column(2).startsWith('Sã'), [0, 2]],
      [csv.column(1).hasMatch(/^érico$/iu), [0, 3]],
      [csv.column(1).equals('€'), []],
      [csv.column(1).equals(Uint8Array.of(0xc9)), []],
      [csv.all(csv.column(2).equals('São'), csv.not(csv.column(1).equals('Åsa'))), [0]],
      [csv.any(csv.column(2).equals('São'), csv.column(1).equals('João')), [0, 1, 2]],
      [csv.not(csv.column(2).equals('São')), [1]],
    ];
    for (const [where, indexes,] of cases) {
      for (const chunkSize of [1, 7, 1024]) {
        const expected = indexes.map((index) => filterRows[index] ?? []);
        expect(await collect(filtersPath, { chunkSize, where })).toEqual(expected);
        expect(await collect(filtersPath, { chunkSize, columns: [3, 1, 9], where })).toEqual(
          expected.map((row) => [row?.[3] ?? '', row?.[1] ?? '', '']),
        );
      }
    }
  });

  test('retains strict, schema and fixed-column validation', async () => {
    expect.assertions(3);
    for (const options of [{ strict: true }, { fixedColumns: 4 }, { strict: true, expectedHeaders: ['wrong'] }] as const) {
      try {
        await collect(filtersPath, options);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    }
  });
});
