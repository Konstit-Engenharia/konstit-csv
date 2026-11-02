import type { NativeCsvRowView } from './batches.js';

export type CsvEncoding = 'utf8' | 'latin1' | 'iso88591' | 'iso-8859-1';
export interface CsvZipCompression {
  readonly format: 'zip';
  readonly entry: string;
  readonly maxCompressionRatio?: number;
  readonly maxDecompressedBytes?: number;
}
export type CsvCompression = Bun.CompressionFormat | 'auto' | CsvZipCompression;
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
export type CsvRow = string[];
export type CsvColumns = readonly number[];
export type CsvFieldValue = string | Buffer | Uint8Array;

declare const csvRegexBrand: unique symbol;
declare const csvFilterBrand: unique symbol;

export interface CsvRegex {
  readonly source: string;
  readonly flags: string;
  readonly [csvRegexBrand]: true;
}

export interface CsvFilter {
  readonly [csvFilterBrand]: true;
}

export interface CsvFilterColumn {
  readonly equals: (value: CsvFieldValue) => CsvFilter;
  readonly doesNotEqual: (value: CsvFieldValue) => CsvFilter;
  readonly isOneOf: (values: readonly CsvFieldValue[]) => CsvFilter;
  readonly isNoneOf: (values: readonly CsvFieldValue[]) => CsvFilter;
  readonly startsWith: (prefix: CsvFieldValue) => CsvFilter;
  readonly hasMatch: (pattern: RegExp) => CsvFilter;
}

export interface CsvFieldRange {
  start: number;
  end: number;
}

export interface CsvShard {
  start: number;
  end: number;
}

export interface CsvParserOptions {
  readonly encoding?: CsvEncoding;
  readonly delimiter?: CsvDelimiter;
  readonly selectedColumns?: CsvColumns;
  readonly fixedColumns?: number;
  readonly strict?: boolean;
  readonly expectedHeaders?: readonly string[];
  readonly requireHeader?: boolean;
  readonly minDataRows?: number;
}

export interface CsvFileOptions extends CsvParserOptions {
  readonly chunkSize?: number;
  readonly compression?: CsvCompression;
}

export type CsvShardingOptions = Omit<CsvFileOptions, 'compression'> & {
  readonly compression?: never;
};

export interface CsvEqualsFilter {
  readonly column: number;
  readonly value: CsvFieldValue;
}

export interface CsvInFilter {
  readonly column: number;
  readonly values: readonly CsvFieldValue[];
}

export interface CsvNotEqualsFilter {
  readonly column: number;
  readonly notEquals: CsvFieldValue;
}

export interface CsvNotInFilter {
  readonly column: number;
  readonly notIn: readonly CsvFieldValue[];
}

export interface CsvStartsWithFilter {
  readonly column: number;
  readonly prefix: CsvFieldValue;
}

export interface CsvRegexFilter {
  readonly column: number;
  readonly regex: CsvRegex;
}

export type CsvNativeFilter =
  | CsvEqualsFilter
  | CsvInFilter
  | CsvNotInFilter
  | CsvNotEqualsFilter
  | CsvRegexFilter
  | CsvStartsWithFilter;

export interface CsvNativeProjectionOptions {
  readonly selectedColumns?: CsvColumns;
  readonly equalsFilter?: CsvEqualsFilter;
  readonly filters?: readonly CsvNativeFilter[];
}

export interface CsvApiFileOptions extends CsvFileOptions {
  readonly columns?: CsvColumns;
  readonly workerCount?: number;
  readonly where?: CsvFilter;
}

export type CsvColumnSelection<TColumns extends CsvColumns | undefined> =
  | {
    readonly columns?: TColumns;
    readonly selectedColumns?: never;
  }
  | {
    readonly columns?: never;
    readonly selectedColumns?: TColumns;
  };

type CsvApiOptionsWithoutSelection = Omit<CsvApiFileOptions, 'columns' | 'selectedColumns'>;
type CsvDistributiveOmit<T, TKeys extends PropertyKey> = T extends unknown ? Omit<T, TKeys> : never;

type CsvOptionsWithoutWhereWorkerCount<TColumns extends CsvColumns | undefined> =
  & Omit<
    CsvApiOptionsWithoutSelection,
    'where' | 'workerCount'
  >
  & CsvColumnSelection<TColumns>;

export type CsvSingleThreadRowsOptions<TColumns extends CsvColumns | undefined = undefined> =
  | (CsvDistributiveOmit<CsvOptionsWithoutWhereWorkerCount<TColumns>, 'strict'> & {
    readonly strict?: false | undefined;
    readonly where?: CsvFilter | undefined;
    readonly workerCount?: 1 | undefined;
  })
  | (CsvDistributiveOmit<CsvOptionsWithoutWhereWorkerCount<TColumns>, 'strict'> & {
    readonly strict: true;
    readonly where?: undefined;
    readonly workerCount?: 1 | undefined;
  });

