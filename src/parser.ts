import {
  NativeCsvBatch,
  NativeCsvRawRecordBatch,
} from './batches.js';
import type { CsvFileInput } from './file-stream.js';
import {
  EMPTY_BUFFER,
  native,
  type NativePointer,
  u64ToSafeNumber,
} from './native.js';
import {
  encodingCode,
  normalizeChunk,
  normalizeColumns,
  normalizeFixedColumnsCount,
  normalizeNativeFilterProgram,
  normalizeNativeFilters,
  projectionFilterProgram,
  rejectSelectedColumns,
  validateCsvDialect,
} from './normalize.js';
import {
  type CsvStrictSchemaValidator,
  strictSchemaValidator,
} from './strict-schema.js';
import {
  prepareTransforms,
  selectTransforms,
  snapshotTransforms,
} from './transforms.js';
import type {
  CsvColumns,
  CsvNativeFilterProgramEntry,
  CsvParserOptions,
  CsvRow,
  CsvTransform,
  NativeCsvParserOptions,
} from './types.js';

function destroyNativeCsvParser(handle: NativePointer): void {
  native.symbols.csv_parser_destroy(handle);
}

export const nativeCsvParserFinalizer = new FinalizationRegistry<NativePointer>(destroyNativeCsvParser);

export async function* parseFileChunks<TBatch extends NativeCsvBatch | NativeCsvRawRecordBatch>(
  input: CsvFileInput,
  parser: { writeBatch(chunk: Uint8Array, final?: boolean): TBatch; },
  limit: number | undefined,
): AsyncGenerator<TBatch, void> {
  let remaining = limit;
  if (remaining !== 0) {
    for await (const chunk of input.chunks()) {
      const batch = parser.writeBatch(chunk);
      const count = batch.rowCount;
      if (count > 0) {
        yield batch;
      } else {
        batch.close();
      }
      if (remaining !== undefined) {
        remaining -= count;
        if (remaining === 0) {
          break;
        }
      }
    }
  }
  const final = parser.writeBatch(EMPTY_BUFFER, true);
  if (final.rowCount > 0) {
    yield final;
  } else {
    final.close();
  }
}

export async function* parseRawRecordChunks(
  input: CsvFileInput,
  options: CsvParserOptions,
  program: readonly CsvNativeFilterProgramEntry[] | undefined,
): AsyncGenerator<NativeCsvRawRecordBatch, void> {
  normalizeFixedColumnsCount(options.fixedColumns, 'fixed column count');
  const handle = createNativeCsvParser(options, true);
  const parser = {
    writeBatch(chunk: Uint8Array, final = false): NativeCsvRawRecordBatch {
      const bytes = normalizeChunk(chunk);
      const batch = native.symbols.csv_parser_write_raw_records(handle, bytes, bytes, final);
      if (batch === null) {
        throw new Error(`native CSV parser failed: ${native.symbols.csv_parser_last_error(handle) ?? 'native parser error unavailable'}`);
      }
      return new NativeCsvRawRecordBatch(batch);
    },
  };
  nativeCsvParserFinalizer.register(parser, handle, parser);
  try {
    prepareNativeParser(handle, undefined, program);
    yield* parseFileChunks(input, parser, options.limit);
  } finally {
    nativeCsvParserFinalizer.unregister(parser);
    destroyNativeCsvParser(handle);
  }
}

export async function countFileChunks(
  input: CsvFileInput,
  options: CsvParserOptions,
  filters?: readonly CsvNativeFilterProgramEntry[],
): Promise<number> {
  // A count-only stream can discard every field, including those in an unfinished record.
  const columns = options.fixedColumns !== undefined && options.strict !== true && filters === undefined ? [] : undefined;
  using parser = createPreparedParser(options, columns, filters);
  let total = 0;
  if (options.strict === true) {
    for await (using batch of parseFileChunks(input, parser, options.limit)) {
      total += batch.rowCount;
    }
    return total;
  }
  if (options.limit !== 0) {
    for await (const chunk of input.chunks()) {
      total += parser.writeCount(chunk);
      if (total === options.limit) {
        break;
      }
    }
  }
  return total + parser.endCount();
}

