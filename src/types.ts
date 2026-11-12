import type { NativeCsvRowView } from './batches.js';

/**
 * Text encoding used when CSV fields are decoded into JavaScript strings.
 *
 * The values are labels accepted by Bun's `TextDecoder`. `utf8` is the
 * default. The `latin1`, `iso88591`, and `iso-8859-1` spellings retain the
 * parser's native Latin-1 byte mapping.
 */
export type CsvEncoding = Bun.Encoding;

/** File readers accept explicit encoding labels or infer an encoding from the decompressed prefix. */
export type CsvFileEncoding = CsvEncoding | 'auto';

/** Encoding labels that can be passed directly to the native parser. */
export type CsvNativeEncoding =
  | 'unicode-1-1-utf-8'
  | 'unicode11utf8'
  | 'unicode20utf8'
  | 'utf-8'
  | 'utf8'
  | 'x-unicode20utf8'
  | 'latin1'
  | 'iso88591'
  | 'iso-8859-1';

/**
 * Selects one CSV entry from a ZIP archive.
 *
 * ZIP input is available to file parsing operations. The `entry` name must
 * match the archive member exactly; use `'*'` only when the archive contains
 * exactly one file entry.
 */
export interface CsvZipCompression {
  /** ZIP is the selected container format. */
  readonly format: 'zip';
  /** Archive member containing the CSV data, or `'*'` for an unambiguous single-file archive. */
  readonly entry: string;
  /**
   * Maximum allowed decompressed-to-compressed byte ratio for the selected entry.
   *
   * Must be a positive integer no greater than `4_294_967_295`. The default is
   * `1000`; lower values tighten protection against highly compressed entries.
   */
  readonly maxCompressionRatio?: number;
  /**
   * Maximum decompressed bytes accepted from the entry.
   *
   * Must be a positive safe integer. The default is 64 GiB.
   */
  readonly maxDecompressedBytes?: number;
}

/**
 * Compression accepted for file input.
 *
 * The default, `'auto'`, detects compression and reads recognized text files
 * directly. Use `'none'` to read raw bytes. A ZIP object selects one archive entry. Byte-offset sharding
 * requires an uncompressed file.
 */
export type CsvCompression = Bun.CompressionFormat | 'auto' | 'none' | CsvZipCompression;

/**
 * Field delimiter used by the CSV parser.
 *
 * Omit the option to use comma. `'auto'` is supported by file parsing
 * operations and probes the input for a stable common delimiter. Other strings
 * are accepted by TypeScript, but runtime parsing requires one character.
 */
export type CsvDelimiter =
  | 'auto'
  | ','
  | ';'
  | '\t'
  | '|'
  | ':'
  | '^'
  | '~'
  | (string & {});

/** A materialized CSV row, with one decoded string per field. */
export type CsvRow = string[];

/**
 * Zero-based physical CSV column indexes.
 *
 * Projections may contain at most 2024 unique indexes. The array is readonly
 * in the public type because each operation captures its configuration at
 * invocation time, before asynchronous iteration begins.
 */
export type CsvColumns = readonly number[];

/** A field operand accepted by native filters: text or raw field bytes. */
export type CsvFieldValue = string | Buffer | Uint8Array;

declare const csvRegexBrand: unique symbol;
declare const csvFilterBrand: unique symbol;

/**
 * Validated regular-expression metadata created by `csv.re()`.
 *
 * This branded type intentionally cannot be constructed by an object literal;
 * use the factory so the pattern and flags are checked before parsing starts.
 */
export interface CsvRegex {
  /** Pattern source after JavaScript regular-expression parsing. */
  readonly source: string;
  /** Supported flags (`i`, `m`, `s`, and `u`). */
  readonly flags: string;
  readonly [csvRegexBrand]: true;
}

/**
 * Opaque immutable predicate created by the CSV filter factories.
 *
 * Pass filters through the `where` option or combine them with `csv.all()`,
 * `csv.any()`, and `csv.not()`. Object-literal predicates are not accepted.
 */
