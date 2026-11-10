import { decodeMaterializedField } from './materialize-field.js';
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
import { prepareNativeParser } from './parser.js';
import type {
  CsvColumns,
  CsvDelimiter,
  CsvRow,
} from './types.js';

const latin1RowsParserFinalizer = new FinalizationRegistry<NativePointer>((parser) => {
  native.symbols.csv_parser_destroy(parser);
});

// These opaque batches contain Latin1 bytes and are never wrapped in NativeCsvBatch.
export async function* latin1Rows(
  chunks: AsyncIterable<Uint8Array>,
  delimiter: CsvDelimiter,
  columns: CsvColumns | undefined,
  filters: readonly CsvNativeFilterProgramEntry[] | undefined,
  createParser: (delimiter: number) => NativePointer | null,
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
  // Preserve the public parser's GC fallback when a suspended iterator is abandoned.
  const lifetime = {};
  latin1RowsParserFinalizer.register(lifetime, parser, lifetime);
  try {
    const prepared = prepareNativeParser(parser, columns, filters);
    for await (const chunk of chunks) {
      const input = normalizeChunk(chunk);
      const batch = prepared.writeBatch(input, false);
      const rows = consumeLatin1Batch(parser, batch);
      if (rows.length > 0) {
        yield rows;
      }
    }
    const batch = prepared.writeBatch(EMPTY_BUFFER, true);
    const rows = consumeLatin1Batch(parser, batch);
    if (rows.length > 0) {
      yield rows;
    }
  } finally {
    latin1RowsParserFinalizer.unregister(lifetime);
    native.symbols.csv_parser_destroy(parser);
  }
}

function consumeLatin1Batch(parser: NativePointer, batch: NativePointer | null): CsvRow[] {
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
    const rowOffsets = new Uint32Array(
      toArrayBuffer(requirePtr(native.symbols.csv_batch_row_offsets_ptr(batch)), 0, (rowCount + 1) * 8),
    );
    const fieldOffsets = new Uint32Array(
      toArrayBuffer(requirePtr(native.symbols.csv_batch_field_offsets_ptr(batch)), 0, (totalFields + 1) * 8),
    );
    const rows: CsvRow[] = [];
    rows.length = rowCount;
    for (let rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
      const fieldStart = checkedOffset(rowOffsets, rowIndex, totalFields);
      const fieldEnd = checkedOffset(rowOffsets, rowIndex + 1, totalFields);
      const row: CsvRow = [];
      row.length = fieldEnd - fieldStart;
      for (let fieldIndex = fieldStart; fieldIndex < fieldEnd; ++fieldIndex) {
        const start = checkedOffset(fieldOffsets, fieldIndex, dataLength);
        const end = checkedOffset(fieldOffsets, fieldIndex + 1, dataLength);
        // Decode fields independently so retaining one value cannot pin a whole batch string.
        row[fieldIndex - fieldStart] = decodeMaterializedField(bytes, start, end, 'latin1');
      }
      rows[rowIndex] = row;
    }
    return rows;
  } finally {
    native.symbols.csv_batch_destroy(batch);
  }
}

function checkedOffset(words: Uint32Array, index: number, upperBound: number): number {
  // All supported architectures are little-endian; retain full 64-bit offset validation.
  const low = words[index * 2];
  const high = words[index * 2 + 1];
  if (low === undefined || high === undefined || high > 0x1f_ffff) {
    throw new RangeError('CSV batch offset out of range');
  }
  const offset = low + high * 0x1_0000_0000;
  if (offset > upperBound) {
    throw new RangeError('CSV batch offset exceeds backing storage');
  }
  return offset;
}
