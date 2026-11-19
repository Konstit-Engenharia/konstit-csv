import { read } from 'bun:ffi';
import { isUtf8 } from 'node:buffer';
import {
  decodeMaterializedField,
  prepareRow,
} from './materialize-field.js';
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

const visitBatchRows = Symbol('visitBatchRows');
// Bound the backing string a caller can retain by keeping one field.
const WINDOW_BYTES = 1024;
// Long fields amortize a direct decoder call without a speculative copy of nearby bytes.
const MAX_WINDOW_FIELD_BYTES = 64;

/**
 * A reusable, low-allocation view over one row in a {@link NativeCsvBatch}.
 *
 * `NativeCsvBatch.forEachRow()` moves one instance across the batch instead of
 * allocating a new view for every row. Read the row during the callback; the
 * same object is moved before the next callback. Byte and buffer results are
 * views over the batch's backing storage and must not be retained after the
 * batch is closed.
 */
export class NativeCsvRowView {
  #data: Buffer;
  #rowOffsetWords: Uint32Array;
  #fieldOffsets: BigUint64Array;
  #fieldOffsetWords: Uint32Array;
  #rowIndex: number;
  // Standalone views borrow caller-owned arrays. Callback views borrow an open batch until release.
  #owner: NativeCsvBatch | null | undefined;

  /**
   * Creates a row view over packed batch storage.
   *
   * Most callers should obtain a view from `NativeCsvBatch.forEachRow()`.
   * Direct construction is useful when integrating with a compatible native
   * batch representation.
   *
   * @param data Concatenated field bytes for the batch.
   * @param rowOffsets Row boundaries expressed as indexes into `fieldOffsets`.
   * The array must contain one entry per row plus a final end offset.
   * @param fieldOffsets Field boundaries expressed as byte offsets into `data`.
   * The array must contain one entry per field plus a final end offset.
   * @param rowIndex Initial zero-based row index. The index is checked when a
   * row property or accessor is first read.
   */
  constructor(data: Buffer, rowOffsets: BigUint64Array, fieldOffsets: BigUint64Array, rowIndex = 0) {
    this.#data = data;
    this.#rowOffsetWords = offsetWords(rowOffsets);
    this.#fieldOffsets = fieldOffsets;
    this.#fieldOffsetWords = offsetWords(fieldOffsets);
    this.#rowIndex = rowIndex;
  }

  /** Zero-based index of the row currently selected by this view. */
  get rowIndex(): number {
    this.#requireActive();
    return this.#rowIndex;
  }

  /** Number of fields in the currently selected row. */
  get fieldCount(): number {
    const [rowStart, rowEnd,] = this.#rowRange(this.#rowIndex);
    return rowEnd - rowStart;
  }

  /**
   * Moves this view to another row in the same batch.
   *
   * @param rowIndex Zero-based row index.
   * @returns This view, so callers can chain the move with a read.
   * @throws {RangeError} If `rowIndex` is outside the row-offset table.
   */
  moveTo(rowIndex: number): this {
    this.#rowRange(rowIndex);
    this.#rowIndex = rowIndex;
    return this;
  }