export interface CsvFilter {
  readonly [csvFilterBrand]: true;
}

/**
 * Reusable condition builder for one zero-based physical CSV column.
 *
 * Each method returns a complete immutable `CsvFilter`; the builder itself can
 * be retained and used to create several predicates for the same column.
 */
export interface CsvFilterColumn {
  /**
   * Match fields equal to `value`. A missing field does not match.
   *
   * Binary operands are copied when the filter is created.
   *
   * @param value - Text or bytes that must equal the field.
   * @returns An immutable equality filter for this column.
   * @throws {TypeError} If `value` is not a string, `Buffer`, or `Uint8Array` at runtime.
   */
  readonly equals: (value: CsvFieldValue) => CsvFilter;
  /**
   * Match fields different from `value`. A missing field does not match.
   *
   * Binary operands are copied when the filter is created.
   *
   * @param value - Text or bytes that must differ from the field.
   * @returns An immutable inequality filter for this column.
   * @throws {TypeError} If `value` is not a string, `Buffer`, or `Uint8Array` at runtime.
   */
  readonly doesNotEqual: (value: CsvFieldValue) => CsvFilter;
  /**
   * Match fields whose value is one of `values`.
   *
   * The array and all binary operands are copied when the filter is created.
   *
   * @param values - Non-empty set of text or byte values to match.
   * @returns An immutable membership filter for this column.
   * @throws {TypeError} If `values` or one of its members has an invalid runtime type.
   * @throws {RangeError} If `values` is empty.
   */
  readonly isOneOf: (values: readonly CsvFieldValue[]) => CsvFilter;
  /**
   * Match fields whose value is none of `values`. A missing field does not match.
   *
   * The array and all binary operands are copied when the filter is created.
   *
   * @param values - Non-empty set of text or byte values to exclude.
   * @returns An immutable negative-membership filter for this column.
   * @throws {TypeError} If `values` or one of its members has an invalid runtime type.
   * @throws {RangeError} If `values` is empty.
   */
  readonly isNoneOf: (values: readonly CsvFieldValue[]) => CsvFilter;
  /**
   * Match fields beginning with `prefix`.
   *
   * Binary operands are copied when the filter is created.
   *
   * @param prefix - Text or bytes that must occur at the start of the field.
   * @returns An immutable prefix filter for this column.
   * @throws {TypeError} If `prefix` is not a string, `Buffer`, or `Uint8Array` at runtime.
   */
  readonly startsWith: (prefix: CsvFieldValue) => CsvFilter;
  /**
   * Match fields searched by the validated RE2-compatible `pattern`.
   *
   * The pattern is copied and validated immediately. Supported flags are `i`,
   * `m`, `s`, and `u`; global, indices, sticky, and `v` flags are rejected.
   * RE2 lookaround and backreferences are unsupported.
   *
   * @param pattern - JavaScript regular expression to validate and use for matching.
   * @returns An immutable regular-expression filter for this column.
   * @throws {TypeError} If `pattern` is not a `RegExp` at runtime.
   * @throws {Error} If the flags are unsupported.
   * @throws {SyntaxError} If the pattern is invalid for the native RE2 engine.
   * @throws {RangeError} If the UTF-8 pattern exceeds 4096 bytes.
   */
  readonly hasMatch: (pattern: RegExp) => CsvFilter;
}

/**
 * Half-open byte range into a batch's backing data (`[start, end)`).
 *
 * The offsets are safe JavaScript numbers validated against the backing data;
 * use them with `dataView().subarray(start, end)` when reading a batch view.
 */
export interface CsvFieldRange {
  /** Inclusive start byte offset. */
  start: number;
  /** Exclusive end byte offset. */
  end: number;
}

/**
 * Inclusive byte range containing complete records from an uncompressed CSV file.
 */
