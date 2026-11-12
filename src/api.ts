import type { NativeCsvBatch } from './batches.js';
import {
  prepareCsvFileInput,
  rejectAutoDelimiterSharding,
  rejectCompressedSharding,
} from './file-stream.js';
import type { CsvFileProbe } from './file-stream.js';
import {
  findCsvSafeShards as findCsvSafeShardsNative,
  findCsvSafeSplitOffsets as findCsvSafeSplitOffsetsNative,
} from './files.js';
import {
  all,
  any,
  column,
  nativeFilterProgramFor,
  not,
  re,
} from './filter.js';
import { latin1Rows } from './latin1-rows.js';
import { latin1RowsParser } from './native.js';
import {
  normalizeFixedColumnsCount,
  prepareCsvBufferInput,
  resolveInputEncoding,
} from './normalize.js';
import type { CsvNativeFilterProgramEntry } from './normalize.js';
import { snapshotCsvOptions } from './options-snapshot.js';
import { createPreparedParser } from './parser.js';
import {
  rejectStrictSchemaUnsupported,
  strictSchemaValidator,
} from './strict-schema.js';
import type {
  CsvApiFileOptions,
  CsvBatchesOptions,
  CsvColumns,
  CsvCountOptions,
  CsvFilter,
  CsvParseOptions,
  CsvParserOptions,
  CsvProjectedRow,
  CsvRow,
  CsvRowsOptions,
  CsvShard,
  CsvShardingOptions,
} from './types.js';

/**
 * Parse one in-memory CSV buffer into materialized rows.
 *
 * Use this when the input is already buffered and a single promise containing all rows is suitable.
 * The buffer is parsed as one complete input, so a record may not be split across calls. Use
 * {@link rows} for file streaming. `columns` projects the
 * returned rows, while strict validation (when enabled) still validates the complete row.
 *
 * @typeParam TColumns - Literal projected column indexes, when a projection is supplied.
 * @param buffer - CSV bytes in a typed array or `DataView`.
 * @param suppliedOptions - Parser options for uncompressed bytes with a fixed delimiter.
 * @returns A promise that resolves to the materialized rows in input order.
 * @throws {Error} If the options request compression, automatic delimiter detection, or an
 * unsupported filtered strict-validation combination.
 */
export async function parse<TColumns extends CsvColumns | undefined = undefined>(
  buffer: NodeJS.TypedArray | DataView,
  suppliedOptions: CsvParseOptions<TColumns> = {},
): Promise<CsvProjectedRow<TColumns>[]> {
  const options = snapshotCsvOptions(suppliedOptions);
  if ('compression' in options && options.compression !== undefined) {
    throw new Error('parse() does not support compression; pass decompressed bytes or use a file API');
  }
  if (options.delimiter === 'auto') {
    throw new Error('parse() does not support automatic delimiter detection; specify delimiter or use a file API');
  }
  rejectFilteredStrictSchema(options);
  const filters = toNativeFilters(options.where);
  const columns = options.columns;
  const projected = filters !== undefined || (options.strict !== true && columns !== undefined);
  const input = prepareCsvBufferInput(buffer, options.encoding, options.delimiter);
  using parser = createPreparedParser(toParserOptions(options, input.parserEncoding), projected ? columns : undefined, filters);
  const validator = strictSchemaValidator(options);
  const batch = parser.writeBatch(input.bytes, true);
  try {
    validator?.validateBatch(batch);
    validator?.finish();
    return materializeRows<TColumns>(batch, columns, projected);
  } finally {
    batch.close();
  }
}

/**
 * Stream materialized rows from a CSV file.
 *
 * Each yielded value is one parser batch represented as ordinary string arrays. Options are
 * captured when this function is called, before iteration starts, so mutating the caller-owned
 * options object later does not change the stream. With `reuseArrays: true`, batches and their
 * rows are borrowed until the next iteration. Copy a row with `row.slice()` to retain it.
 *
 * @typeParam TColumns - Literal projected column indexes, when a projection is supplied.
 * @param path - Path to the CSV file.
 * @param options - File, projection, filter, and validation settings.
 * @returns An async generator of row batches in file order.
 * @throws {Error} During iteration when the file cannot be read or the selected options are
 * incompatible, such as a filter combined with strict validation.
 */
export function rows<TColumns extends CsvColumns | undefined = undefined>(
  path: string,
  options: CsvRowsOptions<TColumns> = {},
): AsyncGenerator<CsvProjectedRow<TColumns>[], void> {
  return iterateRows(path, snapshotCsvOptions(options));
}