export function createPreparedParser(
  options: CsvParserOptions,
  columns?: CsvColumns,
  program?: readonly CsvNativeFilterProgramEntry[],
  transform?: readonly CsvTransform[],
  output: 'batches' | 'rows' = 'batches',
): NativeCsvParser {
  // Some callers validate or project the full batch during materialization.
  if (options.columns !== columns) {
    normalizeColumns(options.columns);
  }
  return NativeCsvParser[createSchemaParser]({
    encoding: options.encoding,
    delimiter: options.delimiter,
    quote: options.quote,
    recordDelimiter: options.recordDelimiter,
    fixedColumns: options.fixedColumns,
    strict: options.strict,
    skipRows: options.skipRows,
    limit: options.limit,
    expectedHeaders: options.expectedHeaders,
    requireHeader: options.requireHeader,
    minDataRows: options.minDataRows,
    columns,
    filterProgram: program,
    transform: options.strict && options.columns && transform ? selectTransforms(transform, options.columns) : transform,
  }, output);
}

interface PreparedNativeWriter {
  writeBatch(input: NodeJS.TypedArray | DataView, final: boolean): NativePointer | null;
  writeCount(input: NodeJS.TypedArray | DataView, final: boolean): bigint | number;
}

/**
 * Prepares native projection and filter buffers for an existing parser handle.
 *
 * This low-level helper is intended for the parser implementation. The native
 * parser owns a copy of the normalized configuration, and the caller remains
 * responsible for closing the handle.
 *
 * @param handle Open native parser handle.
 * @param columns Optional zero-based output columns.
 * @param program Optional postfix sequence of filter predicates and boolean
 * operators. It is validated and normalized before preparation.
 * @returns Prepared write functions for batches and counts.
 * @throws {Error} If the native library rejects the configuration.
 */
export function prepareNativeParser(
  handle: NativePointer,
  columns: CsvColumns | undefined,
  program: readonly CsvNativeFilterProgramEntry[] | undefined,
): PreparedNativeWriter {
  const normalizedColumns = normalizeColumns(columns);
  const hasProjection = columns !== undefined;
  const columnCount = BigInt(normalizedColumns.length);
  const normalized = program === undefined ? normalizeNativeFilters(undefined) : normalizeNativeFilterProgram(program);
  const filterCount = BigInt(normalized.filterCount);
  const valueCount = BigInt(normalized.valueCount);
  if (
    !native.symbols.csv_parser_prepare(
      handle,
      hasProjection,
      normalizedColumns,
      columnCount,
      normalized.descriptors,
      filterCount,
      normalized.valuesData,
      normalized.valuesData,
      normalized.valueOffsets,
      valueCount,
    )
  ) {
    throw new Error(`native CSV parser failed: ${native.symbols.csv_parser_last_error(handle) ?? 'native parser error unavailable'}`);
  }
  return {
    writeBatch: (input, final) => native.symbols.csv_parser_write_prepared_batch(handle, input, input, final),
    writeCount: (input, final) => {
      const count = native.symbols.csv_parser_write_prepared_count(handle, input, input, final);
      // The prepared ABI reserves UINT64_MAX so successful chunks need only one FFI call.
      if (count === 0xffff_ffff_ffff_ffffn) {
        throw new Error(`native CSV parser failed: ${native.symbols.csv_parser_last_error(handle) ?? 'native parser error unavailable'}`);
      }
      return count;
    },
  };
}

export function validateRowSelection({ skipRows, limit }: Pick<CsvParserOptions, 'skipRows' | 'limit'>): void {
  if (skipRows !== undefined && (!Number.isSafeInteger(skipRows) || skipRows < 0)) {
    throw new RangeError('skipRows must be a non-negative safe integer');
  }
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
    throw new RangeError('limit must be a non-negative safe integer');
  }
}

