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

export type PreparedCsvParser = Pick<
  NativeCsvParser,
  'writeBatch' | 'endBatch' | 'writeCount' | 'endCount' | 'close' | typeof Symbol.dispose
>;

// High-level operations own a fixed configuration. Explicit per-write options on
// NativeCsvParser remain independent and continue to support reconfiguration.
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

export class NativeCsvParser {
  #handle: NativePointer | null;
  readonly #strict: boolean;
  readonly #fixedColumns: number | undefined;

  constructor(options: CsvParserOptions = {}) {
    this.#strict = options.strict === true;
    normalizeColumns(options.selectedColumns);
    this.#fixedColumns = normalizeFixedColumnsCount(options.fixedColumns, 'fixed column count');

    const handle = createNativeCsvParser(options);
    this.#handle = handle;
    nativeCsvParserFinalizer.register(this, handle, this);
  }

  get closed(): boolean {
    return this.#handle === null;
  }

  write(chunk: NodeJS.TypedArray | DataView, final = false): CsvRow[] {
    const batch = this.writeBatch(chunk, final);
    try {
      return batch.rows();
    } finally {
      batch.close();
    }
  }

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

  end(): CsvRow[] {
    const batch = this.endBatch();
    try {
      return batch.rows();
    } finally {
      batch.close();
    }
  }

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

  endCount(): number {
    this.#rejectStrictUnsupported('count');
    return u64ToSafeNumber(native.symbols.csv_parser_finish_count(this.#requireHandle()), 'CSV parsed row count');
  }

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

  reset(): void {
    native.symbols.csv_parser_reset(this.#requireHandle());
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

  dispose(): void {
    this.close();
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
