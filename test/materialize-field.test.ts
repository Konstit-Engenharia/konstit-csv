import {
  expect,
  test,
} from 'bun:test';
import { decodeMaterializedField } from '../src/materialize-field.ts';

test('materialized Latin-1 fields own their bytes across source buffer reuse', () => {
  const bytes = Buffer.alloc(8192);
  const lengths = [0, 1, 2, 3, 7, 8, 31, 257, 4097];
  const retained: string[] = [];
  const expected: string[] = [];
  for (const length of lengths) {
    for (let i = 0; i < length; ++i) {
      bytes[5 + i] = (i + length) & 255;
    }
    expected.push(bytes.toString('latin1', 5, 5 + length));
    retained.push(decodeMaterializedField(bytes, 5, 5 + length, 'latin1'));
    bytes.fill(0);
  }
  expect(retained).toEqual(expected);
});

for (const encoding of ['utf8', 'latin1'] as const) {
  test(`shared materialization matches every one-byte and two-byte ${encoding} value`, () => {
    const data = Buffer.alloc(4);
    for (const width of [1, 2]) {
      const count = width === 1 ? 256 : 65_536;
      const actual: string[] = [];
      const expected: string[] = [];
      for (let value = 0; value < count; ++value) {
        data[1] = width === 1 ? value : value >>> 8;
        data[2] = value & 255;
        actual.push(decodeMaterializedField(data, 1, 1 + width, encoding));
        expected.push(data.toString(encoding, 1, 1 + width));
      }
      expect(actual).toEqual(expected);
    }
  });

  test(`shared materialization preserves empty and longer ${encoding} ranges`, () => {
    const data = Buffer.from([0x41, 0xc3, 0xa9, 0xff, 0x42]);
    expect(decodeMaterializedField(data, 0, 0, encoding)).toBe('');
    expect(decodeMaterializedField(data, data.length, data.length, encoding)).toBe('');
    expect(decodeMaterializedField(data, 1, 4, encoding)).toBe(data.toString(encoding, 1, 4));
    expect(decodeMaterializedField(data, 3, 1, encoding)).toBe(data.toString(encoding, 3, 1));
  });
}