export type CsvParallelRowsOptions<TColumns extends CsvColumns | undefined = undefined> =
  & Omit<
    CsvApiOptionsWithoutSelection,
    'compression' | 'where' | 'workerCount' | 'strict'
  >
  & CsvColumnSelection<TColumns>
  & {
    readonly compression?: never;
    readonly where?: CsvFilter | undefined;
    readonly workerCount: number;
    readonly strict?: false | undefined;
  };

export type CsvParseOptions<TColumns extends CsvColumns | undefined = undefined> = CsvDistributiveOmit<
  CsvSingleThreadRowsOptions<TColumns>,
  'compression'
>;

export type CsvRowsOptions<TColumns extends CsvColumns | undefined = undefined> =
  | CsvSingleThreadRowsOptions<TColumns>
  | CsvParallelRowsOptions<TColumns>;

export type CsvBatchesOptions = CsvSingleThreadRowsOptions<CsvColumns | undefined>;

export type CsvRowViewsOptions<TColumns extends CsvColumns | undefined = undefined> = CsvSingleThreadRowsOptions<TColumns>;

export type CsvColumnarBatchOptions<TColumns extends CsvColumns | undefined = undefined> = [TColumns] extends [undefined]
  ? CsvSingleThreadRowsOptions<TColumns>
  : CsvDistributiveOmit<CsvSingleThreadRowsOptions<TColumns>, 'strict'> & { readonly strict?: false | undefined; };

type CsvCountSingleThreadOptions =
  | (Omit<CsvApiOptionsWithoutSelection, 'where' | 'workerCount' | 'strict'> & CsvColumnSelection<CsvColumns | undefined> & {
    readonly strict?: false | undefined;
    readonly where?: CsvFilter | undefined;
    readonly workerCount?: 1 | undefined;
  })
  | (Omit<CsvApiOptionsWithoutSelection, 'where' | 'workerCount' | 'strict'> & CsvColumnSelection<CsvColumns | undefined> & {
    readonly strict: true;
    readonly where?: undefined;
    readonly workerCount?: 1 | undefined;
  });

export type CsvParallelCountOptions =
  & Omit<CsvApiOptionsWithoutSelection, 'compression' | 'where' | 'workerCount' | 'strict'>
  & CsvColumnSelection<CsvColumns | undefined>
  & {
    readonly compression?: never;
    readonly where?: CsvFilter | undefined;
    readonly workerCount: number;
    readonly strict?: false | undefined;
  };

export type CsvCountOptions =
  | CsvCountSingleThreadOptions
  | CsvParallelCountOptions;

export type CsvWorkerPoolOptions<TColumns extends CsvColumns | undefined = undefined> = CsvParallelRowsOptions<TColumns>;

export type CsvProjectedRow<TColumns extends CsvColumns | undefined> = TColumns extends readonly unknown[]
  ? { -readonly [Index in keyof TColumns]: string; }
  : CsvRow;

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
    /**
     * Selected output columns requested for the stream, when present.
     *
     * `CsvRowView` still reads physical CSV column indexes through `get()`, `fieldString()`,
     * `bytes()`, `range()`, and `pick()`. This metadata is useful when you need to map projected
     * output positions back to source column indexes.
     */
    readonly selectedColumns: TSelectedColumns;
  };

export type CsvRowViewCallback<TSelectedColumns extends CsvColumns | undefined = undefined> = (
  row: CsvRowView<TSelectedColumns>,
  rowIndex: number,
) => void;
export type NativeCsvRowCallback = (row: NativeCsvRowView, rowIndex: number) => void;
export type CsvColumnRangeCallback = (rowIndex: number, start: number, end: number) => void;
export type CsvColumnBytesCallback = (rowIndex: number, bytes: Uint8Array) => void;
export type CsvScanColumnsCallback = (rowIndex: number, ranges: Float64Array, data: Buffer) => void;

export interface CsvColumnarBatchView<TSelectedColumns extends CsvColumns | undefined = undefined> {
  readonly rowCount: number;
  readonly totalFields: number;
  readonly dataLength: number;
  /**
   * Selected output columns requested for this batch. Unlike `CsvRowView`, column indexes on the
   * batch are relative to the projected output when `selectedColumns` is defined.
   */
  readonly selectedColumns: TSelectedColumns;
  data(): Buffer;
  dataView(): Uint8Array;
  rowOffsets(): BigUint64Array;
  fieldOffsets(): BigUint64Array;
  rowFieldCount(rowIndex: number): number;
  fieldRange(rowIndex: number, columnIndex: number): CsvFieldRange | null;
  fieldBytes(rowIndex: number, columnIndex: number): Uint8Array | null;
  fieldBuffer(rowIndex: number, columnIndex: number): Buffer | null;
  forEachColumnRange(columnIndex: number, callback: CsvColumnRangeCallback, startRow?: number, endRow?: number): void;
  forEachColumnBytes(columnIndex: number, callback: CsvColumnBytesCallback, startRow?: number, endRow?: number): void;
  scanColumns(columns: CsvColumns, callback: CsvScanColumnsCallback, startRow?: number, endRow?: number): void;
}

export type CsvColumnarBatchCallback<TSelectedColumns extends CsvColumns | undefined = undefined> = (
  batch: CsvColumnarBatchView<TSelectedColumns>,
  batchIndex: number,
) => void;
