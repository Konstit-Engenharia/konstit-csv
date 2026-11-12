import {
  describe,
  expect,
  test,
} from 'bun:test';
import { NativeCsvParser } from '../src/index.ts';
import { requirePtr } from '../src/native.ts';
import { readCsvFixture } from './fixtures.ts';

describe('native resource lifecycle', () => {
  test('preserves bigint pointers and rejects null pointers', () => {
    expect(requirePtr(123n)).toBe(123n);
    expect(() => requirePtr(null)).toThrow('native CSV pointer is null');
  });

  test('parser and row batches expose closed state and use-after-close errors', () => {
    const parser = new NativeCsvParser();
    expect(parser.closed).toBe(false);

    const batch = parser.writeBatch(readCsvFixture('native/unquoted-comma-two-rows.csv'), true);
    expect(batch.closed).toBe(false);
    expect(batch.rows()).toEqual([['a', 'b'], ['1', '2']]);

    batch.close();
    expect(batch.closed).toBe(true);
    expect(() => batch.rows()).toThrow('native CSV batch is closed');
    batch.close();
    expect(batch.closed).toBe(true);

    parser.close();
    expect(parser.closed).toBe(true);
    expect(() => parser.write(readCsvFixture('native/single-x.csv'))).toThrow('native CSV parser is closed');
    parser.close();
    expect(parser.closed).toBe(true);
  });

  test('stops visiting native storage if a callback closes the batch', () => {
    using parser = new NativeCsvParser();
    const input = readCsvFixture('native/unquoted-comma-two-rows.csv');
    using rows = parser.writeBatch(input);
    expect(() =>
      rows.forEachRow((row) => {
        rows.close();
        expect(() => row.get(0)).toThrow('native CSV batch is closed');
      })
    ).toThrow('native CSV batch is closed');

    using ranges = parser.writeBatch(input);
    expect(() => ranges.forEachColumnRange(0, () => ranges.close())).toThrow('native CSV batch is closed');
    using scan = parser.writeBatch(input, true);
    expect(() => scan.scanColumns([0], () => scan.close())).toThrow('native CSV batch is closed');
  });

  test('Bun using closes parser and row batches', () => {
    let parserRef: NativeCsvParser | undefined;
    let batchRef: ReturnType<NativeCsvParser['writeBatch']> | undefined;

    {
      using parser = new NativeCsvParser();
      parserRef = parser;
      {
        using batch = parser.writeBatch(readCsvFixture('native/unquoted-comma-two-rows.csv'), true);
        batchRef = batch;
        expect(batch.closed).toBe(false);
        expect(batch.rows()).toEqual([['a', 'b'], ['1', '2']]);
      }
      expect(batchRef.closed).toBe(true);
      expect(parser.closed).toBe(false);
    }

    expect(parserRef.closed).toBe(true);
    expect(batchRef.closed).toBe(true);
  });
});