  /**
   * Returns the byte range for a field in the current row.
   *
   * Column indexes are zero-based and relative to the fields stored in the
   * row. The returned offsets address `data` directly.
   *
   * @param columnIndex Zero-based field index.
   * @returns A half-open byte range, or `null` when the row has no such field.
   * @throws {RangeError} If the row or offset table is malformed.
   */
  range(columnIndex: number): CsvFieldRange | null {
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

  /**
   * Returns a borrowed byte view for a field in the current row.
   *
   * The returned view shares the batch backing storage; consume it before the
   * originating batch is closed.
   *
   * @param columnIndex Zero-based field index.
   * @returns A borrowed byte view, or `null` when the field is absent.
   */
  bytes(columnIndex: number): Uint8Array | null {
    return this.buffer(columnIndex);
  }

  /**
   * Returns a borrowed `Buffer` view for a field in the current row.
   *
   * The returned buffer shares the batch backing storage and is invalid once
   * the originating batch is closed.
   *
   * @param columnIndex Zero-based field index.
   * @returns A borrowed buffer, or `null` when the field is absent.
   */
  buffer(columnIndex: number): Buffer | null {
    const range = this.range(columnIndex);
    if (range === null) {
      return null;
    }
    return this.#data.subarray(range.start, range.end);
  }

  /**
   * Decodes a field as UTF-8 text.
   *
   * @param columnIndex Zero-based field index.
   * @returns The decoded field, or `null` when the field is absent.
   */
  get(columnIndex: number): string | null {
    const range = this.range(columnIndex);
    if (range === null) {
      return null;
    }
    return this.#data.toString('utf8', range.start, range.end);
  }

  /**
   * Materializes selected fields from the current row in the requested order.
   *
   * Missing fields are represented by empty strings, matching `rowsInto()`.
   *
   * @param columns Zero-based field indexes captured before the first read. Duplicate indexes are allowed.
   * @returns A newly allocated array of decoded UTF-8 strings.
   */
  pick(columns: CsvColumns): string[] {
    this.#requireActive();
    const selectedColumns = [...columns];
    const values: string[] = [];
    values.length = selectedColumns.length;
    for (let index = 0; index < selectedColumns.length; ++index) {
      values[index] = this.get(selectedColumns[index] ?? 0) ?? '';
    }
    return values;
  }

  #rowRange(rowIndex: number): readonly [number, number] {
    this.#requireActive();
    const maxFieldIndex = this.#fieldOffsets.length - 1;
    const rowStart = offsetAt(this.#rowOffsetWords, rowIndex, `row ${rowIndex} offset`, maxFieldIndex);
    const rowEnd = offsetAt(this.#rowOffsetWords, rowIndex + 1, `row ${rowIndex} offset`, maxFieldIndex);
    if (rowEnd < rowStart) {
      throw new RangeError(`row ${rowIndex} offsets are not monotonic`);
    }
    return [rowStart, rowEnd];
  }

  #requireActive(): void {
    if (this.#owner === null) {
      throw new Error('row view is only valid during row view callback');
    }
    if (this.#owner?.closed) {
      throw new Error('native CSV batch is closed');
    }
  }

  static [visitBatchRows](batch: NativeCsvBatch, callback: NativeCsvRowCallback): void {
    const rowCount = batch.rowCount;
    const view = new NativeCsvRowView(batch.data(), batch.rowOffsets(), batch.fieldOffsets());
    for (let index = 0; index < rowCount; ++index) {
      view.#owner = batch;
      let result: unknown;
      try {
        result = callback(view.moveTo(index), index);
      } finally {
        view.#owner = null;
      }
      if (
        result !== null && (typeof result === 'object' || typeof result === 'function')
        && 'then' in result && typeof result.then === 'function'
      ) {
        // The synchronous contract error takes precedence over a later rejection from the callback.
        void Promise.resolve(result).catch(() => {});
        throw new TypeError('row view callback must be synchronous');
      }
    }
  }
}

/**
 * Owns one native parser output batch and exposes low-allocation field views.
 *
 * Batches returned by `NativeCsvParser` own native memory until `close()` or
 * disposal. `dataView()`, offset arrays, and field byte views borrow that
 * memory; release or consume them before closing the batch. Use `using` when
 * iterating batches to make this lifetime explicit.
 *
 * A batch contains the fields emitted by the parser for that operation. When a
 * projected operation was used, column indexes refer to the projected fields
 * in their emitted order.
 */
export class NativeCsvBatch {
  #handle: NativePointer | null;
  #data: Buffer | undefined;
  #dataView: Uint8Array | undefined;
  // rowFieldCount uses the same field-count bound for every lookup in an open batch.
  #rowOffsetLimit: number | undefined;
  #rowOffsets: BigUint64Array | undefined;
  #rowOffsetWords: Uint32Array | undefined;
  #fieldOffsets: BigUint64Array | undefined;
  #fieldOffsetWords: Uint32Array | undefined;

  /**
   * Wraps a native batch handle.
   *
   * Callers normally receive instances from `NativeCsvParser`; this constructor
   * is exposed for integrations that already own a compatible native handle.
   *
   * @param handle Native batch pointer returned by the parser ABI. Ownership of
   * the handle transfers to this wrapper; do not wrap the same handle in a
   * second `NativeCsvBatch` instance.
   */
  constructor(handle: NativePointer) {
    this.#handle = handle;
  }

  /** Whether this batch has released its native handle. */
  get closed(): boolean {
    return this.#handle === null;
  }

