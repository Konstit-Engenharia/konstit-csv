import { ptr } from 'bun:ffi';
import {
  expect,
  spyOn,
  test,
} from 'bun:test';
import assert from 'node:assert/strict';
import { NativeCsvRowView } from '../src/batches.ts';
import { findCsvSafeShards } from '../src/files.ts';
import {
  checkedOffset,
  latin1Rows,
} from '../src/latin1-rows.ts';
import {
  EMPTY_BUFFER,
  latin1RowsParser,
  native,
  type NativePointer,
  resolveNativeLibraryPath,
} from '../src/native.ts';
import {
  createPreparedParser,
  NativeCsvParser,
} from '../src/parser.ts';
import type { CsvRegex } from '../src/types.ts';
import { csvFixturePath } from './fixtures.ts';

// The callbacks keep each test's offset array alive while the parser borrows its address.
type OffsetReader = (handle: NativePointer) => NativePointer | null;
const offsetReaders: Record<'csv_split_offsets_batch_ptr' | 'csv_batch_field_offsets_ptr', OffsetReader> = native.symbols;

test('resolves both packaged and explicitly configured native library paths', () => {
  const packaged = resolveNativeLibraryPath(undefined);
  expect(packaged).toContain('libcsv_native.');
  expect(resolveNativeLibraryPath(packaged)).toBe(packaged);
  expect(() => resolveNativeLibraryPath('')).toThrow('must not be empty');
});

test('empty final writes emit the pending matching row in every filtered count mode', () => {
  const equals = { column: 0, value: 'yes' };
  using parser = new NativeCsvParser();
  const countWriters = [
    (data: Buffer, final: boolean) => parser.writeCountWhereEquals(data, equals, final),
    (data: Buffer, final: boolean) => parser.writeCountWhereIn(data, { column: 0, values: ['yes'] }, final),
    (data: Buffer, final: boolean) => parser.writeCountWhereStartsWith(data, { column: 0, prefix: 'y' }, final),
    (data: Buffer, final: boolean) => parser.writeCountWhereAll(data, [equals], final),
    (data: Buffer, final: boolean) => parser.writeCountWhere(data, [equals], final),
  ];
  for (const write of countWriters) {
    parser.reset();
    expect(write(Buffer.from('no\nyes'), false)).toBe(0);
    expect(write(Buffer.alloc(0), true)).toBe(1);
  }
});

test('empty final writes emit pending projections with and without a filter program', () => {
  const equals = { column: 0, value: 'yes' };
  using parser = new NativeCsvParser();
  for (
    const write of [
      (data: Uint8Array, final: boolean) => parser.writeProjectedBatch(data, { columns: [1], equalsFilter: equals }, final),
      (data: Uint8Array, final: boolean) => parser.writeProjectedBatchWhere(data, [1], [equals], final),
    ]
  ) {
    parser.reset();
    using head = write(Buffer.from('no,A\nyes,B'), false);
    using tail = write(EMPTY_BUFFER, true);
    expect(head.rows()).toEqual([]);
    expect(tail.rows()).toEqual([['B']]);
  }
});

test('native filter compilation errors propagate from prepare, write, and finish', () => {
  // JavaScript callers can supply a descriptor that RE2 cannot compile.
  const invalid = [{ column: 0, regex: { source: '(?=x)', flags: '' } as CsvRegex }];
  const error = 'invalid regular expression';
  expect(() => createPreparedParser({}, [0], invalid)).toThrow(error);
  using parser = new NativeCsvParser();
  const input = Buffer.from('x\n');
  expect(() => parser.writeProjectedBatch(input, { filters: invalid })).toThrow(error);
  expect(() => parser.endProjectedBatch({ filters: invalid })).toThrow(error);
  expect(() => parser.writeProjectedBatchWhere(input, [0], invalid)).toThrow(error);
  expect(() => parser.endProjectedBatchWhere([0], invalid)).toThrow(error);
});

test('prepared parsers distinguish native errors from empty results and reject use after close', () => {
  using parser = createPreparedParser({}, [0]);
  using failedCount = spyOn(native.symbols, 'csv_parser_write_prepared_count');
  using failedBatch = spyOn(native.symbols, 'csv_parser_write_prepared_batch');
  failedCount.mockReturnValueOnce(0xffff_ffff_ffff_ffffn);
  failedBatch.mockReturnValueOnce(null);
  expect(() => parser.endCount()).toThrow('native CSV parser failed');
  expect(() => parser.endBatch()).toThrow('native CSV parser failed');
  parser.close();
  expect(() => parser.endCount()).toThrow('native CSV parser is closed');
});

