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
import { optionalLatin1RowsNative } from './native.js';
import {
  encodingCode,
  normalizeColumns,
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
 * Parse one in-memory chunk into materialized rows.
 *
 * Use this when you already own buffering and still want the high-level row API.
 * Accepts only single-thread row options, so `workerCount` is intentionally unavailable.
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
 * Use this for the most direct high-level API. With `workerCount > 1`, the work
 * fans out across Bun workers.
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
  if (
    options.strict !== true && options.fixedColumns === undefined && validator === undefined
    && encodingCode(options.encoding) === 1 && optionalLatin1RowsNative() !== null
  ) {
    yield* latin1Rows(input.chunks(), input.delimiter, columns, filters) as AsyncGenerator<
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
        const values = materializeRows<TColumns>(batch, columns, projected);
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
      const values = materializeRows<TColumns>(batch, columns, projected);
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

export { parallelRows };
export { CsvWorkerPool };

/**
 * Stream native batches with explicit lifetime control.
 *
 * Use this when you want low-allocation access to row views or byte ranges and
 * are comfortable closing each batch yourself.
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
 * Stream reusable columnar batch views without materializing one JS string per field.
 *
 * When `columns` is defined, batch column indexes are relative to the projected
 * output order. This API is synchronous by design so the view can be safely reused.
 */
export function forEachColumnarBatches<TColumns extends CsvColumns | undefined = undefined>(
  path: string,
  options: CsvColumnarBatchOptions<TColumns>,
  callback: CsvColumnarBatchCallback<TColumns>,
): Promise<void>;
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

export function withColumnarBatches<TColumns extends CsvColumns | undefined = undefined>(
  path: string,
  options: CsvColumnarBatchOptions<TColumns>,
  callback: CsvColumnarBatchCallback<TColumns>,
): Promise<void>;
export function withColumnarBatches(
  path: string,
  options: CsvColumnarBatchOptions | undefined,
  callback: CsvColumnarBatchCallback,
): Promise<void> {
  return forEachColumnarBatches(path, options, callback);
}

/**
 * Stream reusable row views without materializing row arrays.
 *
 * `selectedColumns` on the row view is metadata only. Row accessors still use
 * physical CSV column indexes; use `row.getPhysical()` for explicit call sites.
 * This API is synchronous by design so the view can be safely reused.
 */
export function forEachRowViews<TColumns extends CsvColumns | undefined = undefined>(
  path: string,
  options: CsvRowViewsOptions<TColumns>,
  callback: CsvRowViewCallback<TColumns>,
): Promise<void>;
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

export function withRowViews<TColumns extends CsvColumns | undefined = undefined>(
  path: string,
  options: CsvRowViewsOptions<TColumns>,
  callback: CsvRowViewCallback<TColumns>,
): Promise<void>;
export function withRowViews(
  path: string,
  options: CsvRowViewsOptions | undefined,
  callback: CsvRowViewCallback,
): Promise<void> {
  return forEachRowViews(path, options, callback);
}

/**
 * Count rows without materializing them.
 *
 * Full filter support exists here because count has native fast paths for
 * filters created with `csv.column()` and grouped with `csv.all()`, `csv.any()`, and `csv.not()`.
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

export { parallelCount };

export function findCsvSafeSplitOffsets(path: string, shardCount: number, suppliedOptions: CsvShardingOptions = {}): number[] {
  const options = snapshotCsvOptions(suppliedOptions);
  rejectCompressedSharding(options, 'CSV split offset scanning');
  rejectAutoDelimiterSharding(options, 'CSV split offset scanning');
  return findCsvSafeSplitOffsetsNative(path, shardCount, options.delimiter ?? ',');
}

export function findCsvSafeShards(path: string, shardCount: number, suppliedOptions: CsvShardingOptions = {}): CsvShard[] {
  const options = snapshotCsvOptions(suppliedOptions);
  rejectCompressedSharding(options, 'CSV shard scanning');
  rejectAutoDelimiterSharding(options, 'CSV shard scanning');
  return findCsvSafeShardsNative(path, shardCount, options.delimiter ?? ',');
}

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

export const csv = {
  all,
  any,
  column,
  not,
  re,
  workerPool,
  parse,
  rows,
  parallelCount,
  parallelRows,
  batches,
  withBatches,
  forEachColumnarBatches,
  withColumnarBatches,
  forEachRowViews,
  withRowViews,
  count,
  findCsvSafeSplitOffsets,
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
): CsvProjectedRow<TColumns>[] {
  if (projected) {
    return batch.rowsInto([]) as CsvProjectedRow<TColumns>[];
  }
  return batch.rowsInto([], columns) as CsvProjectedRow<TColumns>[];
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
