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
 * match the archive member exactly. `'*'` selects the only file after ignoring
 * directories and OS metadata. This includes files in `__MACOSX/` or
 * `.AppleDouble/` directories, `._*` files, and the case-insensitive filenames
 * `.DS_Store`, `Thumbs.db`, `ehthumbs.db`, `ehthumbs_vista.db`, and `desktop.ini`.
 */
export interface CsvZipCompression {
  /** ZIP is the selected container format. */
  readonly format: 'zip';
  /** Exact archive member name, or `'*'` for the only file after ignoring directories and OS metadata. */
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
 * The default, `'auto'`, detects compression, reads recognized text files
 * directly, and selects the only ZIP data file after ignoring directories and
 * OS metadata. ZIP input requires a regular file. Use `'none'` to read raw bytes.
 * A ZIP object selects an exact entry or custom ZIP limits. Byte-offset sharding
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
declare const csvTransformBrand: unique symbol;

/** Field operations use Unicode 15.1 data and run in declaration order. */
export interface CsvTransformMethods<TResult = CsvTransform> {
  /** Remove Unicode White_Space from both ends. */
  readonly trim: () => TResult;
  /** Apply full, locale-independent Unicode uppercase mapping. */
  readonly upper: () => TResult;
  /** Apply full, locale-independent Unicode lowercase mapping. */
  readonly lower: () => TResult;
  /** Canonically decompose, remove marks with the Diacritic property, and recompose. */
  readonly unaccent: () => TResult;
  /** Replace every non-overlapping match. Strings are literal. RegExp searches use RE2 rewrite syntax. */
  readonly replace: (search: string | RegExp, replacement: string) => TResult;
  /** Replace an exact field value once. Unknown keys emit defaultValue when supplied, or the input value otherwise. */
  readonly map: (values: ReadonlyMap<string, string> | Readonly<Record<string, string>>, defaultValue?: string) => TResult;
  /** Format a calendar date. Invalid input emits defaultValue, which defaults to an empty string. */
  readonly date: (format: 'YYYY-MM-DD' | 'DD-MM-YYYY' | 'DD/MM/YYYY', defaultValue?: string) => TResult;
}

/** A reusable sequence of field operations built with csv.transform(). */
export interface CsvTransformChain extends CsvTransformMethods<CsvTransformChain> {
  /** Apply these steps to the given zero-based physical input columns. */
  readonly on: (first: number, ...rest: readonly number[]) => CsvTransform;
}

/** An immutable chain bound to the columns that receive its output. */
export interface CsvTransform extends CsvTransformMethods {
  readonly [csvTransformBrand]: true;
  /** Reuse these steps on a new set of physical columns. */
  readonly on: CsvTransformChain['on'];
}

/** A physical input column can start a filter or a transform. */
export interface CsvColumn extends CsvFilterColumn, CsvTransformMethods {}

export interface CsvTransformOptions {
  /** Apply one chain per physical column to present, selected fields after filtering. */
  readonly transform?: readonly CsvTransform[] | undefined;
}

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

interface CsvRowSelectionOptions {
  /** Number of initial input records to skip, including any header, before filtering. Defaults to zero. */
  readonly skipRows?: number;
  /** Maximum number of matching rows to emit or count across the entire input. Defaults to unlimited. */
  readonly limit?: number;
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
export interface CsvParserOptions<TEncoding extends CsvFileEncoding = CsvNativeEncoding> extends CsvRowSelectionOptions {
  /** Input field encoding used when decoding bytes into JavaScript strings. Defaults to `'utf8'`. */
  readonly encoding?: TEncoding;
  /** Field separator. Defaults to comma. File parsing also accepts `'auto'`. */
  readonly delimiter?: CsvDelimiter;
  /** Physical columns to emit from each row, in the requested output order. */
  readonly columns?: CsvColumns;
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
export type CsvShardingOptions = Omit<CsvFileOptions, 'compression' | 'encoding' | keyof CsvRowSelectionOptions> & {
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
 * time. The manual parser captures its operands at construction.
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
  readonly columns?: CsvColumns;
  /** One equality predicate on a physical column. */
  readonly equalsFilter?: CsvEqualsFilter;
  /** Native predicates combined for the operation. */
  readonly filters?: readonly CsvNativeFilter[];
}

/**
 * Boolean operation in a postfix filter program accepted by `NativeCsvParser`.
 *
 * Predicates push results onto a stack. An operator consumes the most recent
 * results and pushes one combined result. Missing columns produce an unknown
 * result, which remains unknown under `not` and does not select a row by itself.
 */
export interface CsvNativeFilterOperator {
  /** Number of preceding stack results to consume; positive, and exactly one for `not`. */
  readonly operandCount: number;
  /** Combine operands with AND, OR, or unary negation. */
  readonly operator: 'all' | 'any' | 'not';
}

/**
 * Predicate or boolean operator in a low-level postfix filter program.
 *
 * Place predicates before the operators that consume them. A complete program
 * must leave exactly one result on the stack and contain at most 4096 entries.
 * Most applications can use `csv.column()` and its boolean combinators instead.
 */
export type CsvNativeFilterProgramEntry = CsvNativeFilter | CsvNativeFilterOperator;

/** Projection and filter settings captured when a manual parser is constructed. */
export interface NativeCsvParserOptions extends CsvParserOptions, CsvNativeProjectionOptions, CsvTransformOptions {
  /** Postfix Boolean program. Supply only one of `filterProgram`, `filters`, or `equalsFilter`. */
  readonly filterProgram?: readonly CsvNativeFilterProgramEntry[];
}

/** Common file options for the high-level `csv` API. */
export interface CsvApiFileOptions extends CsvFileOptions {
  /** Opaque filter created by `csv.column()`, `csv.all()`, `csv.any()`, or `csv.not()`. */
  readonly where?: CsvFilter;
}

/** Retains the literal input indexes and their order for projected row types. */
export interface CsvColumnSelection<TColumns extends CsvColumns | undefined> {
  /** Physical columns to emit from each row, in the requested output order. */
  readonly columns?: TColumns;
}

/** Shared operation properties have declarations that editors can use for hover documentation. */
interface CsvOperationOptions<TColumns extends CsvColumns | undefined> extends CsvColumnSelection<TColumns>, CsvRowSelectionOptions {
  /** Field separator. Defaults to comma. File parsing also accepts `'auto'`. */
  readonly delimiter?: CsvDelimiter;
  /** Require exactly this many fields per row; malformed rows fail instead of being padded or truncated. */
  readonly fixedColumns?: number;
  /** Expected first-row field values, checked in strict mode. */
  readonly expectedHeaders?: readonly string[];
  /** Require a first row when strict schema validation is enabled. */
  readonly requireHeader?: boolean;
  /** Minimum number of data rows after the header, checked in strict mode. */
  readonly minDataRows?: number;
  /** Read-stream chunk size in bytes. Defaults to 1 MiB. Used by file operations only. */
  readonly chunkSize?: number;
}

/** File operations support encoding detection and streamed decompression. */
interface CsvFileOperationOptions<TColumns extends CsvColumns | undefined> extends CsvOperationOptions<TColumns> {
  /** Defaults to `'auto'`, probing up to 64 KiB after decompression, independently of the delimiter. */
  readonly encoding?: CsvFileEncoding;
  /** Compression format or ZIP entry selection. Defaults to `'auto'`; `'none'` skips detection. */
  readonly compression?: CsvCompression;
}

/** Non-strict operations can filter input records. */
interface CsvFilteredOperationOptions {
  /** Enable RFC-style quote and schema validation. Defaults to `false`. Requires unfiltered input. */
  readonly strict?: false | undefined;
  /** Filter records with `csv.column()`, `csv.all()`, `csv.any()`, or `csv.not()`. Requires `strict` to be false or omitted. */
  readonly where?: CsvFilter | undefined;
}

/** Strict validation requires unfiltered input. */
interface CsvStrictOperationOptions {
  /** Enable RFC-style quote and schema validation. Requires unfiltered input. */
  readonly strict: true;
  /** Filtering is unavailable with strict validation, which checks every input record. */
  readonly where?: undefined;
}

/** Each branch keeps its documented properties and enforces the strict/filter constraint. */
type CsvValidationOptions = CsvFilteredOperationOptions | CsvStrictOperationOptions;

/** Options for parsing an in-memory buffer into materialized rows. */
export type CsvParseOptions<TColumns extends CsvColumns | undefined = undefined> =
  & CsvOperationOptions<TColumns>
  & CsvTransformOptions
  & CsvValidationOptions
  & {
    /** Input field encoding used when decoding bytes into JavaScript strings. Defaults to `'utf8'`. */
    readonly encoding?: CsvEncoding;
  };

/** Options for streaming materialized rows in file order. */
export type CsvRowsOptions<TColumns extends CsvColumns | undefined = undefined> =
  & CsvFileOperationOptions<TColumns>
  & CsvTransformOptions
  & CsvValidationOptions
  & {
    /** Refill the batch and its row arrays across iterations. Copy any row you want to keep. Defaults to false. */
    readonly reuseArrays?: boolean;
  };

/** Strict native batches require unfiltered, unprojected input. */
export type CsvBatchesOptions =
  & CsvTransformOptions
  & (
    | (CsvFileOperationOptions<CsvColumns | undefined> & CsvFilteredOperationOptions)
    | (CsvFileOperationOptions<undefined> & CsvStrictOperationOptions)
  );

/** Options accepted by `csv.count()`. */
export type CsvCountOptions = CsvFileOperationOptions<CsvColumns | undefined> & CsvValidationOptions;

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
