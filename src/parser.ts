import { NativeCsvBatch } from './batches.js';
import {
  EMPTY_BUFFER,
  native,
  type NativePointer,
  optionalPreparedParserNative,
  u64ToSafeNumber,
} from './native.js';
import {
  encodingCode,
  normalizeChunk,
  normalizeColumns,
  normalizeEqualsFilter,
  normalizeFixedColumnsCount,
  normalizeInFilter,
  normalizeNativeFilterProgram,
  normalizeNativeFilters,
  normalizeStartsWithFilter,
} from './normalize.js';
import type { CsvNativeFilterProgramEntry } from './normalize.js';
import type {
  CsvColumns,
  CsvEqualsFilter,
  CsvInFilter,
  CsvNativeFilter,
  CsvNativeProjectionOptions,
  CsvParserOptions,
  CsvRow,
  CsvStartsWithFilter,
} from './types.js';

function destroyNativeCsvParser(handle: NativePointer): void {
  native.symbols.csv_parser_destroy(handle);
}

const nativeCsvParserFinalizer = new FinalizationRegistry<NativePointer>(destroyNativeCsvParser);

/**
 * The fixed-configuration parser surface used by high-level streaming APIs.
 *
 * A prepared parser captures projection and filter state once, so each chunk
 * is processed with the same configuration. The parser owns its native handle
 * and must be closed or disposed after use.
 */
export type PreparedCsvParser = Pick<
  NativeCsvParser,
  'writeBatch' | 'endBatch' | 'writeCount' | 'endCount' | 'close' | typeof Symbol.dispose
>;

// High-level operations own a fixed configuration. Explicit per-write options on
// NativeCsvParser remain independent and continue to support reconfiguration.
/**
 * Creates a parser with projection and filter configuration prepared once.
 *
 * This helper is used by the high-level APIs; direct callers that need to
 * change projection or filters between writes should use `NativeCsvParser`
 * and its explicit per-write methods instead.
 *
 * @param options Base parser settings such as encoding, delimiter, strictness,
 * and fixed column count.
 * @param selectedColumns Optional zero-based columns to emit in each batch.
 * @param program Optional postfix sequence of filter predicates and boolean
 * operators. The parser validates and normalizes it before preparation.
 * @param projected Whether the caller is explicitly requesting a projected
 * path. This is an internal distinction used by the high-level API.
 * @returns A parser with `writeBatch`/`writeCount` operations bound to the
 * supplied configuration.
 * @throws {Error} If strict validation is requested for a projected or
 * filtered operation, or native parser setup fails.
 */
export function createPreparedParser(
  options: CsvParserOptions,
  selectedColumns?: CsvColumns,
  program?: readonly CsvNativeFilterProgramEntry[],
  projected = false,
): PreparedCsvParser {
  if (!projected && selectedColumns === undefined && program === undefined) {
    return new NativeCsvParser(options);
  }
  if (options.strict === true) {
    throw new Error('strict CSV validation is not supported for projected batches');
  }
  if (options.selectedColumns !== selectedColumns) {
    normalizeColumns(options.selectedColumns);
  }
  normalizeFixedColumnsCount(options.fixedColumns, 'fixed column count');
  return new PreparedNativeCsvParser(options, selectedColumns, program);
}

interface PreparedNativeWriter {
  writeBatch(input: NodeJS.TypedArray | DataView, final: boolean): NativePointer | null;
  writeCount(input: NodeJS.TypedArray | DataView, final: boolean): bigint | number;
}

// The fallback closures retain all normalized buffers for the parser's lifetime.
// New native libraries additionally copy the configuration into native storage.
/**
 * Prepares native projection and filter buffers for an existing parser handle.
 *
 * This low-level helper is intended for the parser implementation. The
 * returned closures retain the normalized configuration for the lifetime of
 * the handle, and the caller remains responsible for closing that handle.
 *
 * @param handle Open native parser handle.
 * @param selectedColumns Optional zero-based output columns.
 * @param program Optional postfix sequence of filter predicates and boolean
 * operators. It is validated and normalized before preparation.
 * @returns Prepared write functions for batches and counts.
 * @throws {Error} If the native library rejects the configuration.
 */
