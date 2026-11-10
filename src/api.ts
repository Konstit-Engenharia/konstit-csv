import { NativeCsvRowView } from './batches.js';
import type { NativeCsvBatch } from './batches.js';
import {
  prepareCsvFileInput,
  rejectAutoDelimiterSharding,
  rejectCompressedSharding,
} from './file-stream.js';
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
import { optionalLatin1RowsParser } from './native.js';
import {
  encodingCode,
  normalizeColumns,
  normalizeFixedColumnsCount,
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
  CsvColumnarBatchCallback,
  CsvColumnarBatchOptions,
  CsvColumnarBatchView,
  CsvColumns,
  CsvCountOptions,
  CsvFileOptions,
  CsvFilter,
  CsvParallelCountOptions,
  CsvParallelRowsOptions,
  CsvParseOptions,
  CsvParserOptions,
  CsvProjectedRow,
  CsvRow,
  CsvRowsOptions,
  CsvRowView,
  CsvRowViewCallback,
  CsvRowViewsOptions,
  CsvShard,
  CsvShardingOptions,
  CsvWorkerPoolOptions,
} from './types.js';
import { parallelCount } from './worker-count.js';
import {
  createWorkerPool,
  CsvWorkerPool,
} from './worker-pool.js';
import { parallelRows } from './worker-rows.js';

/**
 * Parse one in-memory CSV buffer into materialized rows.
 *
 * Use this when the input is already buffered and a single promise containing all rows is suitable.
 * The buffer is parsed as one complete input, so a record may not be split across calls. Use
 * {@link rows} for file streaming and worker fan-out. `columns`/`selectedColumns` projects the
 * returned rows, while strict validation (when enabled) still validates the complete row.
 *
 * @typeParam TColumns - Literal projected column indexes, when a projection is supplied.
 * @param buffer - CSV bytes in a typed array or `DataView`.
 * @param suppliedOptions - Parser options. Compression, automatic delimiter detection, and workers
 * are not supported for in-memory parsing.
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
  const columns = selectedColumns(options);
  const projected = filters !== undefined || (options.strict !== true && columns !== undefined);
  using parser = createPreparedParser(toParserOptions(options), projected ? columns : undefined, filters);
  const validator = strictSchemaValidator(options);
  const batch = parser.writeBatch(buffer, true);
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
 * options object later does not change the stream. Set `workerCount` above one to use record-safe
 * Bun worker shards; serial streams additionally support compression and automatic delimiter
 * detection. With `reuseArrays: true`, serial batches and their rows are borrowed until the next
 * iteration. Copy a row with `row.slice()` to retain it.
 *
 * @typeParam TColumns - Literal projected column indexes, when a projection is supplied.
 * @param path - Path to the CSV file.
 * @param options - File, projection, filter, validation, and optional worker settings.
 * @returns An async generator of row batches. Serial parsing yields batches in file order; worker
 * parsing yields batches as worker shards report them, so global file order is not guaranteed.
 * @throws {Error} During iteration when the file cannot be read or the selected options are
 * incompatible, such as strict filtered rows or compressed/auto-delimiter worker input.
 */
export function rows<TColumns extends CsvColumns | undefined = undefined>(
  path: string,
  options: CsvRowsOptions<TColumns> = {},
): AsyncGenerator<CsvProjectedRow<TColumns>[], void> {
  return iterateRows(path, snapshotCsvOptions(options));
}

