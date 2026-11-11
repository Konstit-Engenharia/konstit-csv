import type {
  CsvColumnarBatchOptions,
  CsvColumns,
  CsvCountOptions,
  CsvRowsOptions,
  CsvRowViewsOptions,
} from './types.js';

/**
 * Preserve literal column inference for `csv.rows()` options.
 *
 * This identity helper is useful when options are declared separately from the call site. It
 * checks projection and strict validation options while retaining tuple literals for projected row
 * types. Each operation snapshots caller-owned option values when invoked.
 *
 * @typeParam TColumns - Literal selected column indexes, when supplied.
 * @typeParam TOptions - The complete rows option object to preserve.
 * @param options - Type-checked rows options.
 * @returns The same options object, with its literal type preserved.
 *
 * @example
 * ```ts
 * const options = defineRowsOptions({ columns: [0, 2] as const });
 * for await (const rows of csv.rows('data.csv', options)) {
 *   const firstField = rows[0]?.[0];
 * }
 * ```
 */
export function defineRowsOptions<
  const TColumns extends CsvColumns | undefined,
  const TOptions extends CsvRowsOptions<TColumns>,
>(options: TOptions): TOptions {
  return options;
}

/**
 * Preserve literal inference for `csv.count()` options.
 *
 * The helper checks that strict counts use unfiltered input and returns the original object.
 *
 * @typeParam TOptions - The complete count option object to preserve.
 * @param options - Type-checked count options.
 * @returns The same options object, with its literal type preserved.
 */
export function defineCountOptions<const TOptions extends CsvCountOptions>(options: TOptions): TOptions {
  return options;
}

/**
 * Preserve literal column inference for `csv.withColumnarBatches()` options.
 *
 * This identity helper retains projected column tuples for columnar batch callbacks and checks
 * the callback API's option restrictions, including its non-strict projected mode.
 *
 * @typeParam TColumns - Literal selected column indexes, when supplied.
 * @typeParam TOptions - The complete columnar batch option object to preserve.
 * @param options - Type-checked columnar batch options.
 * @returns The same options object, with its literal type preserved.
 */
export function defineColumnarOptions<
  const TColumns extends CsvColumns | undefined,
  const TOptions extends CsvColumnarBatchOptions<TColumns>,
>(options: TOptions): TOptions {
  return options;
}

/**
 * Preserve literal column inference for `csv.withRowViews()` options.
 *
 * The helper checks the row-view options and keeps a selected-column tuple visible to
 * the callback's `CsvRowView` type. It is an identity function at runtime.
 *
 * @typeParam TColumns - Literal selected column indexes, when supplied.
 * @typeParam TOptions - The complete row-view option object to preserve.
 * @param options - Type-checked row-view options.
 * @returns The same options object, with its literal type preserved.
 */
export function defineRowViewOptions<
  const TColumns extends CsvColumns | undefined,
  const TOptions extends CsvRowViewsOptions<TColumns>,
>(options: TOptions): TOptions {
  return options;
}
