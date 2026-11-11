import { prepareCsvFileInput } from './file-stream.js';
import {
  native,
  u64ToSafeNumber,
} from './native.js';
import {
  requirePtr,
  toArrayBuffer,
} from './native.js';
import {
  normalizeChunk,
  prepareCsvBufferInput,
  projectionFilterProgram,
} from './normalize.js';
import { snapshotCsvOptions } from './options-snapshot.js';
import {
  createPreparedParser,
  NativeCsvParser,
} from './parser.js';
import {
  rejectStrictSchemaUnsupported,
  strictSchemaValidator,
} from './strict-schema.js';
import type {
  CsvEncoding,
  CsvFileOptions,
  CsvNativeProjectionOptions,
  CsvParserOptions,
  CsvRow,
  CsvShard,
} from './types.js';

/**
 * Parse one complete in-memory CSV buffer into materialized rows.
 *
 * The buffer is treated as the complete input, so quoted records may span the
 * buffer but parser state is not retained after this call. `selectedColumns`
 * projects zero-based physical columns in the returned rows. The supplied
 * options are captured when the function is called; changing an options array
 * while parsing cannot change the operation.
 *
 * Automatic delimiter and encoding detection and compression are file-only features.
 * Use an explicit one-character delimiter for in-memory input.
 *
 * @param buffer Complete CSV bytes to parse.
 * @param suppliedOptions Parser, projection, and strict-schema options.
 * @returns Materialized rows. Each row is a newly allocated array of strings.
 * @throws If the buffer, delimiter, projection, or strict-schema options are invalid, or if CSV parsing fails.
 *
 * @example
 * ```ts
 * import { parseCsvBuffer } from '@konstit/csv';
 *
 * const rows = parseCsvBuffer(Buffer.from('id,name\n1,Ada\n'));
 * // rows[0] is ['id', 'name']
 * ```
 */
export function parseCsvBuffer(
  buffer: NodeJS.TypedArray | DataView,
  suppliedOptions: CsvParserOptions<CsvEncoding> = {},
): CsvRow[] {
  const options = snapshotCsvOptions(suppliedOptions);
  const input = prepareCsvBufferInput(buffer, options.encoding, options.delimiter);
  using parser = new NativeCsvParser({ ...options, encoding: input.parserEncoding });
  const validator = strictSchemaValidator(options);
  const batch = parser.writeBatch(input.bytes, true);
  try {
    validator?.validateBatch(batch);
    validator?.finish();
    return batch.rowsInto([], options.selectedColumns);
  } finally {
    batch.close();
  }
}

/**
 * Count rows in bytes known to contain one record per physical line.
 *
 * This is a structural newline counter rather than a CSV parser: newlines in
 * quoted fields are counted as row boundaries. The native counter counts each
 * LF byte; a final byte other than LF or CR adds one unterminated row. Thus a
 * CRLF ending counts once through its LF, while a standalone CR is not a row
 * separator. Use it only for trusted newline-delimited data.
 *
 * @param buffer Newline-delimited bytes. Typed-array views are counted from their visible byte range.
 * @returns The number of physical lines, represented as a safe JavaScript number.
 * @throws If the count cannot be represented safely as a JavaScript number.
 */
export function countTrustedNewlineRows(buffer: NodeJS.TypedArray | DataView): number {
  if (buffer.byteLength === 0) {
    return 0;
  }
  const input = normalizeChunk(buffer);
  return u64ToSafeNumber(
    native.symbols.csv_parser_count_trusted_newlines(input, input),
    'CSV newline row count',
  );
}

/**
 * Find byte offsets at which a CSV file can be split without breaking a record.
 *
 * Returned offsets include `0` and the file byte length. Intermediate offsets
 * are chosen at record boundaries, including records containing quoted
 * newlines, and approximate the requested number of shards. The file is read
 * as raw bytes, so this low-level helper accepts only an explicit
 * one-character delimiter.
 *
 * @param path Path to the uncompressed CSV file.
 * @param shardCount Desired number of shards. It must be a positive integer.
 * @param delimiter One-byte CSV delimiter; defaults to `,`.
 * @returns Nondecreasing byte offsets suitable as half-open shard starts and ends.
 * @throws {RangeError} If `shardCount` is not a positive integer.
 * @throws If `delimiter` is not exactly one character or the native scan fails.
 */
