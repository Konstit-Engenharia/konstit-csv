import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import iconv from 'iconv-lite';
import {
  mkdtemp,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  csv,
  parseCsvBuffer,
} from '../src/index.ts';

const sourceRows: readonly (readonly string[])[] = [
  ['1', 'Ana', 'SP', 'OK', 'plain'],
  ['2', 'João', 'RJ', 'EX', 'line\nbreak'],
  ['3', 'Bia', 'MG', 'OK', 'São'],
  ['4', 'Caio', 'SP', 'OK', 'quote "x"'],
  ['5', 'Duda', 'RJ', 'OK'],
  ['6', 'Érico', 'SP'],
  ['7', 'Lia', 'RJ', 'EX', 'escaped "quote"'],
  ['8', 'NoState'],
  ['9', 'Nina', 'SP', 'OK', ''],
];
const SORTED_COLUMNS = [0, 2, 4, 10] as const;
const REORDERED_COLUMNS = [4, 0, 2, 10] as const;
const EXPECTED_FILTERED_FULL_ROWS: string[][] = [
  ['1', 'Ana', 'SP', 'OK', 'plain'],
  ['4', 'Caio', 'SP', 'OK', 'quote "x"'],
  ['5', 'Duda', 'RJ', 'OK'],
  ['9', 'Nina', 'SP', 'OK', ''],
];
const EXPECTED_FILTERED_SORTED_ROWS: string[][] = [
  ['1', 'SP', 'plain', ''],
  ['4', 'SP', 'quote "x"', ''],
  ['5', 'RJ', '', ''],
  ['9', 'SP', '', ''],
];
const EXPECTED_FILTERED_REORDERED_ROWS: string[][] = [
  ['plain', '1', 'SP', ''],
  ['quote "x"', '4', 'SP', ''],
  ['', '5', 'RJ', ''],
  ['', '9', 'SP', ''],
];
const EXPECTED_ALL_ROWS = sourceRows.map((row) => REORDERED_COLUMNS.map((column) => row[column] ?? ''));

let temporaryDirectory = '';
let utf8Path = '';
let latin1Path = '';

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'csv-materialization-regression-'));
  utf8Path = join(temporaryDirectory, 'input-utf8.csv');
  latin1Path = join(temporaryDirectory, 'input-latin1.csv');
  const input = csvText(sourceRows);
  await Bun.write(utf8Path, Buffer.from(input, 'utf8'));
  await Bun.write(latin1Path, iconv.encode(input, 'latin1'));
});

afterAll(async () => {
  await rm(temporaryDirectory, { force: true, recursive: true });
});

describe('filtered row materialization regressions', () => {
  test('matches the reference for nested filters, encodings, and every small chunk split', async () => {
    const where = csv.all(
      csv.any(
        csv.column(2).equals('SP'),
        csv.column(2).equals('RJ'),
        csv.column(10).equals('never'),
      ),
      csv.not(csv.column(3).equals('EX')),
    );

    for (const [path, encoding,] of [[utf8Path, 'utf8'], [latin1Path, 'iso88591']] as const) {
      const input = Buffer.from(await Bun.file(path).arrayBuffer());
      const parsedFullRows: string[][] = await csv.parse(input, {
        delimiter: ';',
        encoding,
        where,
      });
      expect(parsedFullRows).toEqual(EXPECTED_FILTERED_FULL_ROWS);

      const parsedSortedRows: string[][] = await csv.parse(input, {
        columns: SORTED_COLUMNS,
        delimiter: ';',
        encoding,
        where,
      });
      expect(parsedSortedRows).toEqual(EXPECTED_FILTERED_SORTED_ROWS);

      const parsedReorderedRows: string[][] = await csv.parse(input, {
        columns: REORDERED_COLUMNS,
        delimiter: ';',
        encoding,
        where,
      });
      expect(parsedReorderedRows).toEqual(EXPECTED_FILTERED_REORDERED_ROWS);

      for (const chunkSize of [1, 2, 3, 5, 7, 13]) {
        const fullRows: string[][] = [];
        for await (
          const batch of csv.rows(path, {
            chunkSize,
            delimiter: ';',
            encoding,
            where,
          })
        ) {
          fullRows.push(...batch);
        }
        expect(fullRows).toEqual(EXPECTED_FILTERED_FULL_ROWS);

        const sortedRows: string[][] = [];
        for await (
          const batch of csv.rows(path, {
            chunkSize,
            columns: SORTED_COLUMNS,
            delimiter: ';',
            encoding,
            where,
          })
        ) {
          sortedRows.push(...batch);
        }
        expect(sortedRows).toEqual(EXPECTED_FILTERED_SORTED_ROWS);

        const reorderedRows: string[][] = [];
        for await (
          const batch of csv.rows(path, {
            chunkSize,
            columns: REORDERED_COLUMNS,
            delimiter: ';',
            encoding,
            where,
          })
        ) {
          reorderedRows.push(...batch);
        }
        expect(reorderedRows).toEqual(EXPECTED_FILTERED_REORDERED_ROWS);
      }
    }
  });

  test('preserves ragged rows and missing projections', async () => {
    for (const [path, encoding,] of [[utf8Path, 'utf8'], [latin1Path, 'iso88591']] as const) {
      const input = Buffer.from(await Bun.file(path).arrayBuffer());
      expect(parseCsvBuffer(input, { delimiter: ';', encoding, selectedColumns: REORDERED_COLUMNS })).toEqual(EXPECTED_ALL_ROWS);

      const rows: string[][] = [];
      for await (
        const batch of csv.rows(path, {
          chunkSize: 1,
          columns: REORDERED_COLUMNS,
          delimiter: ';',
          encoding,
        })
      ) {
        rows.push(...batch);
      }
      expect(rows).toEqual(EXPECTED_ALL_ROWS);
    }
  });

  test('keeps duplicate projection rejection before parsing', async () => {
    const input = Buffer.from(await Bun.file(utf8Path).arrayBuffer());
    expect(() => parseCsvBuffer(input, { delimiter: ';', selectedColumns: [2, 2] })).toThrow('selected column repeated: 2');
  });
});

function csvText(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(quoteField).join(';')).join('\r\n');
}

function quoteField(value: string): string {
  return /[;"\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