export function setRowSelection(handle: NativePointer, options: CsvParserOptions, captureHeader = false): void {
  if (options.skipRows !== undefined || options.limit !== undefined) {
    native.symbols.csv_parser_set_row_selection(
      handle,
      BigInt(options.skipRows ?? 0),
      options.limit === undefined ? 0xffff_ffff_ffff_ffffn : BigInt(options.limit),
      captureHeader,
    );
  }
}

function createNativeCsvParser(options: CsvParserOptions, prepared = false): NativePointer {
  const { skipRows, limit, quote, recordDelimiter } = options;
  validateRowSelection({ skipRows, limit });
  validateCsvDialect(options);
  const delimiter = options.delimiter ?? ',';
  if (delimiter === 'auto') {
    throw new Error('automatic delimiter detection is only supported by file APIs');
  }
  if (delimiter.length !== 1) {
    throw new Error('delimiter must be one character');
  }
  const encoding = encodingCode(options.encoding);
  const handle = quote === false || recordDelimiter !== undefined
    ? native.symbols.csv_parser_create_dialect(
      encoding,
      delimiter.charCodeAt(0),
      options.fixedColumns ?? 0,
      quote ?? true,
      recordDelimiter === '\n',
    )
    : prepared
    ? native.symbols.csv_parser_create_prepared(encoding, delimiter.charCodeAt(0), options.fixedColumns ?? 0)
    : native.symbols.csv_parser_create(encoding, delimiter.charCodeAt(0));
  if (handle === null) {
    throw new Error('failed to create native CSV parser');
  }
  setRowSelection(handle, { skipRows, limit });
  return handle;
}

const createSchemaParser = Symbol('createSchemaParser');

/**
 * Incrementally parses caller-owned CSV chunks through the native parser.
 *
 * Use this class when the application controls buffering. A write may return a
 * `NativeCsvBatch` containing complete rows while retaining an incomplete row
 * for the next write. Every returned batch owns native memory and must be
 * closed or disposed. `write()` and `end()` are convenience methods that
 * materialize rows and close their temporary batches automatically.
 *
 * The constructor captures the projection and filters for the lifetime of the parser.
 * Filters use physical column indexes. Batches emit fields in projection order.
 *
 * @example
 * ```ts
 * using parser = new NativeCsvParser({ delimiter: ';' });
 * using first = parser.writeBatch(Buffer.from('1;Ada\n2;Bob'), false);
 * console.log(first.rows()); // [['1', 'Ada']]
 * using final = parser.endBatch();
 * console.log(final.rows()); // [['2', 'Bob']]
 * ```
 */
export class NativeCsvParser {
  #handle: NativePointer | null;
  readonly #strict: boolean;
  readonly #fixedColumns: number | undefined;
  readonly #writer: PreparedNativeWriter | undefined;
  readonly #transformStrictBatch: boolean;
  #validator: CsvStrictSchemaValidator | undefined;
  #captureSkippedHeader = false;