export function findCsvSafeSplitOffsets(path: string, shardCount: number, delimiter = ','): number[] {
  if (!Number.isInteger(shardCount) || shardCount <= 0) {
    throw new RangeError(`invalid shard count: ${shardCount}`);
  }
  if (delimiter.length !== 1) {
    throw new Error('delimiter must be one character');
  }

  const batch = native.symbols.csv_parser_find_split_offsets(
    Buffer.from(`${path}\0`),
    BigInt(shardCount),
    delimiter.charCodeAt(0),
  );
  if (batch === null) {
    throw new Error(`native CSV split offset scan failed: ${path}`);
  }

  try {
    const count = u64ToSafeNumber(native.symbols.csv_split_offsets_batch_count(batch), 'CSV split offset count');
    const ptr = native.symbols.csv_split_offsets_batch_ptr(batch);
    const offsets = new BigUint64Array(toArrayBuffer(requirePtr(ptr), 0, count * BigUint64Array.BYTES_PER_ELEMENT));
    return Array.from(offsets, (offset) => u64ToSafeNumber(offset, 'CSV split offset'));
  } finally {
    native.symbols.csv_split_offsets_batch_destroy(batch);
  }
}

/**
 * Return inclusive byte ranges that can each be read as complete CSV records.
 *
 * The ranges are derived from {@link findCsvSafeSplitOffsets}. Empty ranges
 * are omitted, so a small file can produce fewer ranges than `shardCount`.
 * `start` and `end` are byte offsets in the uncompressed file and both ends
 * are inclusive.
 *
 * @param path Path to the uncompressed CSV file.
 * @param shardCount Desired number of shards. It must be a positive integer.
 * @param delimiter One-byte CSV delimiter; defaults to `,`.
 * @returns Non-empty, record-safe ranges in file order.
 * @throws {RangeError} If `shardCount` is not a positive integer.
 * @throws If `delimiter` is not exactly one character or the native scan fails.
 */
export function findCsvSafeShards(path: string, shardCount: number, delimiter = ','): CsvShard[] {
  const offsets = findCsvSafeSplitOffsets(path, shardCount, delimiter);
  const shards: CsvShard[] = [];
  for (let index = 0; index < offsets.length - 1; ++index) {
    const start = offsets[index] ?? 0;
    const nextStart = offsets[index + 1] ?? start;
    if (nextStart <= start) {
      continue;
    }
    shards.push({
      start,
      end: nextStart - 1,
    });
  }
  return shards;
}

/**
 * Stream materialized row arrays from a CSV file.
 *
 * Each yielded value contains the rows parsed from one input chunk. Rows are
 * ordinary strings and remain usable after the next batch is yielded. File
 * compression and automatic delimiter and encoding detection are supported by
 * `CsvFileOptions`.
 *
 * Options are snapshotted when this function is called, before iteration
 * begins. Do not rely on mutating an options object while consuming the
 * generator to reconfigure the stream.
 *
 * @param path Path to the CSV file (or compressed/ZIP input selected by `options.compression`).
 * @param options File and parser options. `selectedColumns` selects physical columns for each row.
 * @returns An async generator of non-empty row batches.
 * @throws When iteration encounters an I/O, decompression, parsing, or strict-schema error.
 *
 * @example
 * ```ts
 * import { parseCsvFile } from '@konstit/csv';
 *
 * for await (const rows of parseCsvFile('data.csv', { selectedColumns: [0, 2] })) {
 *   for (const row of rows) console.log(row);
 * }
 * ```
 */
export function parseCsvFile(path: string, options: CsvFileOptions = {}): AsyncGenerator<CsvRow[], void> {
  return iterateCsvFile(path, snapshotCsvOptions(options));
}

async function* iterateCsvFile(path: string, options: CsvFileOptions): AsyncGenerator<CsvRow[], void> {
  await using input = await prepareCsvFileInput(path, options);
  using parser = new NativeCsvParser({ ...options, encoding: input.parserEncoding, delimiter: input.delimiter });
  const validator = strictSchemaValidator(options);
  for await (const chunk of input.chunks()) {
    const batch = parser.writeBatch(chunk);
    try {
      validator?.validateBatch(batch);
      const rows = batch.rowsInto([], options.selectedColumns);
      if (rows.length > 0) {
        yield rows;
      }
    } finally {
      batch.close();
    }
  }

  const batch = parser.endBatch();
  try {
    validator?.validateBatch(batch);
    validator?.finish();
    const rows = batch.rowsInto([], options.selectedColumns);
    if (rows.length > 0) {
      yield rows;
    }
  } finally {
    batch.close();
  }
}

