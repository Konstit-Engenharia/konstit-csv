import {
  EMPTY_BUFFER,
  native,
  type NativePointer,
  requirePtr,
  toArrayBuffer,
  u64ToSafeNumber,
} from './native.js';
import {
  normalizeColumns,
  normalizeFilterColumn,
} from './normalize.js';
import type {
  CsvColumnBytesCallback,
  CsvColumnRangeCallback,
  CsvColumns,
  CsvFieldRange,
  CsvRow,
  CsvScanColumnsCallback,
  NativeCsvRowCallback,
} from './types.js';

export class NativeCsvRowView {
  #data: Buffer;
  #rowOffsetWords: Uint32Array;
  #fieldOffsets: BigUint64Array;
  #fieldOffsetWords: Uint32Array;
  #rowIndex: number;

  constructor(data: Buffer, rowOffsets: BigUint64Array, fieldOffsets: BigUint64Array, rowIndex = 0) {
    this.#data = data;
    this.#rowOffsetWords = offsetWords(rowOffsets);
    this.#fieldOffsets = fieldOffsets;
    this.#fieldOffsetWords = offsetWords(fieldOffsets);
    this.#rowIndex = rowIndex;
  }

  get rowIndex(): number {
    return this.#rowIndex;
  }

  get fieldCount(): number {
    const [rowStart, rowEnd,] = this.#rowRange(this.#rowIndex);
    return rowEnd - rowStart;
  }

  moveTo(rowIndex: number): this {
    this.#rowRange(rowIndex);
    this.#rowIndex = rowIndex;
    return this;
  }