export interface CsvShard {
  /** Inclusive start byte offset in the file. */
  start: number;
  /** Inclusive end byte offset in the file. */
  end: number;
}

/**
 * Parser configuration shared by in-memory parsing and file APIs.
 *
 * Options are readonly and are captured at operation invocation time, before
 * asynchronous iteration begins. Start a new operation to apply changed arrays
 * or values.
 *
 * @typeParam TEncoding - Defaults to the native parser's labels. File and buffer
 * parsing accept the full {@link CsvEncoding} set.
 */
export interface CsvParserOptions<TEncoding extends CsvFileEncoding = CsvNativeEncoding> {
  /** Input field encoding used when decoding bytes into JavaScript strings. Defaults to `'utf8'`. */
  readonly encoding?: TEncoding;
  /** Field separator. Defaults to comma. File parsing also accepts `'auto'`. */
  readonly delimiter?: CsvDelimiter;
  /** Physical columns to emit from each row, in the requested output order. */
  readonly selectedColumns?: CsvColumns;
  /** Require exactly this many fields per row; malformed rows fail instead of being padded or truncated. */
  readonly fixedColumns?: number;
  /** Enable RFC-style quote and schema validation. Defaults to `false`. */
  readonly strict?: boolean;
  /** Expected first-row field values, checked in strict mode. */
  readonly expectedHeaders?: readonly string[];
  /** Require a first row when strict schema validation is enabled. */
  readonly requireHeader?: boolean;
  /** Minimum number of data rows after the header, checked in strict mode. */
  readonly minDataRows?: number;
}

/**
 * File input options, including parser settings and stream controls.
 *
 * Compression is streamed into the parser and does not load the complete file
 * into memory. Byte-offset sharding requires an uncompressed file.
 */
export interface CsvFileOptions extends CsvParserOptions<CsvFileEncoding> {
  /** Defaults to `'auto'`, probing up to 64 KiB after decompression, independently of the delimiter. */
  readonly encoding?: CsvFileEncoding;
  /** Read-stream chunk size in bytes. Defaults to 1 MiB. */
  readonly chunkSize?: number;
  /** Compression format or ZIP entry selection. Defaults to `'auto'`; `'none'` skips detection. */
  readonly compression?: CsvCompression;
}

/**
 * File options accepted by byte-offset sharding helpers.
 *
 * Compression is excluded because compressed byte streams cannot be split into
 * independently readable file ranges.
 */
export type CsvShardingOptions = Omit<CsvFileOptions, 'compression' | 'encoding'> & {
  /** Compression is unsupported for byte-offset sharding. */
  readonly compression?: never;
  /** Sharding scans raw file bytes and supports native encodings only. */
  readonly encoding?: CsvNativeEncoding;
};

/** Native equality predicate used by projection and count fast paths. */
export interface CsvEqualsFilter {
  /** Zero-based physical column to inspect. */
  readonly column: number;
  /** Field bytes or text that must equal the input field. */
  readonly value: CsvFieldValue;
}

/** Native membership predicate used by projection and count fast paths. */
export interface CsvInFilter {
  /** Zero-based physical column to inspect. */
  readonly column: number;
  /** Values for which the input field matches. */
  readonly values: readonly CsvFieldValue[];
}

/** Native inequality predicate used by projection and count fast paths. */
export interface CsvNotEqualsFilter {
  /** Zero-based physical column to inspect. */
  readonly column: number;
  /** Field bytes or text that must differ from the input field. */
  readonly notEquals: CsvFieldValue;
}

/** Native negative-membership predicate used by projection and count fast paths. */
export interface CsvNotInFilter {
  /** Zero-based physical column to inspect. */
  readonly column: number;
  /** Values that the input field must not match. */
  readonly notIn: readonly CsvFieldValue[];
}

/** Native prefix predicate used by projection and count fast paths. */
export interface CsvStartsWithFilter {
  /** Zero-based physical column to inspect. */
  readonly column: number;
  /** Field bytes or text that must occur at the start of the input field. */
  readonly prefix: CsvFieldValue;
}

