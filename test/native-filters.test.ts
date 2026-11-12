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
      using parser = new NativeCsvParser({ delimiter: ';' });
      let count = parser.writeCountWhereEquals(empty, { column: 1, value: '' });
      count += parser.writeCountWhereEquals(input, { column: 1, value: '' });
      count += parser.endCountWhereEquals({ column: 1, value: '' });
      expect(count).toBe(1);
    }

    {
      using parser = new NativeCsvParser({ delimiter: ';' });
      let count = parser.writeCountWhereIn(input, { column: 1, values: [''] });
      count += parser.endCountWhereIn({ column: 1, values: [''] });
      expect(count).toBe(1);
    }

    {
      using parser = new NativeCsvParser({ delimiter: ';' });
      let count = parser.writeCountWhereStartsWith(input, { column: 1, prefix: '' });
      count += parser.endCountWhereStartsWith({ column: 1, prefix: '' });
      expect(count).toBe(2);
    }

    {
      using parser = new NativeCsvParser({ delimiter: ';' });
      const filters = [{ column: 1, value: '' }] as const;
      let count = parser.writeCountWhereAll(input, filters);
      count += parser.endCountWhereAll(filters);
      expect(count).toBe(1);
    }

    {
      using parser = new NativeCsvParser({ delimiter: ';' });
      const options = { equalsFilter: { column: 1, value: '' }, columns: [0] } as const;
      const rows: string[][] = [];
      using batch = parser.writeProjectedBatch(input, options);
      rows.push(...batch.rows());
      using finalBatch = parser.endProjectedBatch(options);
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
    using parser = new NativeCsvParser({ delimiter: ';' });
    const rows: string[][] = [];
    const options = {
      columns: [2, 0],
      equalsFilter: { column: 2, value: 'SP' },
    };

    const input = readCsvFixture('native/quoted-semicolon-people-with-header.csv');
    {
      using batch = parser.writeProjectedBatch(input.subarray(0, 21), options);
      rows.push(...batch.rows());
    }
    {
      using batch = parser.writeProjectedBatch(input.subarray(21), options);
      rows.push(...batch.rows());
    }
    {
      using batch = parser.endProjectedBatch(options);
      rows.push(...batch.rows());
    }

    expect(rows).toEqual([
      ['SP', '1'],
      ['SP', '3'],
    ]);
  });

  test('projects and filters rows split across tiny chunks', () => {
    using parser = new NativeCsvParser();
    const input = readCsvFixture('native/projected-rows.csv');
    const rows: string[][] = [];
    const options = {
      columns: [0, 2],
      equalsFilter: { column: 1, value: '5' },
    };

    for (let offset = 0; offset < input.byteLength; ++offset) {
      using batch = parser.writeProjectedBatch(input.subarray(offset, offset + 1), options);
      rows.push(...batch.rows());
    }

    using batch = parser.endProjectedBatch(options);
    rows.push(...batch.rows());
    expect(rows).toEqual([['4', '6']]);
  });

  test('streams ordered projections across tiny chunks', () => {
    const input = readCsvFixture('native/projected-multiline-rows.csv');
    const columns = [2, 0];
    using parser = new NativeCsvParser();
    const rows: string[][] = [];
    for (let offset = 0; offset < input.byteLength; ++offset) {
      using batch = parser.writeProjectedBatch(input.subarray(offset, offset + 1), { columns });
      rows.push(...batch.rows());
    }

    using batch = parser.endProjectedBatch({ columns });
    rows.push(...batch.rows());
    expect(rows).toEqual([['c', 'a'], ['z', 'x\nx'], ['3', '1']]);
  });

  test('enforces projected column uniqueness and configured limits', () => {
    {
      using parser = new NativeCsvParser();
      expect(() => parser.writeProjectedBatch(readCsvFixture('native/three-column-header.csv'), { columns: [2, 2] })).toThrow(
        'selected column repeated: 2',
      );
      expect(() => parser.writeProjectedBatch(readCsvFixture('native/single-value.csv'), { columns: [2025] })).toThrow(
        'selected column out of range: 2025',
      );
      expect(() =>
        parser.writeProjectedBatch(readCsvFixture('native/single-value.csv'), {
          columns: Array.from({ length: 2025 }, (_, index) => index),
        })
      ).toThrow('selected column count out of range: 2025');

      using maximumIndex = parser.writeProjectedBatch(readCsvFixture('native/single-value.csv'), { columns: [2024] }, true);
      expect(maximumIndex.rows()).toEqual([['']]);
    }

    {
      using maximumProjectionParser = new NativeCsvParser();
      const columns = Array.from({ length: 2024 }, (_, index) => index);
      using batch = maximumProjectionParser.writeProjectedBatch(readCsvFixture('native/single-value.csv'), { columns }, true);
      const rows = batch.rows();
      expect(rows[0]).toHaveLength(2024);
      expect(rows[0]?.[0]).toBe('a');
      expect(rows[0]?.[2023]).toBe('');
    }
  });

  test('enforces the maximum filter column across native filter variants', () => {
    {
      using parser = new NativeCsvParser();
      expect(parser.writeCountWhereEquals(readCsvFixture('native/single-value.csv'), { column: 2024, value: 'a' }, true)).toBe(0);
    }

    {
      using invalidParser = new NativeCsvParser();
      expect(() => invalidParser.writeCountWhereEquals(readCsvFixture('native/single-value.csv'), { column: 2025, value: 'a' })).toThrow(
        'filter column out of range: 2025',
      );
      expect(() => invalidParser.writeCountWhereIn(readCsvFixture('native/single-value.csv'), { column: 2025, values: ['a'] })).toThrow(
        'filter column out of range: 2025',
      );
      expect(() => invalidParser.writeCountWhereStartsWith(readCsvFixture('native/single-value.csv'), { column: 2025, prefix: 'a' }))
        .toThrow(
          'filter column out of range: 2025',
        );
    }
  });

  test('NativeCsvParser streams in and startsWith native filters across chunks', () => {
    {
      using parser = new NativeCsvParser({ delimiter: ';' });
      const input = readCsvFixture('native/quoted-semicolon-state-filter.csv');
      let count = 0;
      count += parser.writeCountWhereIn(input.subarray(0, 16), { column: 1, values: ['SP', 'RJ'] });
      count += parser.writeCountWhereIn(input.subarray(16), { column: 1, values: ['SP', 'RJ'] });
      count += parser.endCountWhereIn({ column: 1, values: ['SP', 'RJ'] });
      expect(count).toBe(2);
    }

    {
      using startsWithParser = new NativeCsvParser({ delimiter: ';' });
      const input = readCsvFixture('native/quoted-semicolon-city-prefix.csv');
      let count = 0;
      count += startsWithParser.writeCountWhereStartsWith(input.subarray(0, 19), {
        column: 1,
        prefix: 'Sa',
      });
      count += startsWithParser.writeCountWhereStartsWith(input.subarray(19), {
        column: 1,
        prefix: 'Sa',
      });
      count += startsWithParser.endCountWhereStartsWith({ column: 1, prefix: 'Sa' });
      expect(count).toBe(1);
    }
  });

  test('large in filters use hashed lookup across UTF-8 and Latin1 chunks', () => {
    const missing = Array.from({ length: 31 }, (_, index) => `missing-${index}`);
    const values = [...missing, 'SP', ''];
    {
      using parser = new NativeCsvParser({ delimiter: ';' });
      const input = readCsvFixture('native/unquoted-semicolon-states.csv');
      let count = 0;
      count += parser.writeCountWhereIn(input.subarray(0, 3), { column: 1, values });
      count += parser.writeCountWhereIn(input.subarray(3), { column: 1, values });
      count += parser.endCountWhereIn({ column: 1, values });
      expect(count).toBe(2);
    }

    const latin1Values = [...missing.slice(0, 7), 'João'];
    {
      using latin1Parser = new NativeCsvParser({ delimiter: ';', encoding: 'latin1' });
      const input = readCsvFixture('native/latin1-names.csv');
      let count = 0;
      count += latin1Parser.writeCountWhereIn(input.subarray(0, 5), {
        column: 1,
        values: latin1Values,
      });
      count += latin1Parser.writeCountWhereIn(input.subarray(5), {
        column: 1,
        values: latin1Values,
      });
      count += latin1Parser.endCountWhereIn({ column: 1, values: latin1Values });
      expect(count).toBe(1);
    }
  });
});