  fieldRange(columnIndex: number): CsvFieldRange | null {
    const [rowStart, rowEnd,] = this.#rowRange(this.#rowIndex);

    const fieldIndex = rowStart + columnIndex;
    if (fieldIndex < rowStart || fieldIndex >= rowEnd) {
      return null;
    }

    return {
      start: offsetAt(this.#fieldOffsetWords, fieldIndex, 'field offset', this.#data.byteLength),
      end: offsetAt(this.#fieldOffsetWords, fieldIndex + 1, 'field offset', this.#data.byteLength),
    };
  }

  range(columnIndex: number): CsvFieldRange | null {
    return this.fieldRange(columnIndex);
  }

  fieldBytes(columnIndex: number): Uint8Array | null {
    const range = this.fieldRange(columnIndex);
    if (range === null) {
      return null;
    }
    return this.#data.subarray(range.start, range.end);
  }

  bytes(columnIndex: number): Uint8Array | null {
    return this.fieldBytes(columnIndex);
  }

  fieldBuffer(columnIndex: number): Buffer | null {
    const range = this.fieldRange(columnIndex);
    if (range === null) {
      return null;
    }
    return this.#data.subarray(range.start, range.end);
  }

  buffer(columnIndex: number): Buffer | null {
    return this.fieldBuffer(columnIndex);
  }

  fieldString(columnIndex: number): string | null {
    const range = this.fieldRange(columnIndex);
    if (range === null) {
      return null;
    }
    return this.#data.toString('utf8', range.start, range.end);
  }

  getPhysical(columnIndex: number): string | null {
    return this.fieldString(columnIndex);
  }

  get(columnIndex: number): string | null {
    return this.getPhysical(columnIndex);
  }

  pickPhysical(columns: CsvColumns): string[] {
    const values: string[] = [];
    values.length = columns.length;
    for (let index = 0; index < columns.length; ++index) {
      values[index] = this.fieldString(columns[index] ?? 0) ?? '';
    }
    return values;
  }

  pick(columns: CsvColumns): string[] {
    return this.pickPhysical(columns);
  }

  #rowRange(rowIndex: number): readonly [number, number] {
    const maxFieldIndex = this.#fieldOffsets.length - 1;
    const rowStart = offsetAt(this.#rowOffsetWords, rowIndex, `row ${rowIndex} offset`, maxFieldIndex);
    const rowEnd = offsetAt(this.#rowOffsetWords, rowIndex + 1, `row ${rowIndex} offset`, maxFieldIndex);
    if (rowEnd < rowStart) {
      throw new RangeError(`row ${rowIndex} offsets are not monotonic`);
    }
    return [rowStart, rowEnd];
  }
}

export class NativeCsvBatch {
  #handle: NativePointer | null;
  #data: Buffer | undefined;
  #dataView: Uint8Array | undefined;
  #rowOffsets: BigUint64Array | undefined;
  #rowOffsetWords: Uint32Array | undefined;
  #fieldOffsets: BigUint64Array | undefined;
  #fieldOffsetWords: Uint32Array | undefined;

  constructor(handle: NativePointer) {
    this.#handle = handle;
  }

  get closed(): boolean {
    return this.#handle === null;
  }

  get rowCount(): number {
    return u64ToSafeNumber(native.symbols.csv_batch_row_count(this.#requireHandle()), 'CSV batch row count');
  }

  get totalFields(): number {
    return u64ToSafeNumber(native.symbols.csv_batch_total_fields(this.#requireHandle()), 'CSV batch field count');
  }

  get dataLength(): number {
    return u64ToSafeNumber(native.symbols.csv_batch_data_len(this.#requireHandle()), 'CSV batch data length');
  }

  rows(): CsvRow[] {
    return this.rowsInto([]);
  }

  forEachRow(callback: NativeCsvRowCallback): void {
    const rowCount = this.rowCount;
    const rowView = new NativeCsvRowView(this.data(), this.rowOffsets(), this.fieldOffsets());
    for (let rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
      callback(rowView.moveTo(rowIndex), rowIndex);
    }
  }

  rowsInto(target: CsvRow[], columns?: CsvColumns): CsvRow[] {
    normalizeColumns(columns);
    const rowCount = this.rowCount;
    const totalFields = this.totalFields;
    const rowOffsetWords = this.#rowOffsetWordsView();
    const fieldOffsetWords = this.#fieldOffsetWordsView();
    const data = this.data();
    target.length = rowCount;

    if (columns !== undefined) {
      for (let rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
        const fieldStart = offsetAt(rowOffsetWords, rowIndex, `row ${rowIndex} offset`, totalFields);
        const fieldEnd = offsetAt(rowOffsetWords, rowIndex + 1, `row ${rowIndex} offset`, totalFields);
        const existing = target[rowIndex];
        const row = existing === undefined ? [] : existing;
        row.length = columns.length;

        for (let outputIndex = 0; outputIndex < columns.length; ++outputIndex) {
          const column = columns[outputIndex] ?? 0;
          const fieldIndex = fieldStart + column;
          if (fieldIndex >= fieldEnd) {
            row[outputIndex] = '';
            continue;
          }

          const start = offsetAt(fieldOffsetWords, fieldIndex, 'field offset', data.byteLength);
          const end = offsetAt(fieldOffsetWords, fieldIndex + 1, 'field offset', data.byteLength);
          row[outputIndex] = data.toString('utf8', start, end);
        }
        target[rowIndex] = row;
      }

      return target;
    }

    for (let rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
      const fieldStart = offsetAt(rowOffsetWords, rowIndex, `row ${rowIndex} offset`, totalFields);
      const fieldEnd = offsetAt(rowOffsetWords, rowIndex + 1, `row ${rowIndex} offset`, totalFields);
      const existing = target[rowIndex];
      const row = existing === undefined ? [] : existing;
      row.length = fieldEnd - fieldStart;
      for (let fieldIndex = fieldStart; fieldIndex < fieldEnd; ++fieldIndex) {
        const start = offsetAt(fieldOffsetWords, fieldIndex, 'field offset', data.byteLength);
        const end = offsetAt(fieldOffsetWords, fieldIndex + 1, 'field offset', data.byteLength);
        const column = fieldIndex - fieldStart;
        row[column] = data.toString('utf8', start, end);
      }
      target[rowIndex] = row;
    }

    return target;
  }

  data(): Buffer {
    if (this.#data !== undefined) {
      return this.#data;
    }

    const view = this.dataView();
    this.#data = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
    return this.#data;
  }

  dataView(): Uint8Array {
    if (this.#dataView !== undefined) {
      return this.#dataView;
    }

    const handle = this.#requireHandle();
    const dataLen = u64ToSafeNumber(native.symbols.csv_batch_data_len(handle), 'CSV batch data length');
    const dataPtr = native.symbols.csv_batch_data_ptr(handle);
    this.#dataView = dataLen === 0 ? new Uint8Array(0) : new Uint8Array(toArrayBuffer(requirePtr(dataPtr), 0, dataLen));
    return this.#dataView;
  }

  rowOffsets(): BigUint64Array {
    if (this.#rowOffsets !== undefined) {
      return this.#rowOffsets;
    }

    const rowCount = this.rowCount;
    const ptr = native.symbols.csv_batch_row_offsets_ptr(this.#requireHandle());
    if (ptr === null) {
      throw new Error('native CSV batch row offsets are null');
    }
    this.#rowOffsets = new BigUint64Array(toArrayBuffer(ptr, 0, (rowCount + 1) * BigUint64Array.BYTES_PER_ELEMENT));
    return this.#rowOffsets;
  }

  fieldOffsets(): BigUint64Array {
    if (this.#fieldOffsets !== undefined) {
      return this.#fieldOffsets;
    }

    const totalFields = this.totalFields;
    const ptr = native.symbols.csv_batch_field_offsets_ptr(this.#requireHandle());
    if (ptr === null) {
      throw new Error('native CSV batch field offsets are null');
    }
    this.#fieldOffsets = new BigUint64Array(
      toArrayBuffer(ptr, 0, (totalFields + 1) * BigUint64Array.BYTES_PER_ELEMENT),
    );
    return this.#fieldOffsets;
  }

  rowFieldCount(rowIndex: number): number {
    const rowOffsetWords = this.#rowOffsetWordsView();
    const start = offsetAt(rowOffsetWords, rowIndex, `row ${rowIndex} offset`, this.totalFields);
    const end = offsetAt(rowOffsetWords, rowIndex + 1, `row ${rowIndex} offset`, this.totalFields);
    return end - start;
  }

  fieldRange(rowIndex: number, columnIndex: number): CsvFieldRange | null {
    const rowOffsetWords = this.#rowOffsetWordsView();
    const fieldOffsetWords = this.#fieldOffsetWordsView();
    const totalFields = this.totalFields;
    const dataLength = this.dataLength;
    const rowStart = offsetAt(rowOffsetWords, rowIndex, `row ${rowIndex} offset`, totalFields);
    const rowEnd = offsetAt(rowOffsetWords, rowIndex + 1, `row ${rowIndex} offset`, totalFields);

    const fieldIndex = rowStart + columnIndex;
    if (fieldIndex < rowStart || fieldIndex >= rowEnd) {
      return null;
    }

    return {
      start: offsetAt(fieldOffsetWords, fieldIndex, 'field offset', dataLength),
      end: offsetAt(fieldOffsetWords, fieldIndex + 1, 'field offset', dataLength),
    };
  }

  fieldBuffer(rowIndex: number, columnIndex: number): Buffer | null {
    const bytes = this.fieldBytes(rowIndex, columnIndex);
    if (bytes === null) {
      return null;
    }
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  fieldBytes(rowIndex: number, columnIndex: number): Uint8Array | null {
    const range = this.fieldRange(rowIndex, columnIndex);
    if (range === null) {
      return null;
    }
    return this.dataView().subarray(range.start, range.end);
  }

  fieldString(rowIndex: number, columnIndex: number): string | null {
    const range = this.fieldRange(rowIndex, columnIndex);
    if (range === null) {
      return null;
    }
    return this.data().toString('utf8', range.start, range.end);
  }

  forEachColumnRange(
    columnIndex: number,
    callback: CsvColumnRangeCallback,
    startRow = 0,
    endRow = this.rowCount,
  ): void {
    const rowOffsetWords = this.#rowOffsetWordsView();
    const fieldOffsetWords = this.#fieldOffsetWordsView();
    const totalFields = this.totalFields;
    const dataLength = this.dataLength;
    const resolvedEndRow = this.#resolveEndRow(endRow);
    this.#validateRowRange(startRow, resolvedEndRow);

    for (let rowIndex = startRow; rowIndex < resolvedEndRow; ++rowIndex) {
      const rowStart = offsetAt(rowOffsetWords, rowIndex, `row ${rowIndex} offset`, totalFields);
      const rowEnd = offsetAt(rowOffsetWords, rowIndex + 1, `row ${rowIndex} offset`, totalFields);

      const fieldIndex = rowStart + columnIndex;
      if (fieldIndex < rowStart || fieldIndex >= rowEnd) {
        continue;
      }

      callback(
        rowIndex,
        offsetAt(fieldOffsetWords, fieldIndex, 'field offset', dataLength),
        offsetAt(fieldOffsetWords, fieldIndex + 1, 'field offset', dataLength),
      );
    }
  }

  forEachColumnBytes(
    columnIndex: number,
    callback: CsvColumnBytesCallback,
    startRow = 0,
    endRow = this.rowCount,
  ): void {
    const data = this.data();
    this.forEachColumnRange(
      columnIndex,
      (rowIndex, start, end) => {
        callback(rowIndex, data.subarray(start, end));
      },
      startRow,
      endRow,
    );
  }

  scanColumns(
    columns: CsvColumns,
    callback: CsvScanColumnsCallback,
    startRow = 0,
    endRow = this.rowCount,
  ): void {
    const resolvedEndRow = this.#resolveEndRow(endRow);
    this.#validateRowRange(startRow, resolvedEndRow);
    const rowOffsetWords = this.#rowOffsetWordsView();
    const fieldOffsetWords = this.#fieldOffsetWordsView();
    const data = this.data();
    const totalFields = this.totalFields;
    const ranges = new Float64Array(columns.length * 2);

    for (let rowIndex = startRow; rowIndex < resolvedEndRow; ++rowIndex) {
      const rowStart = offsetAt(rowOffsetWords, rowIndex, `row ${rowIndex} offset`, totalFields);
      const rowEnd = offsetAt(rowOffsetWords, rowIndex + 1, `row ${rowIndex} offset`, totalFields);

      for (let columnOffset = 0; columnOffset < columns.length; ++columnOffset) {
        const columnIndex = columns[columnOffset] ?? 0;
        const fieldIndex = rowStart + columnIndex;
        const rangeIndex = columnOffset * 2;
        if (fieldIndex < rowStart || fieldIndex >= rowEnd) {
          ranges[rangeIndex] = -1;
          ranges[rangeIndex + 1] = -1;
          continue;
        }

        ranges[rangeIndex] = offsetAt(fieldOffsetWords, fieldIndex, 'field offset', data.byteLength);
        ranges[rangeIndex + 1] = offsetAt(fieldOffsetWords, fieldIndex + 1, 'field offset', data.byteLength);
      }

      callback(rowIndex, ranges, data);
    }
  }

  countWhereEquals(columnIndex: number, value: string | Buffer | Uint8Array): number {
    normalizeFilterColumn(columnIndex);
    const encoded = typeof value === 'string' ? Buffer.from(value) : value;
    const input = encoded.byteLength === 0 ? EMPTY_BUFFER : encoded;
    return u64ToSafeNumber(
      native.symbols.csv_batch_count_where_equals(
        this.#requireHandle(),
        columnIndex,
        input,
        input,
      ),
      'CSV batch filtered row count',
    );
  }

  close(): void {
    if (this.#handle !== null) {
      native.symbols.csv_batch_destroy(this.#handle);
      this.#handle = null;
      this.#data = undefined;
      this.#dataView = undefined;
      this.#rowOffsets = undefined;
      this.#rowOffsetWords = undefined;
      this.#fieldOffsets = undefined;
      this.#fieldOffsetWords = undefined;
    }
  }

  dispose(): void {
    this.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  #requireHandle(): NativePointer {
    if (this.#handle === null) {
      throw new Error('native CSV batch is closed');
    }
    return this.#handle;
  }

  #rowOffsetWordsView(): Uint32Array {
    const rowOffsets = this.rowOffsets();
    if (this.#rowOffsetWords === undefined) {
      this.#rowOffsetWords = offsetWords(rowOffsets);
    }
    return this.#rowOffsetWords;
  }

  #fieldOffsetWordsView(): Uint32Array {
    const fieldOffsets = this.fieldOffsets();
    if (this.#fieldOffsetWords === undefined) {
      this.#fieldOffsetWords = offsetWords(fieldOffsets);
    }
    return this.#fieldOffsetWords;
  }

  #resolveEndRow(endRow: number): number {
    if (Number.isNaN(endRow)) {
      throw new RangeError(`row index out of range: ${endRow}`);
    }
    return endRow;
  }

  #validateRowRange(startRow: number, endRow: number): void {
    const rowCount = this.rowCount;
    if (!Number.isInteger(startRow) || startRow < 0 || startRow > rowCount) {
      throw new RangeError(`row index out of range: ${startRow}`);
    }
    if (!Number.isInteger(endRow) || endRow < startRow || endRow > rowCount) {
      throw new RangeError(`row index out of range: ${endRow}`);
    }
  }
}

const UINT32_BASE = 0x1_0000_0000;
const UINT32_BASE_BIGINT = 0x1_0000_0000n;
const MAX_SAFE_OFFSET_HIGH_WORD = 0x1f_ffff;

function offsetWords(offsets: BigUint64Array): Uint32Array {
  // Native offsets are little-endian on every supported target.
  return new Uint32Array(offsets.buffer, offsets.byteOffset, offsets.length * 2);
}

function offsetAt(offsets: Uint32Array, index: number, label: string, upperBound: number): number {
  const wordIndex = index * 2;
  const low = offsets[wordIndex];
  const high = offsets[wordIndex + 1];
  if (low === undefined || high === undefined || wordIndex % 2 !== 0) {
    throw new RangeError(`${label} index out of range: ${index}`);
  }
  if (high > MAX_SAFE_OFFSET_HIGH_WORD) {
    const value = BigInt(high) * UINT32_BASE_BIGINT + BigInt(low);
    throw new RangeError(`${label} exceeds Number.MAX_SAFE_INTEGER: ${value}`);
  }
  const offset = low + high * UINT32_BASE;
  if (offset > upperBound) {
    throw new RangeError(`${label} exceeds backing storage: ${offset}`);
  }
  return offset;
}