/** Native regular-expression predicate used by projection and count fast paths. */
export interface CsvRegexFilter {
  /** Zero-based physical column to inspect. */
  readonly column: number;
  /** Validated pattern created by `csv.re()`. */
  readonly regex: CsvRegex;
}

/**
 * Native predicate shape accepted by low-level projection options.
 *
 * High-level row and count APIs normally use the opaque `CsvFilter` returned by
 * the filter factories instead. High-level options copy operands at invocation
 * time; low-level parser calls normalize their operands for each write.
 */
export type CsvNativeFilter =
  | CsvEqualsFilter
  | CsvInFilter
  | CsvNotInFilter
  | CsvNotEqualsFilter
  | CsvRegexFilter
  | CsvStartsWithFilter;

/**
 * Native projection and predicate configuration used by low-level parser APIs.
 *
 * `equalsFilter` and `filters` are mutually exclusive. When `filters` contains
 * several entries, the native path combines them with an AND operation.
 */
export interface CsvNativeProjectionOptions {
  /** Physical columns to emit, in output order. */
  readonly selectedColumns?: CsvColumns;
  /** One equality predicate for the direct native fast path. */
  readonly equalsFilter?: CsvEqualsFilter;
  /** Native predicates combined for the operation. */
  readonly filters?: readonly CsvNativeFilter[];
}

/**
 * Common file options for the high-level `csv` API.
 *
 * Use `columns` for the preferred projection spelling. `selectedColumns` is a
 * legacy alias; supplying both is rejected.
 */
export interface CsvApiFileOptions extends CsvFileOptions {
  /** Preferred physical-column projection for materialized row APIs. */
  readonly columns?: CsvColumns;
  /** Opaque filter created by `csv.column()`, `csv.all()`, `csv.any()`, or `csv.not()`. */
  readonly where?: CsvFilter;
}

/**
 * Type-safe mutually exclusive projection fields.
 *
 * The generic preserves a literal tuple such as `readonly [0, 2]`, allowing
 * materialized rows and row views to retain their projected positions in the
 * resulting TypeScript type.
 */
export type CsvColumnSelection<TColumns extends CsvColumns | undefined> =
  | {
    /** Preferred projection spelling; indexes are emitted in this order. */
    readonly columns?: TColumns;
    /** Deliberately excluded when `columns` is supplied. */
    readonly selectedColumns?: never;
  }
  | {
    /** Deliberately excluded when the legacy alias is supplied. */
    readonly columns?: never;
    /** Legacy projection spelling; indexes are emitted in this order. */
    readonly selectedColumns?: TColumns;
  };

/** Apply `Omit` to each member of a union independently. */
type CsvDistributiveOmit<T, TKeys extends PropertyKey> = T extends unknown ? Omit<T, TKeys> : never;

/** A projection can use either column spelling. Strict validation requires unfiltered input. */
type CsvOperationOptions<TColumns extends CsvColumns | undefined> =
  & Omit<CsvApiFileOptions, 'columns' | 'selectedColumns' | 'strict' | 'where'>
  & CsvColumnSelection<TColumns>
  & (
    | { readonly strict?: false | undefined; readonly where?: CsvFilter | undefined; }
    | { readonly strict: true; readonly where?: undefined; }
  );

/** Options for parsing an in-memory buffer into materialized rows. */
export type CsvParseOptions<TColumns extends CsvColumns | undefined = undefined> =
  & CsvDistributiveOmit<
    CsvOperationOptions<TColumns>,
    'compression' | 'encoding'
  >
  & { readonly encoding?: CsvEncoding; };

/** Options for streaming materialized rows in file order. */
export type CsvRowsOptions<TColumns extends CsvColumns | undefined = undefined> = CsvOperationOptions<TColumns> & {
  /** Refill the batch and its row arrays across iterations. Copy any row you want to keep. Defaults to false. */
  readonly reuseArrays?: boolean;
};

