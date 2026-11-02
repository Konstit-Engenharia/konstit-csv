import {
  describe,
  expect,
  test,
} from 'bun:test';
import {
  NativeCsvParser,
  NativeCsvRowView,
  parseCsvBuffer,
} from '../src/index.ts';
import { readCsvFixture } from './fixtures.ts';

describe('NativeCsvParser batches and materialization', () => {
  test('exposes lazy field views and selected columns', () => {
    using parser = new NativeCsvParser({ delimiter: ';' });
    using batch = parser.writeBatch(readCsvFixture('native/quoted-semicolon-people.csv'), true);
    expect(batch.rowCount).toBe(2);
    expect(batch.rowOffsets()).toBeInstanceOf(BigUint64Array);
    expect(batch.fieldOffsets()).toBeInstanceOf(BigUint64Array);
    expect([...batch.rowOffsets()]).toEqual([0n, 3n, 6n]);
    expect(batch.rowFieldCount(0)).toBe(3);
    expect(batch.fieldString(1, 2)).toBe('RJ');
    expect(batch.fieldBuffer(0, 1)?.toString()).toBe('Ana');
    const dataView = batch.dataView();
    const fieldBytes = batch.fieldBytes(0, 1);
    expect(dataView).toBeInstanceOf(Uint8Array);
    expect(fieldBytes).toBeInstanceOf(Uint8Array);
    expect(fieldBytes?.buffer).toBe(dataView.buffer);
    expect(Buffer.from(fieldBytes ?? []).toString()).toBe('Ana');
    expect(batch.fieldBytes(0, 9)).toBeNull();
    const ranged: string[] = [];
    batch.forEachColumnRange(2, (_rowIndex, start, end) => {
      ranged.push(batch.data().toString('utf8', start, end));
    });
    expect(ranged).toEqual(['SP', 'RJ']);
    expect(batch.rowsInto([], [0, 2])).toEqual([
      ['1', 'SP'],
      ['2', 'RJ'],
    ]);
    expect(batch.countWhereEquals(2, 'SP')).toBe(1);
  });

  test('parses fixed-column batches with quoted newlines', () => {
    using parser = new NativeCsvParser({
      delimiter: ';',
      fixedColumns: 3,
    });
    const input = readCsvFixture('native/fixed-columns-quoted-newline.csv');
    const rows: string[][] = [];
    {
      using batch = parser.writeBatch(input.subarray(0, 14));
      expect(batch.rows()).toEqual([]);
    }
    {
      using batch = parser.writeBatch(input.subarray(14));
      rows.push(...batch.rows());
    }
    {
      using batch = parser.endBatch();
      rows.push(...batch.rows());
    }

    expect(rows).toEqual([
      ['1', 'Ana\nA', 'SP'],
      ['2', 'Joao', 'RJ'],
    ]);
  });

  test('fixed-column batches reject column count mismatch', () => {
    using parser = new NativeCsvParser({ delimiter: ';', fixedColumns: 3 });
    expect(() => parser.writeBatch(readCsvFixture('native/fixed-column-mismatch.csv'))).toThrow('fixed row column count mismatch');
  });

  test('iterates rows with one reusable row view', () => {
    using parser = new NativeCsvParser({ delimiter: ';' });
    using batch = parser.writeBatch(readCsvFixture('native/quoted-semicolon-people.csv'), true);
    const seen: Array<{
      rowIndex: number;
      fieldCount: number;
      id: string | null;
      name: string | null;
      uf: string | null;
      missing: string | null;
      nameBytes: string | undefined;
      ufBuffer: string | undefined;
    }> = [];
    const rowViews = new Set<unknown>();

    batch.forEachRow((row, rowIndex) => {
      rowViews.add(row);
      seen.push({
        rowIndex,
        fieldCount: row.fieldCount,
        id: row.fieldString(0),
        name: row.fieldString(1),
        uf: row.fieldString(2),
        missing: row.fieldString(4),
        nameBytes: row.fieldBytes(1)?.toString(),
        ufBuffer: row.fieldBuffer(2)?.toString(),
      });
    });

    expect(rowViews.size).toBe(1);
    expect(seen).toEqual([
      {
        rowIndex: 0,
        fieldCount: 3,
        id: '1',
        name: 'Ana',
        uf: 'SP',
        missing: null,
        nameBytes: 'Ana',
        ufBuffer: 'SP',
      },
      {
        rowIndex: 1,
        fieldCount: 3,
        id: '2',
        name: 'Joao',
        uf: 'RJ',
        missing: null,
        nameBytes: 'Joao',
        ufBuffer: 'RJ',
      },
    ]);
  });

  test('keeps nonzero-offset views live after numeric materialization', () => {
    const storage = new ArrayBuffer(64);
    const rowOffsets = new BigUint64Array(storage, 8, 3);
    const fieldOffsets = new BigUint64Array(storage, 32, 3);
    rowOffsets.set([0n, 1n, 2n]);
    fieldOffsets.set([0n, 1n, 2n]);
    const rowView = new NativeCsvRowView(Buffer.from('ab'), rowOffsets, fieldOffsets);

    expect(rowView.fieldCount).toBe(1);
    expect(rowView.fieldString(0)).toBe('a');
    rowOffsets[1] = 2n;
    expect(rowView.fieldCount).toBe(2);
    fieldOffsets[1] = 2n;
    expect(rowView.fieldString(0)).toBe('ab');
  });

  test('preserves projected row reuse and missing-column behavior', () => {
    using parser = new NativeCsvParser({ delimiter: ';' });
    using batch = parser.writeBatch(readCsvFixture('native/quoted-semicolon-people.csv'), true);
    const target = [['stale', 'value'], ['stale']];
    const result = batch.rowsInto(target, [2, 0, 5]);

    expect(result).toBe(target);
    expect(result).toEqual([
      ['SP', '1', ''],
      ['RJ', '2', ''],
    ]);
    expect(() => batch.rowsInto(target, [2, 2])).toThrow('selected column repeated: 2');
  });

  test('observes mutable batch offsets after materialization', () => {
    using parser = new NativeCsvParser({ delimiter: ';' });
    using batch = parser.writeBatch(readCsvFixture('native/quoted-semicolon-people.csv'), true);
    expect(batch.rowsInto([])).toEqual([
      ['1', 'Ana', 'SP'],
      ['2', 'Joao', 'RJ'],
    ]);

    const rowOffsets = batch.rowOffsets();
    rowOffsets[1] = 6n;
    expect(batch.rowsInto([])).toEqual([
      ['1', 'Ana', 'SP', '2', 'Joao', 'RJ'],
      [],
    ]);

    rowOffsets[1] = 3n;
    const fieldOffsets = batch.fieldOffsets();
    const firstFieldEnd = fieldOffsets[1];
    if (firstFieldEnd === undefined) {
      throw new Error('missing first field offset');
    }
    fieldOffsets[1] = firstFieldEnd + 1n;
    const expectedFirstField = batch.data().subarray(0, Number(firstFieldEnd) + 1).toString('utf8');
    expect(batch.rowsInto([])[0]?.[0]).toBe(expectedFirstField);
  });

  test('materializes every one-byte and two-byte value like Buffer UTF-8 decoding', () => {
    for (const width of [1, 2]) {
      const count = width === 1 ? 256 : 65_536;
      using parser = new NativeCsvParser();
      using batch = parser.writeBatch(Buffer.from(`${'a'.repeat(width)}\n`.repeat(count)), true);
      const data = batch.data();
      const expected: string[][] = [];
      for (let value = 0; value < count; ++value) {
        const start = value * width;
        data[start] = width === 1 ? value : value >>> 8;
        if (width === 2) {
          data[start + 1] = value & 255;
        }
        expected.push([data.toString('utf8', start, start + width)]);
      }

      const target: string[][] = [];
      expect(batch.rowsInto(target)).toEqual(expected);
      expect(batch.rowsInto(target, [0])).toEqual(expected);
    }
  });

  test('short-field materialization observes byte and offset mutations with reused rows', () => {
    using parser = new NativeCsvParser({ delimiter: ';' });
    using batch = parser.writeBatch(Buffer.from(';a;SP;long\n'), true);
    const target = [['stale', 'values']];
    const originalRow = target[0];
    expect(batch.rowsInto(target)).toEqual([['', 'a', 'SP', 'long']]);
    expect(target[0]).toBe(originalRow);

    batch.data().set([0x7a, 0x52, 0x4a]);
    expect(batch.rowsInto(target)).toEqual([['', 'z', 'RJ', 'long']]);
    batch.data().set([0xff, 0xc3, 0xa9]);
    expect(batch.rowsInto(target, [2, 1, 0, 9])).toEqual([['é', '\ufffd', '', '']]);
    expect(target[0]).toBe(originalRow);

    batch.data().set([0x61, 0x62, 0x63]);
    batch.fieldOffsets().set([0n, 1n, 3n, 3n, 7n]);
    expect(batch.rowsInto(target)).toEqual([['a', 'bc', '', 'long']]);
    expect(batch.rowsInto(target, [2, 1, 0])).toEqual([['', 'bc', 'a']]);
  });

  test('validates empty and short field offsets before decoding', () => {
    using parser = new NativeCsvParser({ delimiter: ';' });
    using batch = parser.writeBatch(Buffer.from(';a;SP\n'), true);
    const offsets = batch.fieldOffsets();
    offsets[0] = 4n;
    offsets[1] = 4n;
    expect(() => batch.rowsInto([])).toThrow('field offset exceeds backing storage: 4');
    expect(() => batch.rowsInto([], [0])).toThrow('field offset exceeds backing storage: 4');
    offsets[0] = 0n;
    offsets[1] = 0x20_0000_0000_0000n;
    expect(() => batch.rowsInto([])).toThrow('field offset exceeds Number.MAX_SAFE_INTEGER');
    expect(() => batch.rowsInto([], [0])).toThrow('field offset exceeds Number.MAX_SAFE_INTEGER');
  });

  test('materialized empty and short strings survive batch disposal', () => {
    using parser = new NativeCsvParser({ delimiter: ';' });
    const batch = parser.writeBatch(Buffer.from(';a;SP;é\n'), true);
    const rows = batch.rowsInto([]);
    batch.close();
    expect(rows).toEqual([['', 'a', 'SP', 'é']]);
    expect(() => batch.rowsInto(rows)).toThrow('native CSV batch is closed');
  });

  test('reports exact numeric offset range and index errors', () => {
    const rowOffsets = new BigUint64Array([0n, 1n]);
    const data = Buffer.from('a');

    const aboveUint32Row = new NativeCsvRowView(
      data,
      new BigUint64Array([0n, 0x100000001n]),
      new BigUint64Array([0n, 1n]),
    );
    expect(() => aboveUint32Row.fieldCount).toThrow('exceeds backing storage: 4294967297');

    const aboveUint32 = new NativeCsvRowView(data, rowOffsets, new BigUint64Array([0n, 0x100000001n]));
    expect(() => aboveUint32.fieldRange(0)).toThrow('exceeds backing storage: 4294967297');

    const maxSafeRow = new NativeCsvRowView(
      data,
      new BigUint64Array([0n, BigInt(Number.MAX_SAFE_INTEGER)]),
      new BigUint64Array([0n, 1n]),
    );
    expect(() => maxSafeRow.fieldCount).toThrow('exceeds backing storage: 9007199254740991');

    const maxSafe = new NativeCsvRowView(data, rowOffsets, new BigUint64Array([0n, BigInt(Number.MAX_SAFE_INTEGER)]));
    expect(() => maxSafe.fieldRange(0)).toThrow('exceeds backing storage: 9007199254740991');

    const unsafe = new NativeCsvRowView(
      data,
      rowOffsets,
      new BigUint64Array([0n, BigInt(Number.MAX_SAFE_INTEGER) + 1n]),
    );
    expect(() => unsafe.fieldRange(0)).toThrow('exceeds Number.MAX_SAFE_INTEGER: 9007199254740992');

    const valid = new NativeCsvRowView(data, rowOffsets, new BigUint64Array([0n, 1n]));
    expect(() => valid.fieldRange(0.5)).toThrow('field offset index out of range: 0.5');
    expect(() => valid.moveTo(-1)).toThrow('row -1 offset index out of range: -1');
    expect(() => valid.moveTo(2)).toThrow('row 2 offset index out of range: 2');
  });

  test('preserves closed-batch errors', () => {
    using parser = new NativeCsvParser({ delimiter: ';' });
    const batch = parser.writeBatch(readCsvFixture('native/quoted-semicolon-people.csv'), true);
    batch.close();

    expect(() => batch.rowsInto([])).toThrow('native CSV batch is closed');
    expect(() => batch.rowFieldCount(0)).toThrow('native CSV batch is closed');
    expect(() => batch.fieldRange(0, 0)).toThrow('native CSV batch is closed');
  });

  test('parseCsvBuffer materializes selected columns', () => {
    expect(parseCsvBuffer(readCsvFixture('native/quoted-semicolon-one-person-with-header.csv'), {
      delimiter: ';',
      selectedColumns: [0, 2],
    })).toEqual([
      ['id', 'uf'],
      ['1', 'SP'],
    ]);
  });

  test('rejects offsets that cannot be represented safely or exceed backing storage', () => {
    const unsafe = new NativeCsvRowView(
      Buffer.alloc(0),
      new BigUint64Array([0n, BigInt(Number.MAX_SAFE_INTEGER) + 1n]),
      new BigUint64Array([0n]),
    );
    expect(() => unsafe.fieldCount).toThrow('exceeds Number.MAX_SAFE_INTEGER');

    const outsideData = new NativeCsvRowView(
      Buffer.from('a'),
      new BigUint64Array([0n, 1n]),
      new BigUint64Array([0n, 2n]),
    );
    expect(() => outsideData.fieldRange(0)).toThrow('exceeds backing storage');
  });
});