export async function* iterateRows<TColumns extends CsvColumns | undefined>(
  path: string,
  options: CsvRowsOptions<TColumns>,
  probeFormat?: CsvFileProbe,
): AsyncGenerator<CsvProjectedRow<TColumns>[], void> {
  rejectFilteredStrictSchema(options);
  const filters = toNativeFilters(options.where);
  const columns = options.columns;
  const projected = filters !== undefined || (options.strict !== true && columns !== undefined);
  await using input = await prepareCsvFileInput(path, options, 'read-ahead', probeFormat);
  const parserOptions = toParserOptions(options, input.parserEncoding, input.delimiter);
  const validator = strictSchemaValidator(options);
  const reusableRows: CsvRow[] | undefined = options.reuseArrays === true ? [] : undefined;
  if (options.strict !== true && validator === undefined && input.parserEncoding === 'latin1') {
    const fixedColumns = normalizeFixedColumnsCount(options.fixedColumns, 'fixed column count');
    const createParser = latin1RowsParser(fixedColumns);
    yield* latin1Rows(input.chunks(), input.delimiter, columns, filters, createParser, reusableRows) as AsyncGenerator<
      CsvProjectedRow<TColumns>[],
      void
    >;
    return;
  }
  using parser = createPreparedParser(parserOptions, projected ? columns : undefined, filters);
  for await (const chunk of input.chunks()) {
    const batch = parser.writeBatch(chunk);
    if (batch.rowCount > 0) {
      try {
        validator?.validateBatch(batch);
        const values = materializeRows<TColumns>(batch, columns, projected, reusableRows);
        if (values.length > 0) {
          yield values;
        }
      } finally {
        batch.close();
      }
    } else {
      batch.close();
    }
  }

  const batch = parser.endBatch();
  if (batch.rowCount > 0) {
    try {
      validator?.validateBatch(batch);
      validator?.finish();
      const values = materializeRows<TColumns>(batch, columns, projected, reusableRows);
      if (values.length > 0) {
        yield values;
      }
    } finally {
      batch.close();
    }
  } else {
    validator?.finish();
    batch.close();
  }
}

/**
 * Stream native batches with explicit lifetime control.
 *
 * Use this when you want low-allocation access to row views, byte ranges, and native-backed
 * column data. Every yielded batch owns native memory and must be closed after use; prefer
 * `for await (using batch of csv.batches(...))` to close each batch at the end of the iteration.
 * Options are captured at invocation time. Projection selects the stored fields in the requested
 * order. Accessors use output positions and filters use physical input indexes.
 *
 * @param path - Path to the CSV file.
 * @param options - File and parser options.
 * @returns An async generator of disposable native batches.
 * @throws {Error} During iteration when the file or validation fails, or when strict validation
 * is combined with projection or filtering.
 */
export function batches(path: string, options: CsvBatchesOptions = {}): AsyncGenerator<NativeCsvBatch, void> {
  return iterateBatches(path, snapshotCsvOptions(options));
}

async function* iterateBatches(path: string, options: CsvBatchesOptions): AsyncGenerator<NativeCsvBatch, void> {
  rejectFilteredStrictSchema(options);
  const filters = toNativeFilters(options.where);
  const columns = options.columns;
  if (options.strict === true && columns !== undefined) {
    throw new Error('strict CSV validation is not supported for projected batches; use csv.rows() for strict projection');
  }
  await using input = await prepareCsvFileInput(path, options);
  using parser = createPreparedParser(toParserOptions(options, input.parserEncoding, input.delimiter), columns, filters);
  const validator = strictSchemaValidator(options);
  for await (const chunk of input.chunks()) {
    const batch = parser.writeBatch(chunk);
    if (batch.rowCount > 0) {
      try {
        validator?.validateBatch(batch);
      } catch (error) {
        batch.close();
        throw error;
      }
      yield batch;
    } else {
      batch.close();
    }
  }

  const batch = parser.endBatch();
  if (batch.rowCount > 0) {
    try {
      validator?.validateBatch(batch);
      validator?.finish();
    } catch (error) {
      batch.close();
      throw error;
    }
    yield batch;
  } else {
    batch.close();
    validator?.finish();
  }
}

/**
 * Count CSV records without materializing them.
 *
 * Filters created with `csv.column()` and composed with `csv.all()`, `csv.any()`, or `csv.not()`
 * are evaluated by native fast paths. The input may be compressed or use automatic delimiter
 * detection.
 *
 * @param path - Path to the CSV file.
 * @param suppliedOptions - File, filter, and validation settings.
 * @returns A promise containing the record count.
 * @throws {Error} If strict validation is combined with a filter or reading or parsing fails.
 */