/**
 * Stream rows using native projection and native filter evaluation.
 *
 * This lower-level file API is useful when the selected columns or native
 * filter descriptors are already prepared. `selectedColumns` is the returned
 * projection, while `equalsFilter` and `filters` are evaluated against
 * physical columns before materialization. Options are snapshotted at call
 * time, including nested filter values.
 *
 * Strict mode is not supported for projected batches, including strict CSV
 * quote parsing and strict schema metadata. Use `parseCsvFile` when strict
 * validation is required.
 *
 * @param path Path to the CSV file (or compressed/ZIP input selected by `options.compression`).
 * @param options Native projection/filter and file parser options.
 * @returns An async generator of non-empty projected row batches.
 * @throws When strict mode is enabled, or when I/O, decompression, filter, or parsing errors occur during iteration.
 *
 * @example
 * ```ts
 * import { parseCsvFileProjected } from '@konstit/csv';
 *
 * for await (const rows of parseCsvFileProjected('data.csv', {
 *   selectedColumns: [2, 0],
 *   equalsFilter: { column: 1, value: 'active' },
 * })) {
 *   console.log(rows);
 * }
 * ```
 */
export function parseCsvFileProjected(
  path: string,
  options: CsvFileOptions & CsvNativeProjectionOptions = {},
): AsyncGenerator<CsvRow[], void> {
  return iterateCsvFileProjected(path, snapshotCsvOptions(options));
}

async function* iterateCsvFileProjected(
  path: string,
  options: CsvFileOptions & CsvNativeProjectionOptions,
): AsyncGenerator<CsvRow[], void> {
  rejectStrictSchemaUnsupported(options, 'projected file parsing');
  await using input = await prepareCsvFileInput(path, options);
  using parser = createPreparedParser(
    { ...options, encoding: input.parserEncoding, delimiter: input.delimiter },
    options.selectedColumns,
    projectionFilterProgram(options),
    true,
  );
  for await (const chunk of input.chunks()) {
    const batch = parser.writeBatch(chunk);
    try {
      const rows = batch.rows();
      if (rows.length > 0) {
        yield rows;
      }
    } finally {
      batch.close();
    }
  }

  const batch = parser.endBatch();
  try {
    const rows = batch.rows();
    if (rows.length > 0) {
      yield rows;
    }
  } finally {
    batch.close();
  }
}

/**
 * Count logical CSV records in a file without materializing row strings.
 *
 * The parser honors quoted newlines and supports the same compression and
 * delimiter options as file parsing. With `strict: true`, quote syntax
 * is validated while counting. Strict schema metadata is intentionally not
 * supported by this counting path; use row parsing when headers or minimum
 * data-row constraints must be checked.
 *
 * @param path Path to the CSV file (or compressed/ZIP input selected by `suppliedOptions.compression`).
 * @param suppliedOptions File and parser options.
 * @returns A promise for the logical CSV record count.
 * @throws When strict schema metadata is requested, the file cannot be read or decompressed, parsing fails, or the count exceeds safe integer range.
 *
 * @example
 * ```ts
 * import { countCsvFile } from '@konstit/csv';
 *
 * const rows = await countCsvFile('data.csv', { delimiter: ';' });
 * ```
 */
export async function countCsvFile(path: string, suppliedOptions: CsvFileOptions = {}): Promise<number> {
  const options = snapshotCsvOptions(suppliedOptions);
  rejectStrictSchemaUnsupported(options, 'count');
  await using input = await prepareCsvFileInput(path, options);
  using parser = new NativeCsvParser({ ...options, encoding: input.parserEncoding, delimiter: input.delimiter });
  let rows = 0;
  if (options.strict === true) {
    for await (const chunk of input.chunks()) {
      const batch = parser.writeBatch(chunk);
      try {
        rows += batch.rowCount;
      } finally {
        batch.close();
      }
    }
    const batch = parser.endBatch();
    try {
      rows += batch.rowCount;
    } finally {
      batch.close();
    }
    return rows;
  }

  for await (const chunk of input.chunks()) {
    rows += parser.writeCount(chunk);
  }
  rows += parser.endCount();
  return rows;
}
