import {
  describe,
  expect,
  test,
} from 'bun:test';
import { csv } from '../src/index.ts';
import { csvFixturePath } from './fixtures.ts';

describe('NativeCsvParser file streams', () => {
  test('returns record boundaries and inclusive shard ranges', () => {
    const path = csvFixturePath('native/safe-split-multiline.csv');
    const offsets = csv.findCsvSafeSplitOffsets(path, 3, { delimiter: ';' });
    const shards = csv.findCsvSafeShards(path, 3, { delimiter: ';' });

    expect(offsets).toEqual([0, 30, 52, 71]);
    expect(shards).toEqual([{ start: 0, end: 29 }, { start: 30, end: 51 }, { start: 52, end: 70 }]);
  });

  test('keeps CRLF and quoted newlines intact at exact split offsets', () => {
    const crlfPath = csvFixturePath('native/safe-split-crlf.csv');
    const escapedPath = csvFixturePath('native/safe-split-escaped-quote.csv');
    expect(csv.findCsvSafeSplitOffsets(crlfPath, 2, { delimiter: ';' })).toEqual([0, 15, 20]);
    expect(csv.findCsvSafeSplitOffsets(crlfPath, 4, { delimiter: ';' })).toEqual([0, 5, 15, 20]);
    expect(csv.findCsvSafeSplitOffsets(escapedPath, 2, { delimiter: ';' })).toEqual([0, 12, 18]);
  });
});
