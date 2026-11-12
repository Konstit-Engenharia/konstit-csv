import {
  describe,
  expect,
  test,
} from 'bun:test';
import {
  csv,
  type NativeCsvBatch,
  NativeCsvParser,
  type NativeCsvRowView,
} from '../src/index.ts';
import { csvFixturePath } from './fixtures.ts';

const path = csvFixturePath('api/quoted-people-two-rows.csv');

describe('API and native coverage contracts', () => {
  test('exposes every row-view accessor during its callback', async () => {
    let escaped: Pick<NativeCsvRowView, 'get'> | undefined;
    for await (using batch of csv.batches(path, { delimiter: ';', columns: [0, 2] })) {
      batch.forEachRow((row) => {
        expect(row.rowIndex).toBeGreaterThanOrEqual(0);
        expect(row.fieldCount).toBe(2);
        expect(row.fieldRange(0)).not.toBeNull();
        expect(row.range(0)).not.toBeNull();
        expect(row.fieldBytes(0)).not.toBeNull();
        expect(row.bytes(0)).not.toBeNull();
        expect(row.fieldBuffer(0)?.toString()).toBe(row.buffer(0)?.toString());
        expect(row.fieldString(0)).toBe(row.getPhysical(0));
        expect(row.get(0)).toBe(row.fieldString(0));
        expect(row.pickPhysical([0, 1])).toEqual([row.get(0) ?? '', row.get(1) ?? '']);
        expect(row.pick([0])).toEqual([row.get(0) ?? '']);
        escaped = row;
      });
    }
    const retained = escaped;
    if (retained === undefined) {
      throw new Error('row callback did not run');
    }
    expect(() => retained.get(0)).toThrow('row view is only valid during row view callback');
  });

  test('exposes every columnar accessor and skips missing columns', async () => {
    let escaped: NativeCsvBatch | undefined;
    const bytes: string[] = [];
    for await (using batch of csv.batches(path, { delimiter: ';', columns: [0, 2] })) {
      expect(batch.rowCount).toBeGreaterThan(0);
      expect(batch.totalFields).toBeGreaterThan(0);
      expect(batch.dataLength).toBeGreaterThan(0);
      expect(batch.dataView().byteLength).toBe(batch.dataLength);
      expect(batch.rowOffsets().length).toBe(batch.rowCount + 1);
      expect(batch.fieldOffsets().length).toBe(batch.totalFields + 1);
      expect(batch.rowFieldCount(0)).toBe(2);
      expect(batch.fieldRange(0, 0)).not.toBeNull();
      expect(batch.fieldBytes(0, 0)).not.toBeNull();
      expect(batch.fieldBuffer(0, 0)?.toString()).toBe('id');
      batch.forEachColumnBytes(0, (_index, value) => bytes.push(value.toString()));
      batch.scanColumns([0, 99], () => {});
      batch.forEachColumnRange(99, () => {
        throw new Error('missing field callback');
      });
      escaped = batch;
    }
    expect(bytes).toEqual(['id', '1', '2']);
    const retained = escaped;
    if (retained === undefined) {
      throw new Error('no native batches yielded');
    }
    expect(() => retained.dataView()).toThrow('native CSV batch is closed');
  });

  test('supports explicit disposable cleanup aliases', async () => {
    let count = 0;
    for await (using batch of csv.batches(path, { delimiter: ';' })) {
      expect(batch.closed).toBe(false);
      count += batch.rowCount;
      batch.dispose();
      expect(batch.closed).toBe(true);
    }
    expect(count).toBe(3);
    const parser = new NativeCsvParser();
    parser.dispose();
    expect(parser.closed).toBe(true);
  });

  test('covers sharding and regex constructors', () => {
    const shardPath = csvFixturePath('api/quoted-people-two-rows.csv');
    expect(csv.findCsvSafeSplitOffsets(shardPath, 2, { delimiter: ';' }).length).toBeGreaterThan(0);
    expect(csv.findCsvSafeShards(shardPath, 2, { delimiter: ';' }).length).toBeGreaterThan(0);
    expect(csv.re(/ana/i).source).toBe('ana');
    expect(csv.re(/ana/i).flags).toBe('i');
    expect(() => csv.re('x' as unknown as RegExp)).toThrow();
  });

  test('finishes filtered count through explicit parser end operation', () => {
    using parser = new NativeCsvParser();
    expect(parser.writeCountWhereEquals(Buffer.from('id,name\n1,Ana\n'), { column: 0, value: '1' })).toBe(1);
    expect(parser.endCountWhereEquals({ column: 0, value: '1' })).toBe(0);
  });

  test('runs in and starts-with count filters and reset', () => {
    using parser = new NativeCsvParser();
    const input = Buffer.from('1,Ana\n2,Bob\n');
    expect(parser.writeCountWhereIn(input, { column: 0, values: ['1'] })).toBe(1);
    expect(parser.endCountWhereIn({ column: 0, values: ['1'] })).toBe(0);
    parser.reset();
    expect(parser.writeCountWhereStartsWith(input, { column: 1, prefix: 'A' })).toBe(1);
    expect(parser.endCountWhereStartsWith({ column: 1, prefix: 'A' })).toBe(0);
    expect(parser.closed).toBe(false);
  });
});
