import type { NativeCsvBatch } from './batches.js';
import { snapshotCsvOptions } from './options-snapshot.js';
import type {
  CsvParserOptions,
  CsvRow,
} from './types.js';

type StrictSchemaOptions = Pick<CsvParserOptions, 'strict' | 'expectedHeaders' | 'requireHeader' | 'minDataRows'>;

export class CsvStrictSchemaValidator {
  readonly #options: StrictSchemaOptions;
  #seenHeader = false;
  #dataRows = 0;

  constructor(suppliedOptions: StrictSchemaOptions) {
    const options = snapshotCsvOptions(suppliedOptions);
    this.#options = {
      expectedHeaders: options.expectedHeaders,
      minDataRows: normalizeMinDataRows(options.minDataRows),
      requireHeader: options.requireHeader,
    };
  }

  get enabled(): boolean {
    return this.#options.expectedHeaders !== undefined
      || this.#options.requireHeader === true
      || this.#options.minDataRows !== undefined;
  }

  validateRows(rows: readonly CsvRow[]): void {
    for (const row of rows) {
      this.#validateRow(row);
    }
  }

  validateBatch(batch: NativeCsvBatch): void {
    const rowCount = batch.rowCount;
    for (let rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
      this.#validateHeaderFromBatch(batch, rowIndex);
    }
  }

  finish(): void {
    if (!this.enabled) {
      return;
    }
    if (!this.#seenHeader && (this.#options.requireHeader === true || this.#options.expectedHeaders !== undefined)) {
      throw new Error('strict CSV schema error: missing header row');
    }

    const minDataRows = this.#options.minDataRows;
    if (minDataRows !== undefined && this.#dataRows < minDataRows) {
      throw new Error(`strict CSV schema error: expected at least ${String(minDataRows)} data row(s), got ${String(this.#dataRows)}`);
    }
  }

  #validateRow(row: readonly string[]): void {
    if (!this.#seenHeader) {
      this.#seenHeader = true;
      this.#validateHeader(row);
      return;
    }
    ++this.#dataRows;
  }

  #validateHeaderFromBatch(batch: NativeCsvBatch, rowIndex: number): void {
    if (!this.#seenHeader) {
      this.#seenHeader = true;
      const expectedHeaders = this.#options.expectedHeaders;
      if (expectedHeaders === undefined) {
        return;
      }
      const actualLength = batch.rowFieldCount(rowIndex);
      if (actualLength !== expectedHeaders.length) {
        throw new Error(
          `strict CSV schema error: expected ${String(expectedHeaders.length)} header field(s), got ${String(actualLength)}`,
        );
      }
      for (let column = 0; column < expectedHeaders.length; ++column) {
        const actual = batch.fieldString(rowIndex, column) ?? '';
        const expected = expectedHeaders[column] ?? '';
        if (actual !== expected) {
          throw new Error(
            `strict CSV schema error: header mismatch at column ${String(column)}: expected ${JSON.stringify(expected)}, got ${
              JSON.stringify(actual)
            }`,
          );
        }
      }
      return;
    }
    ++this.#dataRows;
  }

  #validateHeader(row: readonly string[]): void {
    const expectedHeaders = this.#options.expectedHeaders;
    if (expectedHeaders === undefined) {
      return;
    }
    if (row.length !== expectedHeaders.length) {
      throw new Error(
        `strict CSV schema error: expected ${String(expectedHeaders.length)} header field(s), got ${String(row.length)}`,
      );
    }
    for (let column = 0; column < expectedHeaders.length; ++column) {
      const actual = row[column] ?? '';
      const expected = expectedHeaders[column] ?? '';
      if (actual !== expected) {
        throw new Error(
          `strict CSV schema error: header mismatch at column ${String(column)}: expected ${JSON.stringify(expected)}, got ${
            JSON.stringify(actual)
          }`,
        );
      }
    }
  }
}

export function strictSchemaValidator(options: StrictSchemaOptions): CsvStrictSchemaValidator | undefined {
  if (options.strict !== true) {
    return undefined;
  }
  const validator = new CsvStrictSchemaValidator(options);
  return validator.enabled ? validator : undefined;
}

export function rejectStrictSchemaUnsupported(options: StrictSchemaOptions, operation: string): void {
  if (strictSchemaValidator(options) !== undefined) {
    throw new Error(`strict CSV schema validation is not supported for ${operation}`);
  }
}

function normalizeMinDataRows(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`minDataRows must be a non-negative integer: ${String(value)}`);
  }
  return value;
}
