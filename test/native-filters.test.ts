import {
  describe,
  expect,
  test,
} from 'bun:test';
import { NativeCsvParser } from '../src/index.ts';
import { readCsvFixture } from './fixtures.ts';

describe('NativeCsvParser native filters', () => {
  test('preserves empty filter values across FFI calls', () => {
    const input = Buffer.from('a;\nb;x\n');
    const empty = new Uint8Array(new ArrayBuffer(1), 0, 0);

    {
      using parser = new NativeCsvParser({ delimiter: ';', equalsFilter: { column: 1, value: '' } });
      let count = parser.writeCount(empty);
      count += parser.writeCount(input);
      count += parser.endCount();
      expect(count).toBe(1);
    }

    {
      using parser = new NativeCsvParser({ delimiter: ';', filters: [{ column: 1, values: [''] }] });
      let count = parser.writeCount(input);
      count += parser.endCount();
      expect(count).toBe(1);
    }

    {
      using parser = new NativeCsvParser({ delimiter: ';', filters: [{ column: 1, prefix: '' }] });
      let count = parser.writeCount(input);
      count += parser.endCount();
      expect(count).toBe(2);
    }

    {
      const filters = [{ column: 1, value: '' }] as const;
      using parser = new NativeCsvParser({ delimiter: ';', filters });
      let count = parser.writeCount(input);
      count += parser.endCount();
      expect(count).toBe(1);
    }

    {
      const options = { equalsFilter: { column: 1, value: '' }, columns: [0] } as const;
      using parser = new NativeCsvParser({ delimiter: ';', ...options });
      const rows: string[][] = [];
      using batch = parser.writeBatch(input);
      rows.push(...batch.rows());
      using finalBatch = parser.endBatch();
      rows.push(...finalBatch.rows());
      expect(rows).toEqual([['a']]);
    }

    {
      using parser = new NativeCsvParser({ delimiter: ';' });
      using batch = parser.writeBatch(input, true);
      expect(batch.countWhereEquals(1, '')).toBe(1);
    }
  });

  test('projects and filters inside native parser', () => {
    const rows: string[][] = [];
    const options = {
      columns: [2, 0],
      equalsFilter: { column: 2, value: 'SP' },
    };
    using parser = new NativeCsvParser({ delimiter: ';', ...options });

    const input = readCsvFixture('native/quoted-semicolon-people-with-header.csv');
    {
      using batch = parser.writeBatch(input.subarray(0, 21));
      rows.push(...batch.rows());
    }
    {
      using batch = parser.writeBatch(input.subarray(21));
      rows.push(...batch.rows());
    }
    {
      using batch = parser.endBatch();
      rows.push(...batch.rows());
    }

    expect(rows).toEqual([
      ['SP', '1'],
      ['SP', '3'],
    ]);
  });

  test('projects and filters rows split across tiny chunks', () => {
    const input = readCsvFixture('native/projected-rows.csv');
    const rows: string[][] = [];
    const options = {
      columns: [0, 2],
      equalsFilter: { column: 1, value: '5' },
    };
    using parser = new NativeCsvParser(options);

    for (let offset = 0; offset < input.byteLength; ++offset) {
      using batch = parser.writeBatch(input.subarray(offset, offset + 1));
      rows.push(...batch.rows());
    }

    using batch = parser.endBatch();
    rows.push(...batch.rows());
    expect(rows).toEqual([['4', '6']]);
  });

  test('streams ordered projections across tiny chunks', () => {
    const input = readCsvFixture('native/projected-multiline-rows.csv');
    const columns = [2, 0];
    using parser = new NativeCsvParser({ columns });
    const rows: string[][] = [];
    for (let offset = 0; offset < input.byteLength; ++offset) {
      using batch = parser.writeBatch(input.subarray(offset, offset + 1));
      rows.push(...batch.rows());
    }

    using batch = parser.endBatch();
    rows.push(...batch.rows());
    expect(rows).toEqual([['c', 'a'], ['z', 'x\nx'], ['3', '1']]);
  });

  test('enforces projected column uniqueness and configured limits at construction', () => {
    expect(() => new NativeCsvParser({ columns: [2, 2] })).toThrow('selected column repeated: 2');
    expect(() => new NativeCsvParser({ columns: [2025] })).toThrow('selected column out of range: 2025');
    const columns = Array.from({ length: 2025 }, (_, index) => index);
    expect(() => new NativeCsvParser({ columns })).toThrow('selected column count out of range: 2025');

    const input = readCsvFixture('native/single-value.csv');
    using maximumIndex = new NativeCsvParser({ columns: [2024] });
    expect(maximumIndex.write(input, true)).toEqual([['']]);
    using maximumProjection = new NativeCsvParser({ columns: columns.slice(0, 2024) });
    const rows = maximumProjection.write(input, true);
    expect(rows[0]).toHaveLength(2024);
    expect(rows[0]?.[0]).toBe('a');
    expect(rows[0]?.[2023]).toBe('');
  });

  test('enforces the maximum filter column across native filter variants', () => {
    using parser = new NativeCsvParser({ equalsFilter: { column: 2024, value: 'a' } });
    expect(parser.writeCount(readCsvFixture('native/single-value.csv'), true)).toBe(0);
    for (const filter of [{ column: 2025, value: 'a' }, { column: 2025, values: ['a'] }, { column: 2025, prefix: 'a' }]) {
      expect(() => new NativeCsvParser({ filters: [filter] })).toThrow('filter column out of range: 2025');
    }
  });

  test('NativeCsvParser streams in and startsWith native filters across chunks', () => {
    {
      using parser = new NativeCsvParser({ delimiter: ';', filters: [{ column: 1, values: ['SP', 'RJ'] }] });
      const input = readCsvFixture('native/quoted-semicolon-state-filter.csv');
      let count = 0;
      count += parser.writeCount(input.subarray(0, 16));
      count += parser.writeCount(input.subarray(16));
      count += parser.endCount();
      expect(count).toBe(2);
    }

    {
      using startsWithParser = new NativeCsvParser({ delimiter: ';', filters: [{ column: 1, prefix: 'Sa' }] });
      const input = readCsvFixture('native/quoted-semicolon-city-prefix.csv');
      let count = 0;
      count += startsWithParser.writeCount(input.subarray(0, 19));
      count += startsWithParser.writeCount(input.subarray(19));
      count += startsWithParser.endCount();
      expect(count).toBe(1);
    }
  });

  test('large in filters use hashed lookup across UTF-8 and Latin1 chunks', () => {
    const missing = Array.from({ length: 31 }, (_, index) => `missing-${index}`);
    const values = [...missing, 'SP', ''];
    {
      using parser = new NativeCsvParser({ delimiter: ';', filters: [{ column: 1, values }] });
      const input = readCsvFixture('native/unquoted-semicolon-states.csv');
      let count = 0;
      count += parser.writeCount(input.subarray(0, 3));
      count += parser.writeCount(input.subarray(3));
      count += parser.endCount();
      expect(count).toBe(2);
    }

    const latin1Values = [...missing.slice(0, 7), 'João'];
    {
      using latin1Parser = new NativeCsvParser({ delimiter: ';', encoding: 'latin1', filters: [{ column: 1, values: latin1Values }] });
      const input = readCsvFixture('native/latin1-names.csv');
      let count = 0;
      count += latin1Parser.writeCount(input.subarray(0, 5));
      count += latin1Parser.writeCount(input.subarray(5));
      count += latin1Parser.endCount();
      expect(count).toBe(1);
    }
  });
});
