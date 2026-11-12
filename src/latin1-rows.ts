import {
  copyLatin1Range,
  latin1Pair,
} from './materialize-field.js';
import {
  EMPTY_BUFFER,
  native,
  type NativePointer,
  requirePtr,
  toArrayBuffer,
  u64ToSafeNumber,
} from './native.js';
import { normalizeChunk } from './normalize.js';
import type { CsvNativeFilterProgramEntry } from './normalize.js';
import {
  nativeCsvParserFinalizer,
  prepareNativeParser,
} from './parser.js';
import type {
  CsvColumns,
  CsvDelimiter,
  CsvRow,
} from './types.js';

// These opaque batches contain Latin1 bytes and are never wrapped in NativeCsvBatch.
export async function* latin1Rows(
  chunks: AsyncIterable<Uint8Array>,
  delimiter: CsvDelimiter,
  columns: CsvColumns | undefined,
  filters: readonly CsvNativeFilterProgramEntry[] | undefined,
  createParser: (delimiter: number) => NativePointer | null,
  reusableRows?: CsvRow[],
): AsyncGenerator<CsvRow[], void> {
  if (delimiter === 'auto') {
    throw new Error('automatic delimiter detection is only supported by file APIs');
  }
  if (delimiter.length !== 1) {
    throw new Error('delimiter must be one character');
  }
  const parser = createParser(delimiter.charCodeAt(0));
  if (parser === null) {
    throw new Error('failed to create native CSV parser');
  }
  // A suspended iterator can be abandoned before its finally block runs.
  const lifetime = {};
  nativeCsvParserFinalizer.register(lifetime, parser, lifetime);
  try {
    const prepared = prepareNativeParser(parser, columns, filters);
    for await (const chunk of chunks) {
      const input = normalizeChunk(chunk);
      const batch = prepared.writeBatch(input, false);
      const rows = consumeLatin1Batch(parser, batch, reusableRows);
      if (rows.length > 0) {
        yield rows;
      }
    }
    const batch = prepared.writeBatch(EMPTY_BUFFER, true);
    const rows = consumeLatin1Batch(parser, batch, reusableRows);
    if (rows.length > 0) {
      yield rows;
    }
  } finally {
    nativeCsvParserFinalizer.unregister(lifetime);
    native.symbols.csv_parser_destroy(parser);
  }
}

function consumeLatin1Batch(parser: NativePointer, batch: NativePointer | null, reusableRows?: CsvRow[]): CsvRow[] {
  if (batch === null) {
    throw new Error(`native CSV parser failed: ${native.symbols.csv_parser_last_error(parser) ?? 'native parser error unavailable'}`);
  }
  try {
    const rowCount = u64ToSafeNumber(native.symbols.csv_batch_row_count(batch), 'CSV batch row count');
    if (rowCount === 0) {
      return [];
    }
    const totalFields = u64ToSafeNumber(native.symbols.csv_batch_total_fields(batch), 'CSV batch field count');
    const dataLength = u64ToSafeNumber(native.symbols.csv_batch_data_len(batch), 'CSV batch data length');
    const data = dataLength === 0
      ? EMPTY_BUFFER
      : new Uint8Array(toArrayBuffer(requirePtr(native.symbols.csv_batch_data_ptr(batch)), 0, dataLength));
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const rowOffsets = new Uint32Array(
      toArrayBuffer(requirePtr(native.symbols.csv_batch_row_offsets_ptr(batch)), 0, (rowCount + 1) * 8),
    );
    const fieldOffsets = new Uint32Array(
      toArrayBuffer(requirePtr(native.symbols.csv_batch_field_offsets_ptr(batch)), 0, (totalFields + 1) * 8),
    );
    const flags = native.symbols.csv_batch_quoted_rows_ptr(batch);
    const quotedRows = flags === null ? undefined : new Uint8Array(toArrayBuffer(flags, 0, rowCount));
    const rows: CsvRow[] = reusableRows ?? [];
    rows.length = rowCount;
    let fieldStart = checkedOffset(rowOffsets, 0, totalFields);
    let start = checkedOffset(fieldOffsets, fieldStart, dataLength);
    for (let rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
      const fieldEnd = checkedOffset(rowOffsets, rowIndex + 1, totalFields);
      // A raw span starts with a quote and ends with a quote and delimiter or LF.
      const leading = quotedRows?.[rowIndex] ?? 0;
      const trailing = leading * 2;
      const row = reusableRows?.[rowIndex] ?? [];
      const width = fieldEnd - fieldStart;
      row.length = width;
      for (let column = 0; column < width; ++column) {
        const end = checkedOffset(fieldOffsets, fieldStart + column + 1, dataLength);
        const payload = start + leading;
        const payloadEnd = end - trailing;
        const length = payloadEnd - payload;
        // Short fields use strings keyed by their bytes, so they can outlive the batch.
        switch (length) {
          case 0:
            row[column] = '';
            break;
          case 1:
            row[column] = String.fromCharCode(view.getUint8(payload));
            break;
          case 2:
            row[column] = latin1Pair(view.getUint16(payload, true));
            break;
          case 3:
            row[column] = latin1Pair(view.getUint16(payload, true)) + String.fromCharCode(view.getUint8(payload + 2));
            break;
          case 4:
            row[column] = latin1Pair(view.getUint16(payload, true)) + latin1Pair(view.getUint16(payload + 2, true));
            break;
          default:
            if (length < 0) {
              throw new RangeError('CSV field span exceeds its backing range');
            }
            row[column] = copyLatin1Range(bytes, payload, payloadEnd);
        }
        start = end;
      }
      rows[rowIndex] = row;
      fieldStart = fieldEnd;
    }
    return rows;
  } finally {
    native.symbols.csv_batch_destroy(batch);
  }
}

export function checkedOffset(words: Uint32Array, index: number, upperBound: number): number {
  // Offsets are little-endian. Keep the common single-word read small enough to inline in the field loop.
  const low = words[index * 2];
  const high = words[index * 2 + 1];
  if (low !== undefined && high === 0 && low <= upperBound) {
    return low;
  }
  return checkedWideOffset(low, high, upperBound);
}

function checkedWideOffset(low: number | undefined, high: number | undefined, upperBound: number): number {
  if (low === undefined || high === undefined || high > 0x1f_ffff) {
    throw new RangeError('CSV batch offset out of range');
  }
  const offset = low + high * 0x1_0000_0000;
  if (offset > upperBound) {
    throw new RangeError('CSV batch offset exceeds backing storage');
  }
  return offset;
}