/** Alias for the options accepted by `csv.rows()`. */
export type CsvSingleThreadRowsOptions<TColumns extends CsvColumns | undefined = undefined> = CsvRowsOptions<TColumns>;

/** Options accepted by `csv.batches()` and `csv.withBatches()`. */
export type CsvBatchesOptions = CsvOperationOptions<CsvColumns | undefined>;

/** Options accepted by reusable row-view callbacks. */
export type CsvRowViewsOptions<TColumns extends CsvColumns | undefined = undefined> = CsvOperationOptions<TColumns>;

/** Projected columnar batches expose raw bytes and require non-strict parsing. */
export type CsvColumnarBatchOptions<TColumns extends CsvColumns | undefined = undefined> = [TColumns] extends [undefined]
  ? CsvOperationOptions<TColumns>
  : CsvOperationOptions<TColumns> & { readonly strict?: false | undefined; };

/** Options accepted by `csv.count()`. */
export type CsvCountOptions = CsvOperationOptions<CsvColumns | undefined>;

/**
 * Materialized row type inferred from a literal projection tuple.
 *
 * For example, `CsvProjectedRow<readonly [0, 2]>` is a two-element mutable
 * string tuple. Without a projection tuple the result is the variable-length
 * `CsvRow` shape.
 */
export type CsvProjectedRow<TColumns extends CsvColumns | undefined> = TColumns extends readonly unknown[]
  ? { -readonly [Index in keyof TColumns]: string; }
  : CsvRow;

/**
 * Reusable, low-allocation view of one materialized row.
 *
 * The view is valid only during the synchronous callback that receives it. Its
 * accessors address the fields stored in the current batch: unfiltered rows
 * use physical CSV indexes, while a filtered operation with a projection uses
 * projected output positions. `selectedColumns` maps those output positions
 * back to physical indexes. Missing fields return `null` from scalar accessors
 * and become empty strings in `pick()` and `pickPhysical()`.
 *
 * @typeParam TSelectedColumns - Literal selected-column indexes, when supplied.
 */
export type CsvRowView<TSelectedColumns extends CsvColumns | undefined = undefined> =
  & Pick<
    NativeCsvRowView,
    | 'rowIndex'
    | 'fieldCount'
    | 'fieldRange'
    | 'range'
    | 'fieldBytes'
    | 'bytes'
    | 'fieldBuffer'
    | 'buffer'
    | 'fieldString'
    | 'getPhysical'
    | 'get'
    | 'pickPhysical'
    | 'pick'
  >
  & {
    /** Selected output columns requested for the stream, when present. */
    readonly selectedColumns: TSelectedColumns;
  };

/**
 * Synchronous callback invoked for each reusable row view.
 *
 * Copy values that must outlive the callback; the view is rebound for the next
 * row and released when the callback returns.
 *
 * @typeParam TSelectedColumns - Literal selected-column indexes, when supplied.
 * @param row - Reusable view positioned at `rowIndex`.
 * @param rowIndex - Zero-based row index within the current batch.
 */
export type CsvRowViewCallback<TSelectedColumns extends CsvColumns | undefined = undefined> = (
  row: CsvRowView<TSelectedColumns>,
  rowIndex: number,
) => void;

/**
 * Synchronous callback invoked by `NativeCsvBatch.forEachRow()`.
 *
 * The same native row-view object is moved to each row in sequence; copy any
 * values needed after the callback returns.
 *
 * @param row - Reusable view positioned at `rowIndex`.
 * @param rowIndex - Zero-based row index within the batch.
 */
export type NativeCsvRowCallback = (row: NativeCsvRowView, rowIndex: number) => void;

/**
 * Receives the byte range for one field in a columnar batch.
 *
 * `start` is inclusive and `end` is exclusive; both offsets address the batch's
 * `data()` buffer. Rows that do not contain the requested column are skipped.
 */
