import {
  describe,
  expect,
  test,
} from 'bun:test';
import {
  csv,
  type CsvNativeFilter,
  type CsvNativeFilterProgramEntry,
  NativeCsvParser,
} from '../src/index.ts';
import { latin1Rows } from '../src/latin1-rows.ts';
import { latin1RowsParser } from '../src/native.ts';

const value = 'É\0ÿ';
const text = [
  `plain;${value};first`,
  `quoted;"${value}";second`,
  'escaped;"É""\0ÿ";third',
  'different;É\0y;fourth',
  'empty;;fifth',
  'missing',
  `final;${value};last`,
].join('\r\n');
const matchedRows = [
  ['plain', value, 'first'],
  ['quoted', value, 'second'],
  ['final', value, 'last'],
];
const values = ['unused-0', 'unused-1', 'unused-2', 'unused-3', 'unused-4', 'unused-5', 'unused-6', value];
const projections = [undefined, [0], [1], [0, 1, 2], [1, 0, 2]] as const;

describe('contiguous native filter fields', () => {
  test('counts Unicode and embedded NUL fields without confusing empty and missing values', () => {
    const filters = [
      { column: 1, value },
      { column: 1, values },
      { column: 1, prefix: value },
      { column: 1, regex: csv.re(/^É\0ÿ$/u) },
      { column: 1, notEquals: value },
      { column: 1, notIn: values },
    ] satisfies readonly CsvNativeFilter[];

    for (const encoding of ['utf8', 'latin1'] as const) {
      const input = Buffer.from(text, encoding);
      for (const filter of filters) {
        using parser = new NativeCsvParser({ delimiter: ';', encoding, filters: [filter] });
        expect(parser.writeCount(input, true)).toBe(3);
      }
    }
  });

  test('owns matching selected fields and exposes public batch fields as UTF-8', () => {
    for (const encoding of ['utf8', 'latin1'] as const) {
      for (const columns of projections) {
        const input = Buffer.from(text, encoding);
        using parser = new NativeCsvParser({ delimiter: ';', encoding, columns, filters: [{ column: 1, value }] });
        using batch = parser.writeBatch(input, true);
        input.fill(0x78);
        const expected = columns === undefined ? matchedRows : matchedRows.map((row) => columns.map((column) => row[column] ?? ''));

        expect(batch.rows()).toEqual(expected);
        for (const [rowIndex, row,] of expected.entries()) {
          for (const [columnIndex, field,] of row.entries()) {
            expect(batch.fieldBuffer(rowIndex, columnIndex)).toEqual(Buffer.from(field, 'utf8'));
          }
        }
      }
    }
  });

  test('retains filtered fields when input chunks are overwritten between writes', () => {
    for (const encoding of ['utf8', 'latin1'] as const) {
      const input = Buffer.from(text, encoding);
      const boundaries = [
        Buffer.byteLength(`plain;${value};`, encoding),
        Buffer.byteLength(`plain;${value};first\r\nquoted;"É`, encoding),
        Buffer.byteLength(`plain;${value};first\r\nquoted;"${value}"`, encoding),
        Buffer.byteLength(`plain;${value};first\r\nquoted;"${value}";second\r\nescaped;"É"`, encoding),
      ];

      for (const boundary of boundaries) {
        const first = Buffer.from(input.subarray(0, boundary));
        using parser = new NativeCsvParser({ delimiter: ';', encoding, columns: [1, 0, 2], filters: [{ column: 1, values }] });
        const rows: string[][] = [];
        {
          using batch = parser.writeBatch(first);
          first.fill(0x78);
          rows.push(...batch.rows());
        }
        {
          using batch = parser.writeBatch(input.subarray(boundary), true);
          rows.push(...batch.rows());
        }
        expect(rows).toEqual(matchedRows.map((row) => [row[1] ?? '', row[0] ?? '', row[2] ?? '']));
      }
    }
  });

  test('matches UTF-8 predicates while materializing private Latin1 fields', async () => {
    const filters = [
      { column: 1, values },
      { column: 1, prefix: 'É' },
      { column: 1, regex: csv.re(/^É\0ÿ$/u) },
      { operator: 'all', operandCount: 3 },
    ] satisfies readonly CsvNativeFilterProgramEntry[];

    for (const columns of projections) {
      const input = Buffer.from(text, 'latin1');
      const rows = (await Array.fromAsync(latin1Rows([input], ';', columns, filters, latin1RowsParser(undefined)))).flat();
      input.fill(0x78);
      const expected = columns === undefined ? matchedRows : matchedRows.map((row) => columns.map((column) => row[column] ?? ''));
      expect(rows).toEqual(expected);
    }
  });
});
