import {
  expect,
  test,
} from 'bun:test';
import { decodeMaterializedField } from '../src/materialize-field.ts';

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