export async function count(path: string, suppliedOptions: CsvCountOptions = {}): Promise<number> {
  const options = snapshotCsvOptions(suppliedOptions);
  const filters = toNativeFilters(options.where);
  await using input = await prepareCsvFileInput(path, options, 'count');
  if (options.strict === true && filters !== undefined) {
    throw new Error('strict CSV validation is not supported for count filters');
  }
  using parser = createPreparedParser(toParserOptions(options, input.parserEncoding, input.delimiter), undefined, filters);
  const validator = strictSchemaValidator(options);
  let total = 0;
  if (options.strict === true && filters === undefined) {
    for await (const chunk of input.chunks()) {
      const batch = parser.writeBatch(chunk);
      try {
        validator?.validateBatch(batch);
        total += batch.rowCount;
      } finally {
        batch.close();
      }
    }
    const batch = parser.endBatch();
    try {
      validator?.validateBatch(batch);
      validator?.finish();
      total += batch.rowCount;
    } finally {
      batch.close();
    }
    return total;
  }

  for await (const chunk of input.chunks()) {
    total += parser.writeCount(chunk);
  }
  total += parser.endCount();
  return total;
}

/**
 * Find byte offsets that divide a CSV file only at record boundaries.
 *
 * The returned array contains shard start offsets followed by the terminal file boundary. Quoted
 * fields and embedded newlines are respected. The operation scans original UTF-8 or Latin-1
 * bytes in an uncompressed file with a fixed delimiter.
 *
 * @param path - Path to the uncompressed CSV file.
 * @param shardCount - Desired number of partitions; the result may contain fewer non-empty shards.
 * @param suppliedOptions - Explicit delimiter and file parser options. Compression is unavailable.
 * @returns Monotonically increasing byte offsets, including `0` and the file-length boundary.
 * @throws {RangeError} If `shardCount` is not a positive integer.
 * @throws {Error} If the input is compressed, the encoding requires transcoding, or the delimiter is automatic or invalid.
 */
function findCsvSafeSplitOffsets(path: string, shardCount: number, suppliedOptions: CsvShardingOptions = {}): number[] {
  const options = snapshotCsvOptions(suppliedOptions);
  return findCsvSafeSplitOffsetsNative(path, shardCount, shardingDelimiter(options, 'CSV split offset scanning'));
}

/**
 * Find non-empty CSV byte ranges that begin and end at record boundaries.
 *
 * Shards use inclusive `start` and `end` offsets and never split quoted fields or embedded
 * newlines. A small file can produce fewer non-empty shards than requested. The operation
 * requires original UTF-8 or Latin-1 bytes in an uncompressed file with a fixed delimiter.
 *
 * @param path - Path to the uncompressed CSV file.
 * @param shardCount - Desired number of partitions; the result may contain fewer shards.
 * @param suppliedOptions - Explicit delimiter and file parser options. Compression is unavailable.
 * @returns Non-empty, ordered byte ranges with inclusive endpoints.
 * @throws {RangeError} If `shardCount` is not a positive integer.
 * @throws {Error} If the input is compressed, the encoding requires transcoding, or the delimiter is automatic or invalid.
 */
function findCsvSafeShards(path: string, shardCount: number, suppliedOptions: CsvShardingOptions = {}): CsvShard[] {
  const options = snapshotCsvOptions(suppliedOptions);
  return findCsvSafeShardsNative(path, shardCount, shardingDelimiter(options, 'CSV shard scanning'));
}

function shardingDelimiter(options: CsvShardingOptions, operation: string): string {
  rejectCompressedSharding(options, operation);
  rejectAutoDelimiterSharding(options, operation);
  if (typeof resolveInputEncoding(options.encoding) !== 'string') {
    throw new Error(`${operation} requires a native UTF-8 or Latin-1 encoding because offsets refer to the source file`);
  }
  return options.delimiter ?? ',';
}

/**
 * The package's file-oriented API namespace.
 *
 * The namespace combines materialization, counting, filtering, native batches, and
 * record-safe sharding helpers in one discoverable object.
 */