export function prepareNativeParser(
  handle: NativePointer,
  selectedColumns: CsvColumns | undefined,
  program: readonly CsvNativeFilterProgramEntry[] | undefined,
): PreparedNativeWriter {
  const columns = normalizeColumns(selectedColumns);
  const hasProjection = selectedColumns !== undefined;
  const columnCount = BigInt(selectedColumns?.length ?? 0);
  const normalized = program === undefined ? normalizeNativeFilters(undefined) : normalizeNativeFilterProgram(program);
  const filterCount = BigInt(normalized.filterCount);
  const valueCount = BigInt(normalized.valueCount);
  const prepared = optionalPreparedParserNative();
  if (prepared !== null) {
    if (
      !prepared.symbols.csv_parser_prepare(
        handle,
        hasProjection,
        columns,
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
      writeBatch: (input, final) => prepared.symbols.csv_parser_write_prepared_batch(handle, input, input, final),
      writeCount: (input, final) => {
        const count = prepared.symbols.csv_parser_write_prepared_count(handle, input, input, final);
        // The prepared ABI reserves UINT64_MAX so successful chunks need only one FFI call.
        if (count === 0xffff_ffff_ffff_ffffn) {
          throw new Error(`native CSV parser failed: ${native.symbols.csv_parser_last_error(handle) ?? 'native parser error unavailable'}`);
        }
        return count;
      },
    };
  }
  return {
    writeBatch: (input, final) =>
      native.symbols.csv_parser_write_projected_batch_where_all(
        handle,
        input,
        input,
        final,
        hasProjection,
        columns,
        columnCount,
        normalized.descriptors,
        filterCount,
        normalized.valuesData,
        normalized.valuesData,
        normalized.valueOffsets,
        valueCount,
      ),
    writeCount: (input, final) => {
      const count = native.symbols.csv_parser_write_count_where_all(
        handle,
        input,
        input,
        final,
        normalized.descriptors,
        filterCount,
        normalized.valuesData,
        normalized.valuesData,
        normalized.valueOffsets,
        valueCount,
      );
      const error = native.symbols.csv_parser_last_error(handle);
      if (error !== null && error.length > 0) {
        throw new Error(`native CSV parser failed: ${error}`);
      }
      return count;
    },
  };
}

class PreparedNativeCsvParser implements PreparedCsvParser {
  #handle: NativePointer | null;
  readonly #writer: PreparedNativeWriter;

  constructor(
    options: CsvParserOptions,
    selectedColumns: CsvColumns | undefined,
    program: readonly CsvNativeFilterProgramEntry[] | undefined,
  ) {
    const handle = createNativeCsvParser(options);
    try {
      this.#writer = prepareNativeParser(handle, selectedColumns, program);
    } catch (error) {
      destroyNativeCsvParser(handle);
      throw error;
    }
    this.#handle = handle;
    nativeCsvParserFinalizer.register(this, handle, this);
  }

  writeBatch(chunk: NodeJS.TypedArray | DataView, final = false): NativeCsvBatch {
    const handle = this.#requireHandle();
    const batch = this.#writer.writeBatch(normalizeChunk(chunk), final);
    if (batch === null) {
      throw new Error(`native CSV parser failed: ${native.symbols.csv_parser_last_error(handle) ?? 'native parser error unavailable'}`);
    }
    return new NativeCsvBatch(batch);
  }

  endBatch(): NativeCsvBatch {
    return this.writeBatch(EMPTY_BUFFER, true);
  }

  writeCount(chunk: NodeJS.TypedArray | DataView, final = false): number {
    this.#requireHandle();
    const count = this.#writer.writeCount(normalizeChunk(chunk), final);
    return u64ToSafeNumber(count, 'CSV filtered row count');
  }

  endCount(): number {
    return this.writeCount(EMPTY_BUFFER, true);
  }

  close(): void {
    const handle = this.#handle;
    if (handle === null) {
      return;
    }
    this.#handle = null;
    nativeCsvParserFinalizer.unregister(this);
    destroyNativeCsvParser(handle);
  }

  [Symbol.dispose](): void {
    this.close();
  }

  #requireHandle(): NativePointer {
    if (this.#handle === null) {
      throw new Error('native CSV parser is closed');
    }
    return this.#handle;
  }
}

function createNativeCsvParser(options: CsvParserOptions): NativePointer {
  const delimiter = options.delimiter ?? ',';
  if (delimiter === 'auto') {
    throw new Error('automatic delimiter detection is only supported by file APIs');
  }
  if (delimiter.length !== 1) {
    throw new Error('delimiter must be one character');
  }
  const handle = native.symbols.csv_parser_create(encodingCode(options.encoding), delimiter.charCodeAt(0));
  if (handle === null) {
    throw new Error('failed to create native CSV parser');
  }
  return handle;
}