test('incremental parsers enforce delimiter and strict-mode restrictions', () => {
  expect(() => new NativeCsvParser({ delimiter: ',,' })).toThrow('delimiter must be one character');
  expect(() => new NativeCsvParser({ delimiter: '"' })).toThrow('failed to create native CSV parser');
  using parser = new NativeCsvParser({ strict: true });
  expect(() => parser.endProjectedBatch()).toThrow('strict CSV validation is not supported for projected batches');
});

test('missing columns return null and invalid row intervals fail before iteration', () => {
  using parser = new NativeCsvParser();
  using batch = parser.writeBatch(Buffer.from('a\n'));
  expect(batch.fieldBuffer(0, 1)).toBeNull();
  expect(batch.fieldString(0, 1)).toBeNull();
  batch.forEachRow((row) => expect(row.buffer(1)).toBeNull());
  for (const [start, end,] of [[0, NaN], [-1, 1], [1, 0]] as const) {
    expect(() => batch.scanColumns([0], () => assert.fail('unexpected row'), start, end)).toThrow('row index out of range');
  }
  const reversed = new NativeCsvRowView(Buffer.from('x'), new BigUint64Array([1n, 0n]), new BigUint64Array([0n, 1n]));
  expect(() => reversed.fieldCount).toThrow('row 0 offsets are not monotonic');
});

test('a native batch with missing offset tables fails before dereferencing them', () => {
  using parser = new NativeCsvParser();
  using batch = parser.writeBatch(Buffer.from('a\n'));
  using rowOffsets = spyOn(native.symbols, 'csv_batch_row_offsets_ptr');
  using fieldOffsets = spyOn(native.symbols, 'csv_batch_field_offsets_ptr');
  rowOffsets.mockReturnValueOnce(null);
  fieldOffsets.mockReturnValueOnce(null);
  expect(() => batch.rowOffsets()).toThrow('native CSV batch row offsets are null');
  expect(() => batch.fieldOffsets()).toThrow('native CSV batch field offsets are null');
});

test('repeated native split offsets do not create empty shards', () => {
  const path = csvFixturePath('rfc4180/simple-lf.csv');
  const end = Bun.file(path).size;
  const boundaries = new BigUint64Array([0n, 0n, BigInt(end)]);
  using count = spyOn(native.symbols, 'csv_split_offsets_batch_count');
  using offsets = spyOn(offsetReaders, 'csv_split_offsets_batch_ptr');
  count.mockReturnValueOnce(BigInt(boundaries.length));
  offsets.mockImplementation(() => ptr(boundaries));
  expect(findCsvSafeShards(path, 2)).toEqual([{ start: 0, end: end - 1 }]);
});

test('Latin-1 offsets support wide values within the backing range', () => {
  const offset = new Uint32Array([3, 1]);
  expect(checkedOffset(offset, 0, 2 ** 32 + 3)).toBe(2 ** 32 + 3);
  expect(() => checkedOffset(offset, 0, 2 ** 32)).toThrow('exceeds backing storage');
  expect(() => checkedOffset(offset, 1, 0)).toThrow('out of range');
  expect(() => checkedOffset(new Uint32Array([0, 0x200000]), 0, Number.MAX_SAFE_INTEGER)).toThrow('out of range');
});

test('Latin-1 materialization rejects invalid delimiters and truncated quoted spans', async () => {
  const create = latin1RowsParser(undefined);
  async function* chunks() {
    yield Buffer.from('"abc","def"\n');
  }
  for (
    const [delimiter, message,] of [
      ['auto', /automatic delimiter detection/],
      ['::', /one character/],
      ['"', /failed to create/],
    ] as const
  ) {
    await assert.rejects(latin1Rows(chunks(), delimiter, undefined, undefined, create).next(), message);
  }
  const invalid = new BigUint64Array([0n, 1n, 12n]);
  using offsets = spyOn(offsetReaders, 'csv_batch_field_offsets_ptr');
  offsets.mockImplementation(() => ptr(invalid));
  await assert.rejects(latin1Rows(chunks(), ',', undefined, undefined, create).next(), /field span exceeds/);
});