export const csv = {
  /**
   * Combine one or more filters with logical AND semantics.
   * @param first - First filter in the group.
   * @param rest - Additional filters that must match.
   * @returns An immutable conjunction filter.
   */
  all,
  /**
   * Combine one or more filters with logical OR semantics.
   * @param first - First filter in the group.
   * @param rest - Additional filters, any one of which may match.
   * @returns An immutable disjunction filter.
   */
  any,
  /**
   * Select a zero-based physical CSV column for building reusable filters.
   * @param columnIndex - Column index from 0 through 2024.
   * @returns An immutable column predicate builder.
   */
  column,
  /**
   * Negate a filter while preserving missing-column unknown semantics.
   * @param filter - Filter created by this API.
   * @returns An immutable negation filter.
   */
  not,
  /**
   * Validate and brand a JavaScript regular expression for native matching.
   * @param pattern - Expression using the supported RE2-compatible syntax and flags.
   * @returns An immutable `CsvRegex` descriptor for low-level filter values.
   */
  re,
  /**
   * Parse one in-memory buffer into materialized rows.
   * Supply uncompressed bytes with a fixed delimiter.
   * @param buffer - CSV bytes in a typed array or `DataView`.
   * @param suppliedOptions - In-memory parser and projection options.
   * @returns A promise containing materialized rows in input order.
   * @example
   * ```ts
   * import { csv } from '@konstit/csv';
   * const rows = await csv.parse(Buffer.from('1,Ada\n2,Grace\n'), { columns: [1] });
   * // [['Ada'], ['Grace']]
   * ```
   */
  parse,
  /**
   * Stream materialized row batches from a CSV file.
   * Options are captured at invocation. Batches are yielded in file order.
   * @param path - Path to the CSV file.
   * @param options - File, projection, filter, and validation settings.
   * @returns An async generator of row batches.
   * @example
   * ```ts
   * import { csv } from '@konstit/csv';
   * for await (const rows of csv.rows('data.csv', { columns: [0, 2], delimiter: ';' })) {
   *   for (const row of rows) console.log(row);
   * }
   * ```
   */
  rows,
  /**
   * Stream disposable native-backed batches.
   * Columns select stored fields in output order. Filters address the input record.
   * Close each yielded batch, or use `for await (using batch of ...)`.
   * @param path - Path to the CSV file.
   * @param options - File and parser options.
   * @returns An async generator of `NativeCsvBatch` objects.
   */
  batches,
  /**
   * Count CSV records without materializing them.
   * Counting supports compression and automatic encoding and delimiter detection. Filters require non-strict parsing.
   * @param path - Path to the CSV file.
   * @param suppliedOptions - File, filter, and validation settings.
   * @returns A promise containing the record count.
   * @example
   * ```ts
   * import { csv } from '@konstit/csv';
   * const activeRows = await csv.count('data.csv', { where: csv.column(2).equals('active') });
   * ```
   */
  count,
  /**
   * Find record-safe byte offsets, including the terminal file boundary.
   * Compressed input and automatic delimiter detection are unsupported.
   * @param path - Path to an uncompressed CSV file.
   * @param shardCount - Desired number of partitions.
   * @param suppliedOptions - Explicit delimiter and sharding options.
   * @returns Monotonically increasing byte offsets.
   */
  findCsvSafeSplitOffsets,
  /**
   * Find non-empty record-safe byte ranges for independent processing.
   * Ranges use inclusive `start` and `end` offsets and may be fewer than requested.
   * @param path - Path to an uncompressed CSV file.
   * @param shardCount - Desired number of partitions.
   * @param suppliedOptions - Explicit delimiter and sharding options.
   * @returns Ordered, non-empty CSV byte ranges.
   */
  findCsvSafeShards,
};

function toParserOptions(
  options: CsvApiFileOptions,
  encoding: CsvParserOptions['encoding'],
  delimiter: CsvParserOptions['delimiter'] = options.delimiter,
): CsvParserOptions {
  return {
    delimiter,
    encoding,
    strict: options.strict,
    columns: options.columns,
    fixedColumns: options.fixedColumns,
  };
}

function materializeRows<TColumns extends CsvColumns | undefined>(
  batch: NativeCsvBatch,
  columns: CsvColumns | undefined,
  projected: boolean,
  target: CsvRow[] = [],
): CsvProjectedRow<TColumns>[] {
  return batch.rowsInto(target, projected ? undefined : columns) as CsvProjectedRow<TColumns>[];
}

function rejectFilteredStrictSchema(options: CsvApiFileOptions): void {
  if (options.where !== undefined) {
    rejectStrictSchemaUnsupported(options, 'filtered rows');
  }
}

function toNativeFilters(where: CsvFilter | undefined): readonly CsvNativeFilterProgramEntry[] | undefined {
  return nativeFilterProgramFor(where);
}
