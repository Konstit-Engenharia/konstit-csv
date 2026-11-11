import {
  csv,
  type CsvColumnarBatchOptions,
  type CsvCountOptions,
  type CsvDelimiter,
  type CsvRowsOptions,
  type CsvRowViewsOptions,
  type CsvSingleThreadRowsOptions,
  defineRowsOptions,
} from '../src/index.ts';

const path = 'corpus/large/example.csv';
const columns = [0, 2] as const;
const commonDelimiter: CsvDelimiter = ';';
const arbitraryDelimiter: CsvDelimiter = '@';
void commonDelimiter;
void arbitraryDelimiter;

// @ts-expect-error delimiters must be strings
const invalidDelimiter: CsvDelimiter = 1;
void invalidDelimiter;

const projectedRowsOptions = {
  chunkSize: 64 * 1024,
  columns,
  delimiter: ';',
  where: csv.column(2).equals('SP'),
} satisfies CsvRowsOptions<typeof columns>;

const projectedTopLevelRows: AsyncGenerator<[string, string][], void> = csv.rows(path, projectedRowsOptions);
void projectedTopLevelRows;

const selectedColumnsOptions = defineRowsOptions({
  reuseArrays: true,
  selectedColumns: [0, 2] as const,
});
const selectedColumnsRows: AsyncGenerator<[string, string][], void> = csv.rows(path, selectedColumnsOptions);
void selectedColumnsRows;

const strictSchema = {
  strict: true,
  requireHeader: true,
  minDataRows: 1,
} as const;

const strictRowsOptions = {
  chunkSize: 64 * 1024,
  delimiter: ';',
  reuseArrays: true,
  ...strictSchema,
} satisfies CsvSingleThreadRowsOptions;

const strictCountOptions = {
  chunkSize: 64 * 1024,
  delimiter: ';',
  ...strictSchema,
} satisfies CsvCountOptions;

const startsWithCountOptions = {
  chunkSize: 64 * 1024,
  delimiter: ';',
  where: csv.column(1).startsWith('A'),
} satisfies CsvCountOptions;

const regexCountOptions = {
  chunkSize: 64 * 1024,
  delimiter: ';',
  where: csv.column(1).hasMatch(/^A/u),
} satisfies CsvCountOptions;

const multipleFilterRowsOptions = {
  columns,
  delimiter: ';',
  where: csv.all(csv.column(1).startsWith('A'), csv.column(2).isOneOf(['SP', 'RJ'])),
} satisfies CsvRowsOptions<typeof columns>;

void csv.rows(path, strictRowsOptions);
void csv.count(path, strictCountOptions);
void csv.count(path, startsWithCountOptions);
void csv.count(path, regexCountOptions);
void csv.rows(path, multipleFilterRowsOptions);

// @ts-expect-error parser options do not support string caching
void csv.rows(path, { stringCache: { columns: [0] } });

const rowViewOptions = {
  columns,
  delimiter: ';',
} satisfies CsvRowViewsOptions<typeof columns>;

const columnarBatchOptions = {
  columns,
  delimiter: ';',
} satisfies CsvColumnarBatchOptions<typeof columns>;

void csv.withRowViews(path, rowViewOptions, (row) => {
  const selectedColumns: readonly [0, 2] = row.selectedColumns;
  void selectedColumns;
});

void csv.withColumnarBatches(path, columnarBatchOptions, (batch) => {
  const selectedColumns: readonly [0, 2] = batch.selectedColumns;
  const rowOffsets: BigUint64Array = batch.rowOffsets();
  const fieldOffsets: BigUint64Array = batch.fieldOffsets();
  void selectedColumns;
  void rowOffsets;
  void fieldOffsets;
});

// @ts-expect-error strict count supports no filters
const invalidStrictCountWhere = { strict: true, where: csv.column(1).isOneOf(['SP']) } satisfies CsvCountOptions;
void invalidStrictCountWhere;

// @ts-expect-error strict count supports no filters
const invalidStrictCountEquals = { strict: true, where: csv.column(1).equals('SP') } satisfies CsvCountOptions;
void invalidStrictCountEquals;

// @ts-expect-error strict rows support no filters
const invalidStrictRowsWhere = { strict: true, where: csv.column(1).equals('SP') } satisfies CsvRowsOptions;
void invalidStrictRowsWhere;

// @ts-expect-error columns and selectedColumns are mutually exclusive
const invalidColumnAliases = { columns, selectedColumns: columns } satisfies CsvRowsOptions<typeof columns>;
void invalidColumnAliases;

// @ts-expect-error option factories preserve strict/filter constraints
defineRowsOptions({ strict: true, where: csv.column(1).equals('SP') });

// @ts-expect-error strict columnar batches do not support projected columns
const invalidStrictColumnarOptions = { columns, strict: true } satisfies CsvColumnarBatchOptions<typeof columns>;
void invalidStrictColumnarOptions;

// @ts-expect-error strict columnar batches do not support filters
const invalidStrictFilteredColumnar = { strict: true, where: csv.column(1).equals('SP') } satisfies CsvColumnarBatchOptions;
void invalidStrictFilteredColumnar;