  /** Number of complete rows stored in this batch. */
  get rowCount(): number {
    return u64ToSafeNumber(native.symbols.csv_batch_row_count(this.#requireHandle()), 'CSV batch row count');
  }

  /** Total number of fields across all rows in this batch. */
  get totalFields(): number {
    return u64ToSafeNumber(native.symbols.csv_batch_total_fields(this.#requireHandle()), 'CSV batch field count');
  }

  /** Number of bytes in the concatenated field-data buffer. */
  get dataLength(): number {
    return u64ToSafeNumber(native.symbols.csv_batch_data_len(this.#requireHandle()), 'CSV batch data length');
  }

  /**
   * Materializes every field as a UTF-8 string.
   *
   * @returns A newly allocated array containing one string array per row.
   * Missing fields are not padded because this overload returns all stored fields.
   */
  rows(): CsvRow[] {
    return this.rowsInto([]);
  }

  /**
   * Visits each row through one reusable {@link NativeCsvRowView}.
   *
   * The callback must be synchronous. Row access is valid only during its call.
   * Copy borrowed bytes before closing the batch.
   *
   * @param callback Function invoked with the reusable row view and its row index.
   */
  forEachRow(callback: NativeCsvRowCallback): void {
    NativeCsvRowView[visitBatchRows](this, callback);
  }

  /**
   * Materializes rows into a caller-owned reusable result array.
   *
   * `target` and its existing row arrays are resized and overwritten in place;
   * this avoids allocating a new outer or inner array for every batch. If
   * `columns` is supplied, each row is emitted in that requested order and a
   * missing field is represented by `''`.
   *
   * @param target Array to fill. It is truncated or extended to `rowCount`.
   * @param columns Optional zero-based field indexes captured before writing to the target.
   * Duplicate indexes are rejected.
   * @returns The same `target` array passed by the caller.
   * @throws {RangeError} If a column index is invalid, repeated, or an offset
   * exceeds the batch backing storage.
   */
  rowsInto(target: CsvRow[], columns?: CsvColumns): CsvRow[] {
    const selectedColumns = normalizeColumns(columns);
    const rowCount = this.rowCount;
    const totalFields = this.totalFields;
    const rowOffsetWords = this.#rowOffsetWordsView();
    const fieldOffsetWords = this.#fieldOffsetWordsView();
    const data = this.data();
    const dataLength = data.byteLength;
    target.length = rowCount;

    if (columns !== undefined) {
      for (let rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
        const fieldStart = offsetAt(rowOffsetWords, rowIndex, rowIndex, totalFields);
        const fieldEnd = offsetAt(rowOffsetWords, rowIndex + 1, rowIndex, totalFields);
        const row = prepareRow(target[rowIndex], selectedColumns.length);

        for (let outputIndex = 0; outputIndex < selectedColumns.length; ++outputIndex) {
          const column = selectedColumns[outputIndex] ?? 0;
          const fieldIndex = fieldStart + column;
          if (fieldIndex >= fieldEnd) {
            row[outputIndex] = '';
            continue;
          }

          const start = offsetAt(fieldOffsetWords, fieldIndex, 'field offset', dataLength);
          const end = offsetAt(fieldOffsetWords, fieldIndex + 1, 'field offset', dataLength);
          row[outputIndex] = decodeMaterializedField(data, start, end, 'utf8');
        }
        target[rowIndex] = row;
      }

      return target;
    }

    let windowStart = 0;
    let windowEnd = 0;
    let text = '';
    let byteIndexed = true;
    let utf16Offsets: Int16Array | undefined;
    const flags = native.symbols.csv_batch_quoted_rows_ptr(this.#requireHandle());
    const quotedRows = flags === null ? undefined : new Uint8Array(toArrayBuffer(flags, 0, rowCount));
    let fieldStart = offsetAt(rowOffsetWords, 0, 0, totalFields);
    let start = offsetAt(fieldOffsetWords, fieldStart, 'field offset', dataLength);
    for (let rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
      const fieldEnd = offsetAt(rowOffsetWords, rowIndex + 1, rowIndex, totalFields);
      const row = prepareRow(target[rowIndex], fieldEnd - fieldStart);
      // In a quoted span, the opening quote, closing quote and terminator surround the payload.
      const leading = quotedRows?.[rowIndex] ?? 0;
      const trailing = leading * 2;
      for (let fieldIndex = fieldStart; fieldIndex < fieldEnd; ++fieldIndex) {
        const rawEnd = offsetAt(fieldOffsetWords, fieldIndex + 1, 'field offset', dataLength);
        const end = rawEnd - trailing;
        start += leading;
        const column = fieldIndex - fieldStart;
        const length = end - start;
        let value: string | undefined;
        if (length > 2 && length <= MAX_WINDOW_FIELD_BYTES) {
          if (start < windowStart || end > windowEnd) {
            windowStart = start;
            windowEnd = utf8WindowEnd(data, start);
            text = decodeMaterializedField(data, start, windowEnd, 'utf8');
            // UTF-8 decoding emits at most one UTF-16 unit per input byte.
            // Equal lengths mean every field boundary maps directly, including lone invalid bytes.
            byteIndexed = text.length === windowEnd - start;
            if (!byteIndexed) {
              utf16Offsets ??= new Int16Array(WINDOW_BYTES + 1);
              if (!indexUtf16Boundaries(data.subarray(start, windowEnd), utf16Offsets)) {
                text = '';
              }
            }
          }
          const from = start - windowStart;
          const to = end - windowStart;
          if (byteIndexed) {
            value = text.slice(from, to);
          } else if (text.length > 0 && utf16Offsets !== undefined) {
            const first = utf16Offsets[from] ?? -1;
            const last = utf16Offsets[to] ?? -1;
            if (first >= 0 && last >= 0) {
              value = text.slice(first, last);
            }
          }
        }
        row[column] = value ?? decodeMaterializedField(data, start, end, 'utf8');
        start = rawEnd;
      }
      target[rowIndex] = row;
      fieldStart = fieldEnd;
    }

    return target;
  }

  /**
   * Returns the concatenated field bytes as a borrowed `Buffer`.
   *
   * The buffer is backed by native batch storage and must not be used after
   * `close()`.
   */
  data(): Buffer {
    if (this.#data !== undefined) {
      return this.#data;
    }

    const view = this.dataView();
    this.#data = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
    return this.#data;
  }

  /**
   * Returns the concatenated field bytes as a borrowed `Uint8Array`.
   *
   * This view shares storage with `data()` and remains valid only while the
   * batch is open.
   */
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

  /**
   * Returns borrowed row boundaries as a `BigUint64Array`.
   *
   * Each value is a field index into `fieldOffsets`; the array has
   * `rowCount + 1` entries. Offsets may exceed `Number.MAX_SAFE_INTEGER`, so
   * keep them as `bigint` unless a checked conversion is appropriate.
   */
  rowOffsets(): BigUint64Array {
    if (this.#rowOffsets !== undefined) {
      return this.#rowOffsets;
    }

    const rowCount = this.rowCount;
    this.#rowOffsets = new BigUint64Array(toArrayBuffer(this.#rowOffsetsPointer(), 0, (rowCount + 1) * BigUint64Array.BYTES_PER_ELEMENT));
    return this.#rowOffsets;
  }

  /**
   * Returns borrowed field byte boundaries as a `BigUint64Array`.
   *
   * Each value is a byte offset into `data()`; the array has
   * `totalFields + 1` entries. Offsets may exceed `Number.MAX_SAFE_INTEGER`,
   * so keep them as `bigint` unless a checked conversion is appropriate.
   */
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

  /**
   * Returns the number of fields in one row.
   *
   * @param rowIndex Zero-based row index.
   * @throws {RangeError} If `rowIndex` is outside the batch.
   */
  rowFieldCount(rowIndex: number): number {
    const firstLookupWithoutView = this.#rowOffsetLimit === undefined && this.#rowOffsets === undefined;
    this.#rowOffsetLimit ??= this.totalFields;
    const totalFields = this.#rowOffsetLimit;
    if (!Number.isInteger(rowIndex) || rowIndex < 0) {
      throw new RangeError(`row ${rowIndex} offset index out of range: ${rowIndex}`);
    }
    // The first lookup can read both boundaries without allocating views. Bun 1.4.0 takes signed 32-bit byte offsets.
    if (
      firstLookupWithoutView && rowIndex < MAX_DIRECT_ROW_INDEX_EXCLUSIVE
      && rowIndex < native.symbols.csv_batch_row_count(this.#requireHandle())
    ) {
      const ptr = this.#rowOffsetsPointer();
      const byteOffset = rowIndex * BigUint64Array.BYTES_PER_ELEMENT;
      const start = Number(read.u64(ptr, byteOffset));
      const end = Number(read.u64(ptr, byteOffset + BigUint64Array.BYTES_PER_ELEMENT));
      if (start <= totalFields && end <= totalFields) {
        return end - start;
      }
      // The offset view reports the exact value if a boundary exceeds the safe field count.
    }
    const rowOffsetWords = this.#rowOffsetWords ?? this.#rowOffsetWordsView();
    const start = offsetAt(rowOffsetWords, rowIndex, `row ${rowIndex} offset`, totalFields);
    const end = offsetAt(rowOffsetWords, rowIndex + 1, `row ${rowIndex} offset`, totalFields);
    return end - start;
  }

  /**
   * Returns a field's byte range within the concatenated batch data.
   *
   * @param rowIndex Zero-based row index.
   * @param columnIndex Zero-based field index relative to that row.
   * @returns A half-open byte range, or `null` when the row has no such field.
   * @throws {RangeError} If the row or offset tables are invalid.
   */
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

  /**
   * Returns a borrowed `Buffer` view for one field.
   *
   * @param rowIndex Zero-based row index.
   * @param columnIndex Zero-based field index relative to that row.
   * @returns A view backed by the batch data, or `null` when the field is absent.
   */
  fieldBuffer(rowIndex: number, columnIndex: number): Buffer | null {
    const bytes = this.fieldBytes(rowIndex, columnIndex);
    if (bytes === null) {
      return null;
    }
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /**
   * Returns a borrowed `Uint8Array` view for one field.
   *
   * @param rowIndex Zero-based row index.
   * @param columnIndex Zero-based field index relative to that row.
   * @returns A view backed by the batch data, or `null` when the field is absent.
   */
  fieldBytes(rowIndex: number, columnIndex: number): Uint8Array | null {
    const range = this.fieldRange(rowIndex, columnIndex);
    if (range === null) {
      return null;
    }
    return this.dataView().subarray(range.start, range.end);
  }

  /**
   * Decodes one field as UTF-8 text.
   *
   * @param rowIndex Zero-based row index.
   * @param columnIndex Zero-based field index relative to that row.
   * @returns The decoded text, or `null` when the field is absent.
   */
  fieldString(rowIndex: number, columnIndex: number): string | null {
    const range = this.fieldRange(rowIndex, columnIndex);
    if (range === null) {
      return null;
    }
    return this.data().toString('utf8', range.start, range.end);
  }

  /**
   * Visits the byte range of one column for a contiguous row interval.
   *
   * Rows that do not contain `columnIndex` are skipped. The callback receives
   * offsets into `data()` and is invoked synchronously.
   *
   * @param columnIndex Zero-based field index relative to each row.
   * @param callback Receives `(rowIndex, start, end)` for each present field.
   * @param startRow Inclusive first row; defaults to `0`.
   * @param endRow Exclusive end row; defaults to `rowCount`.
   * @throws {RangeError} If the row interval is invalid or an offset exceeds
   * the batch backing storage.
   */
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
      this.#requireHandle(); // A callback can close the batch between rows.
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

  /**
   * Visits one column's borrowed bytes for a contiguous row interval.
   *
   * Missing fields are skipped. Each `Uint8Array` shares the batch backing
   * storage and must be consumed during the callback.
   *
   * @param columnIndex Zero-based field index relative to each row.
   * @param callback Receives `(rowIndex, bytes)` for each present field.
   * @param startRow Inclusive first row; defaults to `0`.
   * @param endRow Exclusive end row; defaults to `rowCount`.
   */
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

  /**
   * Scans several columns while reusing one range array per row.
   *
   * `ranges` contains two numeric offsets per requested column in the same
   * order as `columns`: `[start0, end0, start1, end1, ...]`. A missing field is
   * reported as `[-1, -1]`. Both `ranges` and `data` are reused/borrowed and
   * must be consumed synchronously by the callback.
   *
   * @param columns Zero-based field indexes relative to each row, copied once at the start of the scan.
   * @param callback Receives `(rowIndex, ranges, data)` for each row.
   * @param startRow Inclusive first row; defaults to `0`.
   * @param endRow Exclusive end row; defaults to `rowCount`.
   * @throws {RangeError} If the row interval or an offset is invalid.
   */
  scanColumns(
    columns: CsvColumns,
    callback: CsvScanColumnsCallback,
    startRow = 0,
    endRow = this.rowCount,
  ): void {
    const resolvedEndRow = this.#resolveEndRow(endRow);
    this.#validateRowRange(startRow, resolvedEndRow);
    const selectedColumns = [...columns];
    const rowOffsetWords = this.#rowOffsetWordsView();
    const fieldOffsetWords = this.#fieldOffsetWordsView();
    const data = this.data();
    const totalFields = this.totalFields;
    const ranges = new Float64Array(selectedColumns.length * 2);

    for (let rowIndex = startRow; rowIndex < resolvedEndRow; ++rowIndex) {
      this.#requireHandle(); // A callback can close the batch between rows.
      const rowStart = offsetAt(rowOffsetWords, rowIndex, `row ${rowIndex} offset`, totalFields);
      const rowEnd = offsetAt(rowOffsetWords, rowIndex + 1, `row ${rowIndex} offset`, totalFields);

      for (let columnOffset = 0; columnOffset < selectedColumns.length; ++columnOffset) {
        const columnIndex = selectedColumns[columnOffset] ?? 0;
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

  /**
   * Counts rows whose field equals a supplied byte value.
   *
   * A string value is encoded as UTF-8; `Buffer` and `Uint8Array` values are
   * compared as supplied.
   *
   * @param columnIndex Zero-based field index relative to each row.
   * @param value String or bytes to compare.
   * @returns The number of matching rows.
   * @throws {RangeError} If `columnIndex` is invalid.
   */
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

  /**
   * Releases the native batch and invalidates borrowed data and offset views.
   *
   * Calling `close()` more than once is safe.
   */
  close(): void {
    if (this.#handle !== null) {
      native.symbols.csv_batch_destroy(this.#handle);
      this.#handle = null;
      this.#data = undefined;
      this.#dataView = undefined;
      this.#rowOffsetLimit = undefined;
      this.#rowOffsets = undefined;
      this.#rowOffsetWords = undefined;
      this.#fieldOffsets = undefined;
      this.#fieldOffsetWords = undefined;
    }
  }

  /** Implements `using` / explicit resource management. */
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

  #rowOffsetsPointer(): NativePointer {
    const ptr = native.symbols.csv_batch_row_offsets_ptr(this.#requireHandle());
    if (ptr === null) {
      throw new Error('native CSV batch row offsets are null');
    }
    return ptr;
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

/**
 * Owns a batch of original decompressed records. Consume or copy borrowed bytes
 * before closing the batch. Each batch can be disposed independently of its iterator.
 */
export class NativeCsvRawRecordBatch {
  #handle: NativePointer | null;
  #rowCount: number | undefined;
  #data: Uint8Array | undefined;
  #byteOffsets: Uint32Array | undefined;
  #fieldCounts: Uint32Array | undefined;

  /** @internal */
  constructor(handle: NativePointer) {
    this.#handle = handle;
  }

  /** Whether the native storage has been released. */
  get closed(): boolean {
    return this.#handle === null;
  }

  /** Number of accepted records in this batch. */
  get rowCount(): number {
    this.#rowCount ??= u64ToSafeNumber(native.symbols.csv_batch_row_count(this.#requireHandle()), 'CSV batch row count');
    return this.#rowCount;
  }

  /** Returns the original decompressed bytes for a zero-based row, including its LF when present. */
  rowBytes(rowIndex: number): Uint8Array {
    this.#validateRowIndex(rowIndex);
    if (this.#data === undefined) {
      const handle = this.#requireHandle();
      this.#data = new Uint8Array(toArrayBuffer(
        requirePtr(native.symbols.csv_batch_data_ptr(handle)),
        0,
        u64ToSafeNumber(native.symbols.csv_batch_data_len(handle), 'CSV batch data length'),
      ));
    }
    this.#byteOffsets ??= new Uint32Array(toArrayBuffer(
      requirePtr(native.symbols.csv_batch_field_offsets_ptr(this.#requireHandle())),
      0,
      (this.rowCount + 1) * BigUint64Array.BYTES_PER_ELEMENT,
    ));
    const data = this.#data;
    const offsets = this.#byteOffsets;
    const start = offsetAt(offsets, rowIndex, 'raw row byte offset', data.length);
    const end = offsetAt(offsets, rowIndex + 1, 'raw row byte offset', data.length);
    return data.subarray(start, end);
  }

  /** Returns the physical field count for a zero-based row, including empty fields. */
  rowFieldCount(rowIndex: number): number {
    this.#validateRowIndex(rowIndex);
    this.#fieldCounts ??= new Uint32Array(toArrayBuffer(
      requirePtr(native.symbols.csv_batch_row_offsets_ptr(this.#requireHandle())),
      0,
      (this.rowCount + 1) * BigUint64Array.BYTES_PER_ELEMENT,
    ));
    const offsets = this.#fieldCounts;
    const start = offsetAt(offsets, rowIndex, 'raw row field offset', Number.MAX_SAFE_INTEGER);
    const end = offsetAt(offsets, rowIndex + 1, 'raw row field offset', Number.MAX_SAFE_INTEGER);
    return end - start;
  }

  /** Releases the native storage and invalidates borrowed bytes. Safe to call more than once. */
  close(): void {
    if (this.#handle !== null) {
      native.symbols.csv_batch_destroy(this.#handle);
      this.#handle = null;
      this.#rowCount = undefined;
      this.#data = undefined;
      this.#byteOffsets = undefined;
      this.#fieldCounts = undefined;
    }
  }

  /** Releases the native storage at the end of a `using` scope. */
  [Symbol.dispose](): void {
    this.close();
  }

  #validateRowIndex(rowIndex: number): void {
    const count = this.rowCount;
    if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= count) {
      throw new RangeError(`row index out of range: ${rowIndex}`);
    }
  }

  #requireHandle(): NativePointer {
    if (this.#handle === null) {
      throw new Error('native CSV raw-record batch is closed');
    }
    return this.#handle;
  }
}

const UINT32_BASE = 0x1_0000_0000;
const UINT32_BASE_BIGINT = 0x1_0000_0000n;
const MAX_SAFE_OFFSET_HIGH_WORD = 0x1f_ffff;
const MAX_DIRECT_ROW_INDEX_EXCLUSIVE = Math.floor(0x7fff_ffff / BigUint64Array.BYTES_PER_ELEMENT);

function offsetWords(offsets: BigUint64Array): Uint32Array {
  // Native offsets are little-endian on every supported target.
  return new Uint32Array(offsets.buffer, offsets.byteOffset, offsets.length * 2);
}

function utf8WindowEnd(data: Buffer, start: number): number {
  const limit = start + WINDOW_BYTES;
  if (limit >= data.length) {
    return data.length;
  }
  // Back up to the leading byte if the cutoff bisects a UTF-8 scalar.
  let end = limit;
  while (limit - end < 3 && ((data[end] as number) & 0xc0) === 0x80) {
    --end;
  }
  return end;
}

function indexUtf16Boundaries(bytes: Buffer, offsets: Int16Array): boolean {
  if (!isUtf8(bytes)) {
    return false;
  }
  let units = 0;
  for (let i = 0; i < bytes.length; ++i) {
    const byte = bytes[i] as number;
    if ((byte & 0xc0) === 0x80) {
      // Fields that split a scalar must be decoded separately.
      offsets[i] = -1;
    } else {
      offsets[i] = units;
      units += byte >= 0xf0 ? 2 : 1;
    }
  }
  offsets[bytes.length] = units;
  return true;
}

function offsetAt(offsets: Uint32Array, index: number, label: string | number, upperBound: number): number {
  // Keep single-word reads small enough to inline in the field loop.
  const wordIndex = index * 2;
  const low = offsets[wordIndex];
  const high = offsets[wordIndex + 1];
  if (high === 0 && low !== undefined && low <= upperBound && Number.isInteger(index)) {
    return low;
  }
  return checkedWideOffset(low, high, index, label, upperBound);
}

function checkedWideOffset(
  low: number | undefined,
  high: number | undefined,
  index: number,
  label: string | number,
  upperBound: number,
): number {
  const description = typeof label === 'number' ? `row ${label} offset` : label;
  if (low === undefined || high === undefined || !Number.isInteger(index)) {
    throw new RangeError(`${description} index out of range: ${index}`);
  }
  if (high > MAX_SAFE_OFFSET_HIGH_WORD) {
    const value = BigInt(high) * UINT32_BASE_BIGINT + BigInt(low);
    throw new RangeError(`${description} exceeds Number.MAX_SAFE_INTEGER: ${value}`);
  }
  const offset = low + high * UINT32_BASE;
  if (offset > upperBound) {
    throw new RangeError(`${description} exceeds backing storage: ${offset}`);
  }
  return offset;
}