  static [createSchemaParser](options: NativeCsvParserOptions, output: 'batches' | 'rows'): NativeCsvParser {
    const validator = strictSchemaValidator(options);
    const parser = new NativeCsvParser(options);
    if (output === 'rows' && !parser.#strict && options.transform?.length) {
      native.symbols.csv_parser_enable_transformed_quoted_spans(parser.#requireHandle());
    }
    parser.#validator = validator;
    if (validator !== undefined && (options.skipRows ?? 0) > 0) {
      parser.#captureSkippedHeader = true;
      setRowSelection(parser.#requireHandle(), options, true);
    }
    return parser;
  }

  /**
   * Creates an open parser.
   *
   * @param options Parser settings, output columns and predicates. The delimiter defaults
   * to comma. Strict mode requires unfiltered, unprojected input. File and buffer
   * APIs handle schema metadata such as `expectedHeaders`.
   * @throws {Error} If the delimiter is not one character or native parser
   * creation fails.
   * @throws {RangeError} If selected or fixed column settings are out of range.
   */
  constructor(options: NativeCsvParserOptions = {}) {
    rejectSelectedColumns(options);
    this.#strict = options.strict === true;
    this.#fixedColumns = normalizeFixedColumnsCount(options.fixedColumns, 'fixed column count');
    const { columns, filterProgram } = options;
    if (filterProgram !== undefined && (options.equalsFilter !== undefined || options.filters !== undefined)) {
      throw new Error('filterProgram cannot be combined with equalsFilter or filters');
    }
    const program = filterProgram === undefined ? projectionFilterProgram(options) : filterProgram;
    if (this.#strict && (columns !== undefined || program !== undefined)) {
      throw new Error('strict CSV validation is not supported for projected batches or filters');
    }
    const transforms = snapshotTransforms(options.transform);
    const customDialect = options.quote === false || options.recordDelimiter !== undefined;
    if (customDialect && this.#strict) {
      throw new Error('strict CSV validation requires the default quote and record delimiter settings');
    }
    const prepared = customDialect || columns !== undefined || program !== undefined || (!this.#strict && Boolean(transforms?.length));
    const handle = createNativeCsvParser(options, prepared);
    try {
      const active = transforms?.length ? prepareTransforms(handle, transforms, columns) : false;
      this.#transformStrictBatch = this.#strict && active;
      this.#writer = prepared ? prepareNativeParser(handle, columns, program) : undefined;
    } catch (error) {
      destroyNativeCsvParser(handle);
      throw error;
    }
    this.#handle = handle;
    nativeCsvParserFinalizer.register(this, handle, this);
  }

  /** Whether the native parser handle has been released. */
  get closed(): boolean {
    return this.#handle === null;
  }

  /**
   * Parses a chunk and materializes all complete rows emitted by that call.
   *
   * The temporary native batch is closed before this method returns. Use
   * `writeBatch()` when byte views or low-allocation access are required.
   *
   * @param chunk Input bytes. The parser may retain an incomplete final row for
   * a later call.
   * @param final Set to `true` when this is the last input chunk; buffered row
   * state is flushed before returning.
   * @returns Materialized UTF-8 rows emitted by this call.
   * @throws {Error} If the parser is closed or native parsing fails.
   */
  write(chunk: NodeJS.TypedArray | DataView, final = false): CsvRow[] {
    const batch = this.writeBatch(chunk, final);
    try {
      return batch.rows();
    } finally {
      batch.close();
    }
  }

  /**
   * Parses a chunk and returns an owned batch of complete rows.
   *
   * Call `batch.close()` or use `using` for the returned batch. The parser may
   * retain an incomplete row between calls. `final: true` marks the input end
   * and flushes that row.
   *
   * @param chunk Input bytes.
   * @param final Whether this is the final input chunk.
   * @returns A native batch that the caller owns.
   * @throws {Error} If the parser is closed or native parsing fails.
   */
  writeBatch(chunk: NodeJS.TypedArray | DataView, final = false): NativeCsvBatch {
    const handle = this.#requireHandle();
    const input = normalizeChunk(chunk);
    const batch = this.#writer !== undefined
      ? this.#writer.writeBatch(input, final)
      : this.#strict && this.#fixedColumns !== undefined
      ? native.symbols.csv_parser_write_strict_fixed_batch(
        handle,
        input,
        input,
        final,
        this.#fixedColumns,
      )
      : this.#strict
      ? native.symbols.csv_parser_write_strict_batch(handle, input, input, final)
      : this.#fixedColumns !== undefined
      ? native.symbols.csv_parser_write_fixed_batch(handle, input, input, final, this.#fixedColumns)
      : native.symbols.csv_parser_write_batch(handle, input, input, final);
    if (batch === null) {
      throw new Error(`native CSV parser failed: ${this.#lastError()}`);
    }
    if (this.#transformStrictBatch) {
      using _original = this.#validatedBatch(batch, final);
      const result = native.symbols.csv_parser_transform_validated_batch(handle, batch);
      if (!result) {
        throw new Error(`native CSV parser failed: ${this.#lastError()}`);
      }
      return new NativeCsvBatch(result);
    }
    return this.#validatedBatch(batch, final);
  }

  /**
   * Flushes the parser and materializes its final rows.
   *
   * The temporary final batch is closed before this method returns. Use
   * `endBatch()` when the native batch representation is needed.
   *
   * @returns Materialized UTF-8 rows pending at end of input.
   * @throws {Error} If the parser is closed or the final row is invalid.
   */
  end(): CsvRow[] {
    const batch = this.endBatch();
    try {
      return batch.rows();
    } finally {
      batch.close();
    }
  }

  /**
   * Flushes buffered parser state and returns the final owned batch.
   *
   * @returns A native batch that the caller owns and must close.
   * @throws {Error} If the parser is closed or the final row is invalid.
   */
  endBatch(): NativeCsvBatch {
    return this.writeBatch(EMPTY_BUFFER, true);
  }

  /**
   * Counts complete rows emitted by a chunk without materializing fields.
   *
   * Sum the results from each write and call `endCount()` for the final
   * buffered row when processing split input.
   *
   * @param chunk Input bytes.
   * @param final Whether this is the final input chunk.
   * @returns The number of rows emitted by this call.
   * @throws {Error} In strict mode, because count mode has no strict validator,
   * or if the parser is closed/native parsing fails.
   */
  writeCount(chunk: NodeJS.TypedArray | DataView, final = false): number {
    if (this.#strict) {
      throw new Error('strict CSV validation is not supported for count');
    }
    if (this.#writer === undefined && this.#fixedColumns !== undefined) {
      using batch = this.writeBatch(chunk, final);
      return batch.rowCount;
    }

    const handle = this.#requireHandle();
    const input = normalizeChunk(chunk);
    return u64ToSafeNumber(
      this.#writer === undefined
        ? native.symbols.csv_parser_write_count(handle, input, input, final)
        : this.#writer.writeCount(input, final),
      'CSV parsed row count',
    );
  }

  /**
   * Flushes buffered state and returns the number of matching final records.
   *
   * @returns The number of rows emitted while finishing the stream.
   * @throws {Error} If strict mode is enabled, the parser is closed, or native
   * parsing fails.
   */
  endCount(): number {
    return this.writeCount(EMPTY_BUFFER, true);
  }

  /**
   * Discards buffered row state and parser errors while keeping this parser open.
   *
   * Row skipping and limiting restart with the constructor's values. Projection and filters stay active.
   *
   * @throws {Error} If the parser is already closed.
   */
  reset(): void {
    native.symbols.csv_parser_reset_stream(this.#requireHandle());
  }

  /**
   * Releases the native parser handle.
   *
   * Closing is idempotent. Subsequent parsing calls throw; batches already
   * returned by the parser retain their own lifetime and must be closed
   * separately.
   */
  close(): void {
    const handle = this.#handle;
    if (handle === null) {
      return;
    }

    this.#handle = null;
    nativeCsvParserFinalizer.unregister(this);
    destroyNativeCsvParser(handle);
  }

  /** Implements `using` / explicit resource management. */
  [Symbol.dispose](): void {
    this.close();
  }

  #requireHandle(): NativePointer {
    if (this.#handle === null) {
      throw new Error('native CSV parser is closed');
    }
    return this.#handle;
  }

  #lastError(): string {
    return native.symbols.csv_parser_last_error(this.#requireHandle()) ?? 'native parser error unavailable';
  }

  #validatedBatch(pointer: NativePointer, final: boolean): NativeCsvBatch {
    const batch = new NativeCsvBatch(pointer);
    if (this.#validator === undefined) {
      return batch;
    }
    try {
      const handle = this.#requireHandle();
      if (this.#captureSkippedHeader) {
        const header = native.symbols.csv_parser_take_skipped_header(handle);
        if (header !== null) {
          using first = new NativeCsvBatch(header);
          this.#validator.validateBatch(first);
        }
      }
      this.#validator.validateBatch(batch);
      if (final) {
        const skipped = this.#captureSkippedHeader
          ? u64ToSafeNumber(native.symbols.csv_parser_skipped_rows(handle), 'CSV skipped row count')
          : 0;
        this.#validator.finish(Math.max(0, skipped - 1));
      }
      return batch;
    } catch (error) {
      batch.close();
      throw error;
    }
  }
}