async function* iterateRows<TColumns extends CsvColumns | undefined>(
  path: string,
  options: CsvRowsOptions<TColumns>,
): AsyncGenerator<CsvProjectedRow<TColumns>[], void> {
  if ((options.workerCount ?? 1) > 1) {
    rejectCompressedSharding(options, 'parallel row parsing');
    rejectAutoDelimiterSharding(options, 'parallel row parsing');
    yield* parallelRows(path, options as CsvParallelRowsOptions<TColumns>);
    return;
  }

  rejectFilteredStrictSchema(options);
  const filters = toNativeFilters(options.where);
  const columns = selectedColumns(options);
  const projected = filters !== undefined || (options.strict !== true && columns !== undefined);
  await using input = await prepareCsvFileInput(path, options);
  const parserOptions = toParserOptions(options, input.delimiter);
  const validator = strictSchemaValidator(options);
  const reusableRows: CsvRow[] | undefined = options.reuseArrays === true ? [] : undefined;
  if (options.strict !== true && validator === undefined && encodingCode(options.encoding) === 1) {
    const fixedColumns = normalizeFixedColumnsCount(options.fixedColumns, 'fixed column count');
    const createParser = optionalLatin1RowsParser(fixedColumns);
    if (createParser !== undefined) {
      yield* latin1Rows(input.chunks(), input.delimiter, columns, filters, createParser, reusableRows) as AsyncGenerator<
        CsvProjectedRow<TColumns>[],
        void
      >;
      return;
    }
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
 * Stream materialized rows through record-safe worker shards.
 *
 * `workerCount` must be greater than one. Workers require uncompressed input, an explicit
 * delimiter, and non-strict validation; use {@link rows} for serial parsing or strict validation.
 *
 * @typeParam TColumns - Literal projected column indexes, when a projection is supplied.
 * @param path - Path to the CSV file.
 * @param options - Parallel row options, including the required worker count.
 * @returns An async generator of materialized row batches.
 * @throws {RangeError} If `workerCount` is not an integer greater than one.
 * @throws {Error} If compression, automatic delimiter detection, or strict validation is enabled.
 */
export { parallelRows };
export { CsvWorkerPool };

/**
 * Stream native batches with explicit lifetime control.
 *
 * Use this when you want low-allocation access to row views, byte ranges, and native-backed
 * column data. Every yielded batch owns native memory and must be closed after use; prefer
 * `for await (using batch of csv.batches(...))` or {@link withBatches} when possible.
 * Options are captured at invocation time. Accessor indexes refer to fields stored in the batch;
 * when filtering is combined with a projection, those stored fields are the projected output.
 *
 * @param path - Path to the CSV file.
 * @param options - Serial file and parser options.
 * @returns An async generator of disposable native batches.
 * @throws {Error} During iteration when the file or validation fails, or when filtered strict
 * validation is requested.
 */
export function batches(path: string, options: CsvBatchesOptions = {}): AsyncGenerator<NativeCsvBatch, void> {
  return iterateBatches(path, snapshotCsvOptions(options));
}

async function* iterateBatches(path: string, options: CsvBatchesOptions): AsyncGenerator<NativeCsvBatch, void> {
  rejectFilteredStrictSchema(options);
  const filters = toNativeFilters(options.where);
  const columns = filters === undefined ? undefined : selectedColumns(options);
  await using input = await prepareCsvFileInput(path, options);
  using parser = createPreparedParser(toParserOptions(options, input.delimiter), columns, filters);
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
    validator?.finish();
    batch.close();
  }
}

/**
 * Process native CSV batches while managing each batch's lifetime.
 *
 * The callback may be asynchronous. Its batch remains valid until the callback settles and is
 * closed in a `finally` block afterward, including when the callback throws.
 *
 * @param path - Path to the CSV file.
 * @param options - Serial file and parser options.
 * @param callback - Function invoked once per non-empty batch.
 * @returns A promise that resolves after all batches have been processed.
 * @throws {Error} The callback error, file error, or parser/validation error.
 */
export async function withBatches(
  path: string,
  options: CsvBatchesOptions,
  callback: (batch: NativeCsvBatch) => void | Promise<void>,
): Promise<void> {
  for await (const batch of batches(path, options)) {
    try {
      await callback(batch);
    } finally {
      batch.close();
    }
  }
}

/**
 * Visit reusable columnar batch views without materializing one JavaScript string per field.
 *
 * The callback must be synchronous. A single view object is rebound for each batch and becomes
 * invalid as soon as the callback returns, so copy any data that must outlive the callback. When
 * `columns` is defined, batch column indexes are relative to the projected output order. Worker
 * parsing and strict validation with selected columns are not supported by this API.
 *
 * @typeParam TColumns - Literal projected column indexes, when a projection is supplied.
 * @param path - Path to the CSV file.
 * @param options - Serial file and columnar projection options.
 * @param callback - Synchronous function invoked with a reusable view and batch index.
 * @returns A promise that resolves after all batches have been visited.
 * @throws {TypeError} If the callback returns a promise.
 * @throws {Error} If worker parsing or an unsupported strict selected projection is requested.
 */
export function forEachColumnarBatches<TColumns extends CsvColumns | undefined = undefined>(
  path: string,
  options: CsvColumnarBatchOptions<TColumns>,
  callback: CsvColumnarBatchCallback<TColumns>,
): Promise<void>;
/**
 * Visit columnar batches when the selected-column tuple is not statically known.
 * The callback must be synchronous and the reusable view is valid only during the callback.
 *
 * @param path - Path to the CSV file.
 * @param options - Serial columnar options, or `undefined` for defaults.
 * @param callback - Synchronous batch handler.
 * @returns A promise that resolves after all batches are visited.
 */
export function forEachColumnarBatches(
  path: string,
  options: CsvColumnarBatchOptions | undefined,
  callback: CsvColumnarBatchCallback,
): Promise<void>;
export async function forEachColumnarBatches<TColumns extends CsvColumns | undefined = undefined>(
  path: string,
  suppliedOptions: CsvColumnarBatchOptions<TColumns> = {} as CsvColumnarBatchOptions<TColumns>,
  callback: CsvColumnarBatchCallback<TColumns>,
): Promise<void> {
  const options = snapshotCsvOptions(suppliedOptions);
  ensureColumnarBatchesSupported(options);
  const filters = toNativeFilters(options.where);
  const columns = selectedColumns(options);
  const scopedBatch = new ScopedCsvColumnarBatchView(columns as TColumns);
  let batchIndex = 0;
  await using input = await prepareCsvFileInput(path, options);
  using parser = createPreparedParser(toParserOptions(options, input.delimiter), columns, filters);
  const validator = strictSchemaValidator(options);
  for await (const chunk of input.chunks()) {
    const batch = parser.writeBatch(chunk);
    if (batch.rowCount > 0) {
      try {
        validator?.validateBatch(batch);
        scopedBatch.bind(batch);
        try {
          const result = callback(scopedBatch, batchIndex);
          if (isPromiseLike(result)) {
            throw new TypeError('columnar batch callback must be synchronous');
          }
        } finally {
          scopedBatch.release();
        }
        ++batchIndex;
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
      scopedBatch.bind(batch);
      try {
        const result = callback(scopedBatch, batchIndex);
        if (isPromiseLike(result)) {
          throw new TypeError('columnar batch callback must be synchronous');
        }
      } finally {
        scopedBatch.release();
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
 * Visit reusable columnar batch views with the same lifetime guarantees as
 * {@link forEachColumnarBatches}. The callback is synchronous and the view is invalid after it
 * returns.
 *
 * @typeParam TColumns - Literal projected column indexes, when a projection is supplied.
 * @param path - Path to the CSV file.
 * @param options - Serial file and columnar projection options.
 * @param callback - Synchronous function invoked for each batch.
 * @returns A promise that resolves after all batches have been visited.
 */
export function withColumnarBatches<TColumns extends CsvColumns | undefined = undefined>(
  path: string,
  options: CsvColumnarBatchOptions<TColumns>,
  callback: CsvColumnarBatchCallback<TColumns>,
): Promise<void>;
/**
 * Visit columnar batches with runtime-selected columns and managed view lifetime.
 * The callback must be synchronous.
 *
 * @param path - Path to the CSV file.
 * @param options - Serial columnar options, or `undefined` for defaults.
 * @param callback - Synchronous batch handler.
 * @returns A promise that resolves after all batches are visited.
 */
export function withColumnarBatches(
  path: string,
  options: CsvColumnarBatchOptions | undefined,
  callback: CsvColumnarBatchCallback,
): Promise<void> {
  return forEachColumnarBatches(path, options, callback);
}

/**
 * Visit reusable row views without materializing row arrays.
 *
 * The callback must be synchronous. A single view object is rebound for each row and becomes
 * invalid when the callback returns, so copy strings or bytes that must be retained. The
 * `selectedColumns` property records the requested source columns. Without `where`, accessors
 * use physical CSV indexes. With both `where` and a projection, only projected fields may be
 * stored, so accessor indexes are projected positions; use the metadata to map them back to
 * source indexes. Worker parsing is not supported.
 *
 * @typeParam TColumns - Literal projected column indexes recorded in `selectedColumns`.
 * @param path - Path to the CSV file.
 * @param options - Serial file, projection, filter, and validation options.
 * @param callback - Synchronous function invoked once per row.
 * @returns A promise that resolves after all rows have been visited.
 * @throws {TypeError} If the callback returns a promise.
 * @throws {Error} If worker parsing is requested or the file/parser fails.
 */
export function forEachRowViews<TColumns extends CsvColumns | undefined = undefined>(
  path: string,
  options: CsvRowViewsOptions<TColumns>,
  callback: CsvRowViewCallback<TColumns>,
): Promise<void>;
/**
 * Visit row views when the selected-column tuple is not statically known.
 * The callback must be synchronous and the reusable view is valid only during the callback.
 *
 * @param path - Path to the CSV file.
 * @param options - Serial row-view options, or `undefined` for defaults.
 * @param callback - Synchronous row handler.
 * @returns A promise that resolves after all rows are visited.
 */
export function forEachRowViews(
  path: string,
  options: CsvRowViewsOptions | undefined,
  callback: CsvRowViewCallback,
): Promise<void>;
export async function forEachRowViews<TColumns extends CsvColumns | undefined = undefined>(
  path: string,
  suppliedOptions: CsvRowViewsOptions<TColumns> = {} as CsvRowViewsOptions<TColumns>,
  callback: CsvRowViewCallback<TColumns>,
): Promise<void> {
  const options = snapshotCsvOptions(suppliedOptions);
  ensureRowViewsSupported(options);
  const scopedRowView = new ScopedCsvRowView(selectedColumns(options) as TColumns);
  for await (const batch of batches(path, options)) {
    try {
      const rowCount = batch.rowCount;
      if (rowCount === 0) {
        continue;
      }
      const reusable = new NativeCsvRowView(batch.data(), batch.rowOffsets(), batch.fieldOffsets());
      for (let rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
        scopedRowView.bind(reusable.moveTo(rowIndex));
        try {
          const result = callback(scopedRowView, rowIndex);
          if (isPromiseLike(result)) {
            throw new TypeError('row view callback must be synchronous');
          }
        } finally {
          scopedRowView.release();
        }
      }
    } finally {
      batch.close();
    }
  }
}

/**
 * Visit reusable row views with the same lifetime guarantees as {@link forEachRowViews}.
 *
 * The callback is synchronous and the view is invalid after it returns.
 *
 * @typeParam TColumns - Literal projected column indexes recorded in `selectedColumns`.
 * @param path - Path to the CSV file.
 * @param options - Serial file, projection, filter, and validation options.
 * @param callback - Synchronous function invoked once per row.
 * @returns A promise that resolves after all rows have been visited.
 */
export function withRowViews<TColumns extends CsvColumns | undefined = undefined>(
  path: string,
  options: CsvRowViewsOptions<TColumns>,
  callback: CsvRowViewCallback<TColumns>,
): Promise<void>;
/**
 * Visit row views with runtime-selected columns and managed view lifetime.
 * The callback must be synchronous.
 *
 * @param path - Path to the CSV file.
 * @param options - Serial row-view options, or `undefined` for defaults.
 * @param callback - Synchronous row handler.
 * @returns A promise that resolves after all rows are visited.
 */
export function withRowViews(
  path: string,
  options: CsvRowViewsOptions | undefined,
  callback: CsvRowViewCallback,
): Promise<void> {
  return forEachRowViews(path, options, callback);
}

/**
 * Count CSV records without materializing them.
 *
 * Filters created with `csv.column()` and composed with `csv.all()`, `csv.any()`, or `csv.not()`
 * are evaluated by native fast paths. Set `workerCount` above one for parallel counting; workers
 * require uncompressed input, an explicit delimiter, and non-strict validation. Serial counting
 * supports compression and automatic delimiter detection.
 *
 * @param path - Path to the CSV file.
 * @param suppliedOptions - Count, filter, validation, and optional worker settings.
 * @returns A promise containing the record count.
 * @throws {Error} If strict validation is combined with a filter, or if worker restrictions or
 * file/parser errors are encountered.
 */
export async function count(path: string, suppliedOptions: CsvCountOptions = {}): Promise<number> {
  const options = snapshotCsvOptions(suppliedOptions);
  if ((options.workerCount ?? 1) > 1) {
    rejectCompressedSharding(options, 'parallel counting');
    rejectAutoDelimiterSharding(options, 'parallel counting');
    return parallelCount(path, options as CsvParallelCountOptions);
  }

  const filters = toNativeFilters(options.where);
  await using input = await prepareCsvFileInput(path, options);
  if (options.strict === true && filters !== undefined) {
    throw new Error('strict CSV validation is not supported for count filters');
  }
  using parser = createPreparedParser(toParserOptions(options, input.delimiter), undefined, filters);
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
 * Count records through record-safe worker shards.
 *
 * `workerCount` must be greater than one. Workers require uncompressed input, an explicit
 * delimiter, and non-strict validation; use {@link count} for serial counting or strict checks.
 *
 * @param path - Path to the CSV file.
 * @param options - Parallel count options, including the required worker count.
 * @returns A promise containing the total record count.
 * @throws {RangeError} If `workerCount` is not an integer greater than one.
 * @throws {Error} If compression, automatic delimiter detection, or strict validation is enabled.
 */
export { parallelCount };

/**
 * Find byte offsets that divide a CSV file only at record boundaries.
 *
 * The returned array contains shard start offsets followed by the terminal file boundary. Quoted
 * fields and embedded newlines are respected. The operation reads the file directly, so compressed
 * input and automatic delimiter detection are not supported.
 *
 * @param path - Path to the uncompressed CSV file.
 * @param shardCount - Desired number of partitions; the result may contain fewer non-empty shards.
 * @param suppliedOptions - Explicit delimiter and file parser options. Compression is unavailable.
 * @returns Monotonically increasing byte offsets, including `0` and the file-length boundary.
 * @throws {RangeError} If `shardCount` is not a positive integer.
 * @throws {Error} If the delimiter is automatic, compressed, or invalid for native scanning.
 */
export function findCsvSafeSplitOffsets(path: string, shardCount: number, suppliedOptions: CsvShardingOptions = {}): number[] {
  const options = snapshotCsvOptions(suppliedOptions);
  rejectCompressedSharding(options, 'CSV split offset scanning');
  rejectAutoDelimiterSharding(options, 'CSV split offset scanning');
  return findCsvSafeSplitOffsetsNative(path, shardCount, options.delimiter ?? ',');
}

/**
 * Find non-empty CSV byte ranges that begin and end at record boundaries.
 *
 * Shards use inclusive `start` and `end` offsets and never split quoted fields or embedded
 * newlines. A small file can produce fewer non-empty shards than requested. The operation does
 * not support compressed input or automatic delimiter detection.
 *
 * @param path - Path to the uncompressed CSV file.
 * @param shardCount - Desired number of partitions; the result may contain fewer shards.
 * @param suppliedOptions - Explicit delimiter and file parser options. Compression is unavailable.
 * @returns Non-empty, ordered byte ranges suitable for independent worker processing.
 * @throws {RangeError} If `shardCount` is not a positive integer.
 * @throws {Error} If the delimiter is automatic, compressed, or invalid for native scanning.
 */
export function findCsvSafeShards(path: string, shardCount: number, suppliedOptions: CsvShardingOptions = {}): CsvShard[] {
  const options = snapshotCsvOptions(suppliedOptions);
  rejectCompressedSharding(options, 'CSV shard scanning');
  rejectAutoDelimiterSharding(options, 'CSV shard scanning');
  return findCsvSafeShardsNative(path, shardCount, options.delimiter ?? ',');
}

/**
 * Create a reusable pool for repeated parallel row and count operations.
 *
 * The pool captures its file options when created. `workerCount` must be greater than one, and
 * pooled operations require uncompressed input, an explicit delimiter, and non-strict validation.
 * Call `close()` (or use `using`) when the pool is no longer needed.
 *
 * @typeParam TColumns - Literal projected column indexes for pooled row operations.
 * @param path - Path to the uncompressed CSV file.
 * @param options - Parallel worker-pool options, including `workerCount`.
 * @returns A reusable worker pool. Its `rows()` and `count()` methods are asynchronous.
 * @throws {RangeError} If `workerCount` is not an integer greater than one.
 * @throws {Error} If compression or automatic delimiter detection is enabled. Strict validation
 * is rejected when `count()` or `rows()` is called on the returned pool.
 */
export function workerPool<TColumns extends CsvColumns | undefined = undefined>(
  path: string,
  options: CsvWorkerPoolOptions<TColumns>,
): CsvWorkerPool<TColumns>;
/**
 * Create a reusable worker pool for repeated row operations.
 *
 * Use this when one-off worker startup becomes noticeable across repeated calls.
 */
export function workerPool(path: string, options: CsvWorkerPoolOptions): CsvWorkerPool {
  return createWorkerPool(path, options);
}

/**
 * The package's file-oriented API namespace.
 *
 * The namespace combines materialization, counting, filtering, worker, batch, row-view, and
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
   * Create a reusable pool for parallel row and count operations.
   * The pool captures its options at construction; close it when finished, and note that strict
   * validation is rejected when `rows()` or `count()` starts.
   * @param path - Path to an uncompressed CSV file.
   * @param options - Parallel options with `workerCount` greater than one.
   * @returns A reusable `CsvWorkerPool`.
   */
  workerPool,
  /**
   * Parse one in-memory buffer into materialized rows.
   * Compression, automatic delimiter detection, and workers are unavailable.
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
   * Options are captured at invocation. Serial batches preserve file order; worker batches arrive
   * as each shard reports them, without a global file-order guarantee.
   * @param path - Path to the CSV file.
   * @param options - File, projection, filter, validation, and worker settings.
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
   * Count records through record-safe worker shards.
   * Workers require an explicit delimiter, uncompressed input, and non-strict validation.
   * @param path - Path to the CSV file.
   * @param options - Parallel count options with `workerCount` greater than one.
   * @returns A promise containing the total record count.
   */
  parallelCount,
  /**
   * Stream materialized rows through record-safe worker shards.
   * Worker batches are yielded as shards report them and are not globally ordered.
   * @param path - Path to the CSV file.
   * @param options - Parallel row options with `workerCount` greater than one.
   * @returns An async generator of projected row batches.
   */
  parallelRows,
  /**
   * Stream disposable native-backed batches.
   * Close every yielded batch, or use `for await (using batch of ...)`.
   * @param path - Path to the CSV file.
   * @param options - Serial file and parser options.
   * @returns An async generator of `NativeCsvBatch` objects.
   */
  batches,
  /**
   * Process native batches and close each one after the callback settles.
   * @param path - Path to the CSV file.
   * @param options - Serial file and parser options.
   * @param callback - Synchronous or asynchronous batch handler.
   * @returns A promise that resolves after all batches are processed.
   */
  withBatches,
  /**
   * Visit reusable columnar batch views with a synchronous callback.
   * The view is invalid after the callback returns; selected indexes are relative to projection.
   * @param path - Path to the CSV file.
   * @param options - Serial columnar options; workers are unsupported.
   * @param callback - Synchronous batch handler.
   * @returns A promise that resolves after all batches are visited.
   */
  forEachColumnarBatches,
  /**
   * Visit reusable columnar batch views, closing native storage after each callback.
   * The callback is synchronous and the view cannot be retained.
   * @param path - Path to the CSV file.
   * @param options - Serial columnar options.
   * @param callback - Synchronous batch handler.
   * @returns A promise that resolves after all batches are visited.
   */
  withColumnarBatches,
  /**
   * Visit reusable row views with a synchronous callback.
   * The view is invalid after the callback returns; workers are unsupported.
   * @param path - Path to the CSV file.
   * @param options - Serial row-view options.
   * @param callback - Synchronous row handler.
   * @returns A promise that resolves after all rows are visited.
   */
  forEachRowViews,
  /**
   * Visit reusable row views with the same lifetime rules as `forEachRowViews`.
   * @param path - Path to the CSV file.
   * @param options - Serial row-view options.
   * @param callback - Synchronous row handler.
   * @returns A promise that resolves after all rows are visited.
   */
  withRowViews,
  /**
   * Count CSV records without materializing them.
   * Serial counting supports compression and automatic delimiter detection; filtered strict mode is unsupported.
   * @param path - Path to the CSV file.
   * @param suppliedOptions - Count, filter, validation, and worker settings.
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
  options: CsvApiFileOptions | CsvFileOptions,
  delimiter: CsvParserOptions['delimiter'] = options.delimiter,
): CsvParserOptions {
  const selectedColumns = 'columns' in options && options.columns !== undefined
    ? options.columns
    : options.selectedColumns;
  if ('columns' in options && options.columns !== undefined && options.selectedColumns !== undefined) {
    throw new Error('use columns or selectedColumns, not both');
  }
  return {
    delimiter,
    encoding: options.encoding,
    strict: options.strict,
    selectedColumns,
    fixedColumns: options.fixedColumns,
  };
}

function selectedColumns(options: CsvApiFileOptions): CsvColumns | undefined {
  if (options.columns !== undefined && options.selectedColumns !== undefined) {
    throw new Error('use columns or selectedColumns, not both');
  }
  const columns = options.columns ?? options.selectedColumns;
  normalizeColumns(columns);
  return columns;
}

function materializeRows<TColumns extends CsvColumns | undefined>(
  batch: NativeCsvBatch,
  columns: CsvColumns | undefined,
  projected: boolean,
  target: CsvRow[] = [],
): CsvProjectedRow<TColumns>[] {
  return batch.rowsInto(target, projected ? undefined : columns) as CsvProjectedRow<TColumns>[];
}

function ensureRowViewsSupported(options: CsvApiFileOptions): void {
  if ((options.workerCount ?? 1) > 1) {
    throw new Error(
      'row view callbacks do not support workerCount; use rows()/parallelRows() for materialized rows or withBatches() for low-level streaming',
    );
  }
}

function ensureColumnarBatchesSupported(options: CsvApiFileOptions): void {
  ensureRowViewsSupported(options);
  if (options.strict === true && selectedColumns(options) !== undefined) {
    throw new Error(
      'columnar batch callbacks do not support strict selectedColumns; use rows() for projected validation or withBatches() for manual low-level handling',
    );
  }
}

function rejectFilteredStrictSchema(options: CsvApiFileOptions): void {
  if (options.where !== undefined) {
    rejectStrictSchemaUnsupported(options, 'filtered rows');
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function';
}

class ScopedCsvRowView<TSelectedColumns extends CsvColumns | undefined = undefined> implements CsvRowView<TSelectedColumns> {
  readonly #selectedColumns: TSelectedColumns;
  #rowView: NativeCsvRowView | null = null;

  constructor(selectedColumns: TSelectedColumns) {
    this.#selectedColumns = selectedColumns;
  }

  bind(rowView: NativeCsvRowView): this {
    this.#rowView = rowView;
    return this;
  }

  release(): void {
    this.#rowView = null;
  }

  get rowIndex(): number {
    return this.#requireRowView().rowIndex;
  }

  get fieldCount(): number {
    return this.#requireRowView().fieldCount;
  }

  get selectedColumns(): TSelectedColumns {
    return this.#selectedColumns;
  }

  fieldRange(columnIndex: number) {
    return this.#requireRowView().fieldRange(columnIndex);
  }

  range(columnIndex: number) {
    return this.#requireRowView().range(columnIndex);
  }

  fieldBytes(columnIndex: number) {
    return this.#requireRowView().fieldBytes(columnIndex);
  }

  bytes(columnIndex: number) {
    return this.#requireRowView().bytes(columnIndex);
  }

  fieldBuffer(columnIndex: number) {
    return this.#requireRowView().fieldBuffer(columnIndex);
  }

  buffer(columnIndex: number) {
    return this.#requireRowView().buffer(columnIndex);
  }

  fieldString(columnIndex: number) {
    return this.#requireRowView().fieldString(columnIndex);
  }

  getPhysical(columnIndex: number) {
    return this.#requireRowView().getPhysical(columnIndex);
  }

  get(columnIndex: number) {
    return this.#requireRowView().get(columnIndex);
  }

  pickPhysical(columns: CsvColumns): string[] {
    return this.#requireRowView().pickPhysical(columns);
  }

  pick(columns: CsvColumns): string[] {
    return this.#requireRowView().pick(columns);
  }

  #requireRowView(): NativeCsvRowView {
    if (this.#rowView === null) {
      throw new Error('row view is only valid during row view callback');
    }
    return this.#rowView;
  }
}

class ScopedCsvColumnarBatchView<TSelectedColumns extends CsvColumns | undefined = undefined>
  implements CsvColumnarBatchView<TSelectedColumns> {
  readonly #selectedColumns: TSelectedColumns;
  #batch: NativeCsvBatch | null = null;

  constructor(selectedColumns: TSelectedColumns) {
    this.#selectedColumns = selectedColumns;
  }

  bind(batch: NativeCsvBatch): this {
    this.#batch = batch;
    return this;
  }

  release(): void {
    this.#batch = null;
  }

  get rowCount(): number {
    return this.#requireBatch().rowCount;
  }

  get totalFields(): number {
    return this.#requireBatch().totalFields;
  }

  get dataLength(): number {
    return this.#requireBatch().dataLength;
  }

  get selectedColumns(): TSelectedColumns {
    return this.#selectedColumns;
  }

  data(): Buffer {
    return this.#requireBatch().data();
  }

  dataView(): Uint8Array {
    return this.#requireBatch().dataView();
  }

  rowOffsets(): BigUint64Array {
    return this.#requireBatch().rowOffsets();
  }

  fieldOffsets(): BigUint64Array {
    return this.#requireBatch().fieldOffsets();
  }

  rowFieldCount(rowIndex: number): number {
    return this.#requireBatch().rowFieldCount(rowIndex);
  }

  fieldRange(rowIndex: number, columnIndex: number) {
    return this.#requireBatch().fieldRange(rowIndex, columnIndex);
  }

  fieldBytes(rowIndex: number, columnIndex: number) {
    return this.#requireBatch().fieldBytes(rowIndex, columnIndex);
  }

  fieldBuffer(rowIndex: number, columnIndex: number) {
    return this.#requireBatch().fieldBuffer(rowIndex, columnIndex);
  }

  forEachColumnRange(
    columnIndex: number,
    callback: (rowIndex: number, start: number, end: number) => void,
    startRow?: number,
    endRow?: number,
  ) {
    return this.#requireBatch().forEachColumnRange(columnIndex, callback, startRow, endRow);
  }

  forEachColumnBytes(columnIndex: number, callback: (rowIndex: number, bytes: Uint8Array) => void, startRow?: number, endRow?: number) {
    return this.#requireBatch().forEachColumnBytes(columnIndex, callback, startRow, endRow);
  }

  scanColumns(
    columns: CsvColumns,
    callback: (rowIndex: number, ranges: Float64Array, data: Buffer) => void,
    startRow?: number,
    endRow?: number,
  ) {
    return this.#requireBatch().scanColumns(columns, callback, startRow, endRow);
  }

  #requireBatch(): NativeCsvBatch {
    if (this.#batch === null) {
      throw new Error('columnar batch view is only valid during columnar batch callback');
    }
    return this.#batch;
  }
}

function toNativeFilters(where: CsvFilter | undefined): readonly CsvNativeFilterProgramEntry[] | undefined {
  return nativeFilterProgramFor(where);
}