/**
 * Incrementally parses caller-owned CSV chunks through the native parser.
 *
 * Use this class when the application controls buffering. A write may return a
 * `NativeCsvBatch` containing complete rows while retaining an incomplete row
 * for the next write. Every returned batch owns native memory and must be
 * closed or disposed. `write()` and `end()` are convenience methods that
 * materialize rows and close their temporary batches automatically.
 *
 * Projection and filter options passed to the explicit projected/count methods
 * apply to the current stream position. Keep them consistent while a row is
 * split across chunks; complete that row or call `reset()` before changing them.
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

  /**
   * Creates an open parser.
   *
   * @param options Base parser settings. `encoding`, `delimiter`, `strict`, and
   * `fixedColumns` are captured by this parser; the delimiter defaults to `,`.
   * Automatic delimiter detection (`"auto"`) is available through file APIs,
   * not this manual parser. `selectedColumns` is validated for compatibility
   * but does not configure `writeBatch()`; apply projection with one of the
   * explicit projected methods instead. `expectedHeaders`, `requireHeader`,
   * and `minDataRows` are schema metadata for higher-level APIs and have no
   * effect on this low-level parser.
   * @throws {Error} If the delimiter is not one character or native parser
   * creation fails.
   * @throws {RangeError} If selected or fixed column settings are out of range.
   */
  constructor(options: CsvParserOptions = {}) {
    this.#strict = options.strict === true;
    normalizeColumns(options.selectedColumns);
    this.#fixedColumns = normalizeFixedColumnsCount(options.fixedColumns, 'fixed column count');

    const handle = createNativeCsvParser(options);
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
    if (chunk.byteLength === 0 && final) {
      return this.endBatch();
    }

    const handle = this.#requireHandle();
    const input = normalizeChunk(chunk);
    const batch = this.#strict && this.#fixedColumns !== undefined
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
      ? native.symbols.csv_parser_write_fixed_batch(
        handle,
        input,
        input,
        final,
        this.#fixedColumns,
      )
      : native.symbols.csv_parser_write_batch(handle, input, input, final);
    if (batch === null) {
      throw new Error(`native CSV parser failed: ${this.#lastError()}`);
    }
    return new NativeCsvBatch(batch);
  }

  /**
   * Parses a chunk with explicit projection and optional native filters.
   *
   * Returned fields follow `selectedColumns` order. `equalsFilter` and
   * `filters` are mutually exclusive. Keep the same projection and filter
   * configuration for chunks that may belong to one logical row.
   *
   * @param chunk Input bytes.
   * @param options Projection and filter settings for this stream position.
   * @param final Whether this is the final input chunk.
   * @returns An owned projected batch; close or dispose it after use.
   * @throws {Error} If strict mode is enabled, both filter forms are supplied,
   * the parser is closed, or native parsing fails.
   * @throws {RangeError} If projection or filter values are invalid.
   */
  writeProjectedBatch(
    chunk: NodeJS.TypedArray | DataView,
    options: CsvNativeProjectionOptions = {},
    final = false,
  ): NativeCsvBatch {
    this.#rejectStrictUnsupported('projected batches');
    this.#rejectProjectionFilterConflict(options);
    if (chunk.byteLength === 0 && final) {
      return this.endProjectedBatch(options);
    }

    const handle = this.#requireHandle();
    const input = normalizeChunk(chunk);
    const columns = normalizeColumns(options.selectedColumns);
    const filter = normalizeEqualsFilter(options.equalsFilter);
    const filters = normalizeNativeFilters(options.filters);
    const batch = options.filters === undefined
      ? native.symbols.csv_parser_write_projected_batch(
        handle,
        input,
        input,
        final,
        options.selectedColumns !== undefined,
        columns,
        BigInt(options.selectedColumns?.length ?? 0),
        filter.enabled,
        filter.column,
        filter.value,
        filter.value,
      )
      : native.symbols.csv_parser_write_projected_batch_where_all(
        handle,
        input,
        input,
        final,
        options.selectedColumns !== undefined,
        columns,
        BigInt(options.selectedColumns?.length ?? 0),
        filters.descriptors,
        BigInt(filters.filterCount),
        filters.valuesData,
        filters.valuesData,
        filters.valueOffsets,
        BigInt(filters.valueCount),
      );
    if (batch === null) {
      throw new Error(`native CSV parser failed: ${this.#lastError()}`);
    }
    return new NativeCsvBatch(batch);
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
    const batch = this.#strict && this.#fixedColumns !== undefined
      ? native.symbols.csv_parser_finish_strict_fixed_batch(this.#requireHandle(), this.#fixedColumns)
      : this.#strict
      ? native.symbols.csv_parser_finish_strict_batch(this.#requireHandle())
      : this.#fixedColumns !== undefined
      ? native.symbols.csv_parser_finish_fixed_batch(this.#requireHandle(), this.#fixedColumns)
      : native.symbols.csv_parser_finish_batch(this.#requireHandle());
    if (batch === null) {
      throw new Error(`native CSV parser failed: ${this.#lastError()}`);
    }
    return new NativeCsvBatch(batch);
  }

  /**
   * Flushes buffered state using explicit projection and filter settings.
   *
   * The options must match the configuration used for chunks contributing to
   * the final logical row. `equalsFilter` and `filters` cannot be combined.
   *
   * @param options Projection and filter settings.
   * @returns An owned projected batch; close or dispose it after use.
   * @throws {Error} If strict mode is enabled, filter forms conflict, the
   * parser is closed, or the final row is invalid.
   */
  endProjectedBatch(options: CsvNativeProjectionOptions = {}): NativeCsvBatch {
    this.#rejectStrictUnsupported('projected batches');
    this.#rejectProjectionFilterConflict(options);
    const columns = normalizeColumns(options.selectedColumns);
    const filter = normalizeEqualsFilter(options.equalsFilter);
    const filters = normalizeNativeFilters(options.filters);
    const batch = options.filters === undefined
      ? native.symbols.csv_parser_finish_projected_batch(
        this.#requireHandle(),
        options.selectedColumns !== undefined,
        columns,
        BigInt(options.selectedColumns?.length ?? 0),
        filter.enabled,
        filter.column,
        filter.value,
        filter.value,
      )
      : native.symbols.csv_parser_finish_projected_batch_where_all(
        this.#requireHandle(),
        options.selectedColumns !== undefined,
        columns,
        BigInt(options.selectedColumns?.length ?? 0),
        filters.descriptors,
        BigInt(filters.filterCount),
        filters.valuesData,
        filters.valuesData,
        filters.valueOffsets,
        BigInt(filters.valueCount),
      );
    if (batch === null) {
      throw new Error(`native CSV parser failed: ${this.#lastError()}`);
    }
    return new NativeCsvBatch(batch);
  }

  /**
   * Parses a chunk with a postfix native filter program.
   *
   * This is the lower-level counterpart to `writeProjectedBatch()` for callers
   * that want to provide predicate and boolean-operator entries directly.
   *
   * @param chunk Input bytes.
   * @param selectedColumns Optional zero-based output columns.
   * @param program Filter predicates and boolean operators in postfix order.
   * The method validates and normalizes the entries before the native call.
   * @param final Whether this is the final input chunk.
   * @returns An owned projected batch; close or dispose it after use.
   * @throws {Error} If strict mode is enabled, the parser is closed, or native
   * parsing rejects the program or input.
   */
  writeProjectedBatchWhere(
    chunk: NodeJS.TypedArray | DataView,
    selectedColumns: readonly number[] | undefined,
    program: readonly CsvNativeFilterProgramEntry[],
    final = false,
  ): NativeCsvBatch {
    this.#rejectStrictUnsupported('projected batches');
    if (chunk.byteLength === 0 && final) {
      return this.endProjectedBatchWhere(selectedColumns, program);
    }

    const handle = this.#requireHandle();
    const input = normalizeChunk(chunk);
    const columns = normalizeColumns(selectedColumns);
    const normalized = normalizeNativeFilterProgram(program);
    const batch = native.symbols.csv_parser_write_projected_batch_where_all(
      handle,
      input,
      input,
      final,
      selectedColumns !== undefined,
      columns,
      BigInt(selectedColumns?.length ?? 0),
      normalized.descriptors,
      BigInt(normalized.filterCount),
      normalized.valuesData,
      normalized.valuesData,
      normalized.valueOffsets,
      BigInt(normalized.valueCount),
    );
    if (batch === null) {
      throw new Error(`native CSV parser failed: ${this.#lastError()}`);
    }
    return new NativeCsvBatch(batch);
  }

  /**
   * Flushes buffered state with a postfix native filter program.
   *
   * @param selectedColumns Optional zero-based output columns.
   * @param program Filter predicates and boolean operators in postfix order.
   * The method validates and normalizes the entries before the native call.
   * @returns An owned projected batch; close or dispose it after use.
   * @throws {Error} If strict mode is enabled, the parser is closed, or native
   * parsing rejects the program or final row.
   */
  endProjectedBatchWhere(
    selectedColumns: readonly number[] | undefined,
    program: readonly CsvNativeFilterProgramEntry[],
  ): NativeCsvBatch {
    this.#rejectStrictUnsupported('projected batches');
    const columns = normalizeColumns(selectedColumns);
    const normalized = normalizeNativeFilterProgram(program);
    const batch = native.symbols.csv_parser_finish_projected_batch_where_all(
      this.#requireHandle(),
      selectedColumns !== undefined,
      columns,
      BigInt(selectedColumns?.length ?? 0),
      normalized.descriptors,
      BigInt(normalized.filterCount),
      normalized.valuesData,
      normalized.valuesData,
      normalized.valueOffsets,
      BigInt(normalized.valueCount),
    );
    if (batch === null) {
      throw new Error(`native CSV parser failed: ${this.#lastError()}`);
    }
    return new NativeCsvBatch(batch);
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
    this.#rejectStrictUnsupported('count');
    if (chunk.byteLength === 0 && final) {
      return this.endCount();
    }

    const handle = this.#requireHandle();
    const input = normalizeChunk(chunk);
    return u64ToSafeNumber(
      native.symbols.csv_parser_write_count(handle, input, input, final),
      'CSV parsed row count',
    );
  }

  /**
   * Flushes buffered state and returns the final unfiltered row count.
   *
   * @returns The number of rows emitted while finishing the stream.
   * @throws {Error} If strict mode is enabled, the parser is closed, or native
   * parsing fails.
   */
  endCount(): number {
    this.#rejectStrictUnsupported('count');
    return u64ToSafeNumber(native.symbols.csv_parser_finish_count(this.#requireHandle()), 'CSV parsed row count');
  }

  /**
   * Counts rows matching an equality filter while parsing a chunk.
   *
   * @param chunk Input bytes.
   * @param filter Column and value to compare.
   * @param final Whether this is the final input chunk.
   * @returns Matching rows emitted by this call.
   * @throws {Error} If strict mode is enabled, the parser is closed, or native
   * parsing fails.
   * @throws {RangeError} If the filter column or value is invalid.
   */
  writeCountWhereEquals(chunk: NodeJS.TypedArray | DataView, filter: CsvEqualsFilter, final = false): number {
    this.#rejectStrictUnsupported('count filters');
    if (chunk.byteLength === 0 && final) {
      return this.endCountWhereEquals(filter);
    }

    const handle = this.#requireHandle();
    const input = normalizeChunk(chunk);
    const normalized = normalizeEqualsFilter(filter);
    return u64ToSafeNumber(
      native.symbols.csv_parser_write_count_where_equals(
        handle,
        input,
        input,
        final,
        normalized.column,
        normalized.value,
        normalized.value,
      ),
      'CSV filtered row count',
    );
  }

  /**
   * Flushes buffered state and counts rows matching an equality filter.
   *
   * @param filter Column and value to compare.
   * @returns Matching rows emitted while finishing the stream.
   * @throws {Error} If strict mode is enabled, the parser is closed, or native
   * parsing fails.
   */
  endCountWhereEquals(filter: CsvEqualsFilter): number {
    this.#rejectStrictUnsupported('count filters');
    const normalized = normalizeEqualsFilter(filter);
    return u64ToSafeNumber(
      native.symbols.csv_parser_finish_count_where_equals(
        this.#requireHandle(),
        normalized.column,
        normalized.value,
        normalized.value,
      ),
      'CSV filtered row count',
    );
  }

  /**
   * Counts rows whose field belongs to an inclusion set while parsing a chunk.
   *
   * @param chunk Input bytes.
   * @param filter Column and accepted values.
   * @param final Whether this is the final input chunk.
   * @returns Matching rows emitted by this call.
   * @throws {Error} If strict mode is enabled, the parser is closed, or native
   * parsing fails.
   */
  writeCountWhereIn(chunk: NodeJS.TypedArray | DataView, filter: CsvInFilter, final = false): number {
    this.#rejectStrictUnsupported('count filters');
    if (chunk.byteLength === 0 && final) {
      return this.endCountWhereIn(filter);
    }

    const normalized = normalizeInFilter(filter);
    const handle = this.#requireHandle();
    const input = normalizeChunk(chunk);
    return u64ToSafeNumber(
      native.symbols.csv_parser_write_count_where_in(
        handle,
        input,
        input,
        final,
        normalized.column,
        normalized.valuesData,
        normalized.valuesData,
        normalized.offsets,
        BigInt(normalized.valueCount),
      ),
      'CSV filtered row count',
    );
  }

  /**
   * Flushes buffered state and counts rows matching an inclusion set.
   *
   * @param filter Column and accepted values.
   * @returns Matching rows emitted while finishing the stream.
   * @throws {Error} If strict mode is enabled, the parser is closed, or native
   * parsing fails.
   */
  endCountWhereIn(filter: CsvInFilter): number {
    this.#rejectStrictUnsupported('count filters');
    const normalized = normalizeInFilter(filter);
    return u64ToSafeNumber(
      native.symbols.csv_parser_finish_count_where_in(
        this.#requireHandle(),
        normalized.column,
        normalized.valuesData,
        normalized.valuesData,
        normalized.offsets,
        BigInt(normalized.valueCount),
      ),
      'CSV filtered row count',
    );
  }

  /**
   * Counts rows whose field starts with a prefix while parsing a chunk.
   *
   * @param chunk Input bytes.
   * @param filter Column and prefix to compare.
   * @param final Whether this is the final input chunk.
   * @returns Matching rows emitted by this call.
   * @throws {Error} If strict mode is enabled, the parser is closed, or native
   * parsing fails.
   */
  writeCountWhereStartsWith(chunk: NodeJS.TypedArray | DataView, filter: CsvStartsWithFilter, final = false): number {
    this.#rejectStrictUnsupported('count filters');
    if (chunk.byteLength === 0 && final) {
      return this.endCountWhereStartsWith(filter);
    }

    const normalized = normalizeStartsWithFilter(filter);
    const handle = this.#requireHandle();
    const input = normalizeChunk(chunk);
    return u64ToSafeNumber(
      native.symbols.csv_parser_write_count_where_starts_with(
        handle,
        input,
        input,
        final,
        normalized.column,
        normalized.value,
        normalized.value,
      ),
      'CSV filtered row count',
    );
  }

  /**
   * Flushes buffered state and counts rows matching a prefix.
   *
   * @param filter Column and prefix to compare.
   * @returns Matching rows emitted while finishing the stream.
   * @throws {Error} If strict mode is enabled, the parser is closed, or native
   * parsing fails.
   */
  endCountWhereStartsWith(filter: CsvStartsWithFilter): number {
    this.#rejectStrictUnsupported('count filters');
    const normalized = normalizeStartsWithFilter(filter);
    return u64ToSafeNumber(
      native.symbols.csv_parser_finish_count_where_starts_with(
        this.#requireHandle(),
        normalized.column,
        normalized.value,
        normalized.value,
      ),
      'CSV filtered row count',
    );
  }

  /**
   * Counts rows satisfying all filters while parsing a chunk.
   *
   * @param chunk Input bytes.
   * @param filters Native filter predicates combined with logical AND.
   * @param final Whether this is the final input chunk.
   * @returns Matching rows emitted by this call.
   * @throws {Error} If strict mode is enabled, the parser is closed, or native
   * parsing fails.
   */
  writeCountWhereAll(
    chunk: NodeJS.TypedArray | DataView,
    filters: readonly CsvNativeFilter[],
    final = false,
  ): number {
    this.#rejectStrictUnsupported('count filters');
    if (chunk.byteLength === 0 && final) {
      return this.endCountWhereAll(filters);
    }

    const normalized = normalizeNativeFilters(filters);
    const handle = this.#requireHandle();
    const input = normalizeChunk(chunk);
    const count = native.symbols.csv_parser_write_count_where_all(
      handle,
      input,
      input,
      final,
      normalized.descriptors,
      BigInt(normalized.filterCount),
      normalized.valuesData,
      normalized.valuesData,
      normalized.valueOffsets,
      BigInt(normalized.valueCount),
    );
    this.#throwIfNativeError();
    return u64ToSafeNumber(count, 'CSV filtered row count');
  }

  /**
   * Flushes buffered state and counts rows satisfying all filters.
   *
   * @param filters Native filter predicates combined with logical AND.
   * @returns Matching rows emitted while finishing the stream.
   * @throws {Error} If strict mode is enabled, the parser is closed, or native
   * parsing fails.
   */
  endCountWhereAll(filters: readonly CsvNativeFilter[]): number {
    this.#rejectStrictUnsupported('count filters');
    const normalized = normalizeNativeFilters(filters);
    const count = native.symbols.csv_parser_finish_count_where_all(
      this.#requireHandle(),
      normalized.descriptors,
      BigInt(normalized.filterCount),
      normalized.valuesData,
      normalized.valuesData,
      normalized.valueOffsets,
      BigInt(normalized.valueCount),
    );
    this.#throwIfNativeError();
    return u64ToSafeNumber(count, 'CSV filtered row count');
  }

  /**
   * Counts rows using a postfix native filter program while parsing a chunk.
   *
   * @param chunk Input bytes.
   * @param program Filter predicates and boolean operators in postfix order.
   * The method validates and normalizes the entries before the native call.
   * @param final Whether this is the final input chunk.
   * @returns Matching rows emitted by this call.
   * @throws {Error} If strict mode is enabled, the parser is closed, or native
   * parsing rejects the program or input.
   */
  writeCountWhere(
    chunk: NodeJS.TypedArray | DataView,
    program: readonly CsvNativeFilterProgramEntry[],
    final = false,
  ): number {
    this.#rejectStrictUnsupported('count filters');
    if (chunk.byteLength === 0 && final) {
      return this.endCountWhere(program);
    }

    const normalized = normalizeNativeFilterProgram(program);
    const handle = this.#requireHandle();
    const input = normalizeChunk(chunk);
    const count = native.symbols.csv_parser_write_count_where_all(
      handle,
      input,
      input,
      final,
      normalized.descriptors,
      BigInt(normalized.filterCount),
      normalized.valuesData,
      normalized.valuesData,
      normalized.valueOffsets,
      BigInt(normalized.valueCount),
    );
    this.#throwIfNativeError();
    return u64ToSafeNumber(count, 'CSV filtered row count');
  }

  /**
   * Flushes buffered state and counts rows using a postfix filter program.
   *
   * @param program Filter predicates and boolean operators in postfix order.
   * The method validates and normalizes the entries before the native call.
   * @returns Matching rows emitted while finishing the stream.
   * @throws {Error} If strict mode is enabled, the parser is closed, or native
   * parsing rejects the program or final row.
   */
  endCountWhere(program: readonly CsvNativeFilterProgramEntry[]): number {
    this.#rejectStrictUnsupported('count filters');
    const normalized = normalizeNativeFilterProgram(program);
    const count = native.symbols.csv_parser_finish_count_where_all(
      this.#requireHandle(),
      normalized.descriptors,
      BigInt(normalized.filterCount),
      normalized.valuesData,
      normalized.valuesData,
      normalized.valueOffsets,
      BigInt(normalized.valueCount),
    );
    this.#throwIfNativeError();
    return u64ToSafeNumber(count, 'CSV filtered row count');
  }

  /**
   * Discards buffered row state and parser errors while keeping this parser open.
   *
   * Callers must supply projection or filter settings again after a reset.
   *
   * @throws {Error} If the parser is already closed.
   */
  reset(): void {
    native.symbols.csv_parser_reset(this.#requireHandle());
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

  /** Alias for {@link close}, suitable for explicit resource management. */
  dispose(): void {
    this.close();
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
    if (this.#handle === null) {
      return 'parser is closed';
    }
    return native.symbols.csv_parser_last_error(this.#handle) ?? 'native parser error unavailable';
  }

  #throwIfNativeError(): void {
    const error = this.#lastError();
    if (error.length > 0) {
      throw new Error(`native CSV parser failed: ${error}`);
    }
  }

  #rejectStrictUnsupported(operation: string): void {
    if (this.#strict) {
      throw new Error(`strict CSV validation is not supported for ${operation}`);
    }
  }

  #rejectProjectionFilterConflict(options: CsvNativeProjectionOptions): void {
    if (options.equalsFilter !== undefined && options.filters !== undefined) {
      throw new Error('use equalsFilter or filters, not both');
    }
  }
}