export type CsvColumnRangeCallback = (rowIndex: number, start: number, end: number) => void;

/**
 * Receives raw bytes for one field in a columnar batch.
 *
 * The `Uint8Array` may alias the batch backing storage and should be copied if
 * it must outlive the callback or batch.
 */
export type CsvColumnBytesCallback = (rowIndex: number, bytes: Uint8Array) => void;

/**
 * Receives ranges for several columns in one row without allocating per-field
 * objects.
 *
 * `ranges` contains `[start, end]` pairs in the same order as `columns`, with
 * `[-1, -1]` for a missing field. The range values address `data`; the typed
 * array and buffer are reused for each row.
 */
export type CsvScanColumnsCallback = (rowIndex: number, ranges: Float64Array, data: Buffer) => void;

/**
 * Reusable raw-data view over one columnar batch.
 *
 * This view is valid only during the synchronous callback that receives it and
 * is rebound for the next batch. Its arrays and byte views alias native batch
 * storage, so copy data that must outlive the callback.
 *
 * @typeParam TSelectedColumns - Literal selected-column indexes, when supplied.
 */
export interface CsvColumnarBatchView<TSelectedColumns extends CsvColumns | undefined = undefined> {
  /** Number of rows represented by the batch. */
  readonly rowCount: number;
  /** Total number of fields across all rows in the batch. */
  readonly totalFields: number;
  /** Number of bytes in the backing field-data buffer. */
  readonly dataLength: number;
  /**
   * Selected output columns requested for this batch, mapping output positions
   * to physical CSV indexes.
   *
   * Column indexes passed to this view's methods address stored batch fields;
   * when this property is defined, those indexes are projected output
   * positions.
   */
  readonly selectedColumns: TSelectedColumns;
  /** Return the batch's field bytes as a `Buffer` view. */
  data(): Buffer;
  /** Return the batch's field bytes as a `Uint8Array` view. */
  dataView(): Uint8Array;
  /** Return `rowCount + 1` cumulative field indexes for row boundaries. */
  rowOffsets(): BigUint64Array;
  /** Return `totalFields + 1` cumulative byte offsets for field boundaries. */
  fieldOffsets(): BigUint64Array;
  /** Return the number of fields in one row. */
  rowFieldCount(rowIndex: number): number;
  /** Return a field's half-open byte range, or `null` when the column is missing. */
  fieldRange(rowIndex: number, columnIndex: number): CsvFieldRange | null;
  /** Return a field's raw bytes, or `null` when the column is missing. */
  fieldBytes(rowIndex: number, columnIndex: number): Uint8Array | null;
  /** Return a field's `Buffer` view, or `null` when the column is missing. */
  fieldBuffer(rowIndex: number, columnIndex: number): Buffer | null;
  /** Visit byte ranges for one column in the half-open row interval `[startRow, endRow)`. */
  forEachColumnRange(columnIndex: number, callback: CsvColumnRangeCallback, startRow?: number, endRow?: number): void;
  /** Visit raw bytes for one column in the half-open row interval `[startRow, endRow)`. */
  forEachColumnBytes(columnIndex: number, callback: CsvColumnBytesCallback, startRow?: number, endRow?: number): void;
  /** Visit several column ranges per row; missing fields are reported as `[-1, -1]`. */
  scanColumns(columns: CsvColumns, callback: CsvScanColumnsCallback, startRow?: number, endRow?: number): void;
}

/**
 * Synchronous callback invoked for each reusable columnar batch view.
 *
 * @typeParam TSelectedColumns - Literal selected-column indexes, when supplied.
 * @param batch - Reusable raw-data view for the current batch.
 * @param batchIndex - Zero-based batch index for the operation.
 */
export type CsvColumnarBatchCallback<TSelectedColumns extends CsvColumns | undefined = undefined> = (
  batch: CsvColumnarBatchView<TSelectedColumns>,
  batchIndex: number,
) => void;
