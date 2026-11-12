import {
  describe,
  expect,
  test,
} from 'bun:test';
import {
  type CsvNativeFilter,
  NativeCsvParser,
} from '../src/index.ts';
import {
  type CsvNativeFilterProgramEntry,
  normalizeNativeFilterProgram,
  normalizeNativeFilters,
} from '../src/normalize.ts';
import { readCsvFixture } from './fixtures.ts';

describe('NativeCsvParser multiple native filters', () => {
  test('packs mixed filters into native descriptors and values', () => {
    const normalized = normalizeNativeFilters([
      { column: 2, value: 'SP' },
      { column: 1, values: ['A', ''] },
      { column: 0, prefix: Buffer.from('x') },
      { column: 3, notEquals: 'RJ' },
      { column: 4, notIn: ['', 'MG'] },
    ]);

    expect(Array.from(normalized.descriptors)).toEqual([
      1,
      2,
      0,
      1,
      2,
      1,
      1,
      2,
      3,
      0,
      3,
      1,
      5,
      3,
      4,
      1,
      6,
      4,
      5,
      2,
    ]);
    expect(Buffer.from(normalized.valuesData.subarray(0, normalized.valuesDataLength)).toString()).toBe('SPAxRJMG');
    expect(Array.from(normalized.valueOffsets)).toEqual([0, 2, 3, 3, 4, 6, 6, 8]);
    expect(normalized.filterCount).toBe(5);
    expect(normalized.valueCount).toBe(7);
  });

  test('packs nested Boolean operators into postfix descriptors', () => {
    const normalized = normalizeNativeFilterProgram([
      { column: 2, value: 'SP' },
      { column: 2, value: 'RJ' },
      { operandCount: 2, operator: 'any' },
      { column: 1, prefix: 'A' },
      { operandCount: 1, operator: 'not' },
      { operandCount: 2, operator: 'all' },
    ]);

    expect(Array.from(normalized.descriptors)).toEqual([
      1,
      2,
      0,
      1,
      1,
      2,
      1,
      1,
      8,
      2,
      0,
      0,
      3,
      1,
      2,
      1,
      9,
      1,
      0,
      0,
      7,
      2,
      0,
      0,
    ]);
    expect(Buffer.from(normalized.valuesData).toString()).toBe('SPRJA');
    expect(Array.from(normalized.valueOffsets)).toEqual([0, 2, 4, 5]);
    expect(normalized.filterCount).toBe(6);
    expect(normalized.valueCount).toBe(3);
  });

  test('counts rows that match every filter across chunks', () => {
    const filters = [
      { column: 2, values: ['SP', 'RJ'] },
      { column: 1, prefix: 'A' },
      { column: 0, value: '1' },
    ] satisfies readonly CsvNativeFilter[];
    const input = readCsvFixture('native/quoted-semicolon-people-with-mg.csv');
    using parser = new NativeCsvParser({ delimiter: ';' });

    let count = parser.writeCountWhereAll(input.subarray(0, 17), filters);
    count += parser.writeCountWhereAll(input.subarray(17), filters);
    count += parser.endCountWhereAll(filters);

    expect(count).toBe(1);
  });

  test('projects rows that match every filter', () => {
    const options = {
      filters: [
        { column: 2, values: ['SP', 'RJ'] },
        { column: 1, prefix: 'A' },
        { column: 0, value: '1' },
      ],
      columns: [2, 1],
    } satisfies Parameters<NativeCsvParser['writeProjectedBatch']>[1];
    const input = readCsvFixture('native/quoted-semicolon-people-with-mg.csv');
    using parser = new NativeCsvParser({ delimiter: ';' });
    const rows: string[][] = [];

    for (let offset = 0; offset < input.byteLength; ++offset) {
      using batch = parser.writeProjectedBatch(input.subarray(offset, offset + 1), options);
      rows.push(...batch.rows());
    }
    using finalBatch = parser.endProjectedBatch(options);
    rows.push(...finalBatch.rows());

    expect(rows).toEqual([['SP', 'Ana']]);
  });

  test('counts notEquals and notIn filters across chunks', () => {
    const filters = [
      { column: 1, notEquals: 'SP' },
      { column: 1, notIn: ['RJ', 'SC', 'PR', 'RS', 'BA', 'AM', 'PA', 'AC'] },
    ] satisfies readonly CsvNativeFilter[];
    const input = Buffer.from('id;uf\n1;SP\n2;RJ\n3;MG\n4\n');
    using parser = new NativeCsvParser({ delimiter: ';' });

    let count = 0;
    for (let offset = 0; offset < input.byteLength; ++offset) {
      count += parser.writeCountWhereAll(input.subarray(offset, offset + 1), filters);
    }
    count += parser.endCountWhereAll(filters);

    expect(count).toBe(2);
  });

  test('treats an empty native filter list as no filter', () => {
    using parser = new NativeCsvParser();
    const input = readCsvFixture('native/projected-rows.csv');
    expect(parser.writeCountWhereAll(input, [], true)).toBe(3);
  });

  test('rejects invalid multiple-filter options', () => {
    expect(() => normalizeNativeFilters([{ column: 0, values: [] }])).toThrow('filter values must not be empty');
    expect(() => normalizeNativeFilters([{ column: 0, notIn: [] }])).toThrow('filter values must not be empty');
    expect(() => normalizeNativeFilters(Array.from({ length: 2025 }, () => ({ column: 0, value: 'x' })))).toThrow(
      'filter count out of range: 2025',
    );

    using parser = new NativeCsvParser();
    expect(() =>
      parser.writeProjectedBatch(Buffer.from('x\n'), {
        equalsFilter: { column: 0, value: 'x' },
        filters: [],
      })
    ).toThrow('use equalsFilter or filters, not both');

    const normalizeProgram = (program: readonly unknown[]) =>
      normalizeNativeFilterProgram(program as readonly CsvNativeFilterProgramEntry[]);
    expect(() => normalizeProgram([])).toThrow('filter program must contain at least one predicate');
    expect(() => normalizeProgram([{ operandCount: 2, operator: 'any' }])).toThrow(
      'filter any does not have 2 operands',
    );
    expect(() => normalizeProgram([{ column: 0, value: 'x' }, { operandCount: 2, operator: 'not' }])).toThrow(
      'filter not operand count must be 1',
    );
    expect(() => normalizeProgram([{ column: 0, value: 'x' }, { column: 1, value: 'y' }])).toThrow(
      'filter program leaves 2 results',
    );
  });
});
