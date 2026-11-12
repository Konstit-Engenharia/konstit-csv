import { parseArgs } from 'node:util';
import { csv } from './api.js';
import { formatBytes } from './format-bytes.js';
import { inspectCsvFile } from './inspect-file.js';
import {
  normalizeColumns,
  normalizeFilterColumn,
  normalizeFixedColumnsCount,
  resolveInputEncoding,
} from './normalize.js';
import type {
  CsvApiFileOptions,
  CsvColumns,
  CsvCompression,
  CsvCountOptions,
  CsvDelimiter,
  CsvEncoding,
  CsvFileEncoding,
  CsvFilter,
  CsvRowsOptions,
} from './types.js';

const help = `Usage: csv <command>

Commands:
  count <path> [options]  Count CSV records
  lines <path> [options]  Stream matching CSV records to stdout
  probe <path> [options]  Inspect the file size and CSV format

Options:
  -h, --help              Show this help

Run 'csv <command> --help' for command options.

Run without installing:
  bunx @konstit/csv <command> <path>`;

const countHelp = `Usage: csv count <path> [options]

Count every CSV record, including the header row.
ZIP input automatically selects the only data file, ignoring OS metadata.

File options:
  --delimiter <value>              One safe ASCII character or auto (default: auto)
  --encoding <value>               A Bun.Encoding label or auto (default: auto)
  --chunk-size <bytes>             Integer from 1 through 67108864 (default: 1048576)
  --compression <format>           auto, none, gzip, deflate, deflate-raw, brotli, zstd, or zip (default: auto)
  --zip-entry <path>               Entry used with --compression zip
  --max-compression-ratio <ratio>  ZIP expansion ratio integer from 1 through 4294967295
  --max-decompressed-bytes <bytes> Positive ZIP output byte limit

Parser options:
  --strict                         Enable strict RFC 4180 validation
  --fixed-columns <count>          Require this positive field count in strict mode
  --columns <indexes>              Validate indexes; does not change the count
  --expected-header <value>        Expected header; repeat per column; requires --strict
  --require-header                 Require a header row; requires --strict
  --min-data-rows <count>          Require a non-negative data row count; requires --strict

Friendly filter options (repeatable):
  --where-eq <column=value>        Match one exact value
  --where-in <column=value>        Add a value to a column IN filter
  --where-neq <column=value>       Exclude one exact value
  --where-noin <column=value>      Add a value to a column NOT IN filter
  --where-prefix <column=value>    Match a value prefix
  --where-regex <column=/re/flags> Match an RE2-compatible JavaScript regex

Advanced filter option:
  --where <json>                   Advanced filter JSON

Friendly filter clauses use AND. Repeated --where-in and --where-noin clauses for
the same column form one filter. Advanced JSON can nest all, any, and not.
Quote values that contain spaces or shell characters. Regex flags can be i, m, s, and u.

Compatibility:
  Strict mode cannot use filter options.
  --fixed-columns and schema options require --strict.
  ZIP options require --compression zip and --zip-entry.

Examples:
  csv count data.csv --delimiter ';' --chunk-size 262144
  csv count data.csv --where-eq 2=SP
  csv count data.csv --where-neq 2=SP
  csv count data.csv --where-in 2=SP --where-in 2=RJ --where-prefix 1=A
  csv count data.csv --where-regex '1=/^ana/i'`;

const linesHelp = `Usage: csv lines <path> [options]

Parse a CSV file and stream matching records as normalized UTF-8 CSV or NDJSON.
CSV output uses comma delimiters and LF record endings by default.
ZIP input automatically selects the only data file, ignoring OS metadata.

File options:
  --delimiter <value>              Input delimiter: one safe ASCII character or auto (default: auto)
  --encoding <value>               A Bun.Encoding label or auto (default: auto)
  --chunk-size <bytes>             Integer from 1 through 67108864 (default: 1048576)
  --compression <format>           auto, none, gzip, deflate, deflate-raw, brotli, zstd, or zip (default: auto)
  --zip-entry <path>               Entry used with --compression zip
  --max-compression-ratio <ratio>  ZIP expansion ratio integer from 1 through 4294967295
  --max-decompressed-bytes <bytes> Positive ZIP output byte limit

Output options:
  --json                           Emit one JSON string array per record (NDJSON)
  --output-delimiter <value>       One safe ASCII output delimiter (default: ,)
  --limit <N>                      Stop after matching output record N, numbered from 1

Parser options:
  --strict                         Enable strict RFC 4180 validation
  --fixed-columns <count>          Require this positive field count in strict mode
  --columns <indexes>              Select zero-based input columns and output order
  --expected-header <value>        Expected header; repeat per column; requires --strict
  --require-header                 Require a header row; requires --strict
  --min-data-rows <count>          Require a non-negative data row count; requires --strict

Friendly filter options (repeatable):
  --where-eq <column=value>        Match one exact value
  --where-in <column=value>        Add a value to a column IN filter
  --where-neq <column=value>       Exclude one exact value
  --where-noin <column=value>      Add a value to a column NOT IN filter
  --where-prefix <column=value>    Match a value prefix
  --where-regex <column=/re/flags> Match an RE2-compatible JavaScript regex

Advanced filter option:
  --where <json>                   Advanced filter JSON

Filters use original input column indexes. Friendly filter clauses use AND.
Repeated --where-in and --where-noin clauses for the same column form one filter.
Advanced JSON can nest all, any, and not. Quote values that contain spaces or
shell characters. Regex flags can be i, m, s, and u.

CSV output is normalized and can differ from the input quoting, delimiter, and
record endings. With --json, stdout contains only NDJSON string arrays. A quoted
field can contain physical newlines. With --strict and --limit, validation stops
at the selected record and uses one-byte input chunks. Partial output can exist
if a later input error occurs.

Compatibility:
  Strict mode cannot use filter options.
  --fixed-columns and schema options require --strict.
  --json cannot be combined with --output-delimiter.
  --limit cannot be combined with --min-data-rows.
  --strict with --limit defaults to comma and UTF-8 and uses --chunk-size 1; auto is unavailable.
  --strict with --limit uses --compression none; compression detection is unavailable.
  ZIP options require --compression zip and --zip-entry.

Examples:
  csv lines data.csv
  csv lines data.csv --json --limit 10
  csv lines input.tsv --delimiter $'\\t' --output-delimiter ','
  csv lines data.csv --columns 0,2 --where-eq 3=active --limit 10
  csv lines data.csv.gz --compression auto > selected.csv`;

const countOptionDefinitions = {
  'columns': { type: 'string' },
  'compression': { type: 'string' },
  'delimiter': { type: 'string' },
  'encoding': { type: 'string' },
  'chunk-size': { type: 'string' },
  'expected-header': { multiple: true, type: 'string' },
  'fixed-columns': { type: 'string' },
  'help': { short: 'h', type: 'boolean' },
  'max-compression-ratio': { type: 'string' },
  'max-decompressed-bytes': { type: 'string' },
  'min-data-rows': { type: 'string' },
  'require-header': { type: 'boolean' },
  'strict': { type: 'boolean' },
  'where': { type: 'string' },
  'where-eq': { multiple: true, type: 'string' },
  'where-in': { multiple: true, type: 'string' },
  'where-neq': { multiple: true, type: 'string' },
  'where-noin': { multiple: true, type: 'string' },
  'where-prefix': { multiple: true, type: 'string' },
  'where-regex': { multiple: true, type: 'string' },
  'zip-entry': { type: 'string' },
} as const;

const linesOptionDefinitions = {
  ...countOptionDefinitions,
  'json': { type: 'boolean' },
  'limit': { type: 'string' },
  'output-delimiter': { type: 'string' },
} as const;

const compressionFormats = new Set(['auto', 'none', 'gzip', 'deflate', 'deflate-raw', 'brotli', 'zstd']);
const probeHelp = `Usage: csv probe <path> [--zip-entry <path>]

Print the on-disk file size and compression, plus the encoding, delimiter,
record endings and first record's column count from up to 64 KiB of CSV.
For a ZIP archive with multiple files, select one with --zip-entry.
Automatic ZIP selection ignores directories and common OS metadata.
Use -h or --help to show this help.`;
const MAX_CHUNK_SIZE = 64 * 1024 * 1024;
const MAX_FILTER_NESTING = 128;
const OUTPUT_BUFFER_SIZE = 64 * 1024;

interface CliOutput {
  log(message: string | number): void;
  error(message: string): void;
  write(chunk: string): Promise<number>;
}

export async function runCli(arguments_: readonly string[], output: CliOutput): Promise<number> {
  const command = arguments_[0];
  if (command === '-h' || command === '--help') {
    output.log(help);
    return 0;
  }
  if (command === undefined) {
    return usageError(output, 'missing command');
  }
  if (command === 'count') {
    return runCount(arguments_.slice(1), output);
  }
  if (command === 'lines') {
    return runLines(arguments_.slice(1), output);
  }
  if (command === 'probe') {
    return runProbe(arguments_.slice(1), output);
  }
  return usageError(output, `unknown command: ${command}`);
}

async function runProbe(arguments_: readonly string[], output: CliOutput): Promise<number> {
  let path: string;
  let entry: string | undefined;
  try {
    const { values, positionals } = parseArgs({
      args: [...arguments_],
      allowPositionals: true,
      strict: true,
      options: { 'help': countOptionDefinitions.help, 'zip-entry': countOptionDefinitions['zip-entry'] },
    });
    if (values.help === true) {
      output.log(probeHelp);
      return 0;
    }
    if (positionals.length !== 1 || positionals[0] === undefined) {
      throw new Error('probe requires one file path');
    }
    path = positionals[0];
    entry = values['zip-entry'];
  } catch (error) {
    return usageError(output, error instanceof Error ? error.message : String(error), 'csv probe --help');
  }
  try {
    const result = await inspectCsvFile(path, entry);
    output.log([
      `File size: ${formatBytes(result.size)}`,
      `Encoding: ${result.encoding}`,
      `Delimiter: ${result.delimiter === undefined ? 'undetermined' : JSON.stringify(result.delimiter)}`,
      `Line endings: ${result.lineEnding}`,
      `Compression: ${result.compression}`,
      `First record columns: ${String(result.firstRecordColumns ?? 'unknown')}`,
    ].join('\n'));
    return 0;
  } catch (error) {
    output.error(`csv: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function runCount(arguments_: readonly string[], output: CliOutput): Promise<number> {
  let input: CountInput;
  try {
    input = parseCountInput(arguments_);
  } catch (error) {
    return usageError(output, error instanceof Error ? error.message : String(error), 'csv count --help');
  }
  if (input.help) {
    output.log(countHelp);
    return 0;
  }

  try {
    output.log(await csv.count(input.path, input.options));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.error(`csv: ${message}`);
    return 1;
  }
}

async function runLines(arguments_: readonly string[], output: CliOutput): Promise<number> {
  let input: LinesInput;
  try {
    input = parseLinesInput(arguments_);
  } catch (error) {
    return usageError(output, error instanceof Error ? error.message : String(error), 'csv lines --help');
  }
  if (input.help) {
    output.log(linesHelp);
    return 0;
  }

  try {
    await streamLines(input, output);
    return 0;
  } catch (error) {
    if (isBrokenPipe(error)) {
      return 0;
    }
    const message = error instanceof Error ? error.message : String(error);
    output.error(`csv: ${message}`);
    return 1;
  }
}

interface CountInput {
  help: boolean;
  options: CsvCountOptions;
  path: string;
}

interface LinesInput {
  help: boolean;
  json: boolean;
  limit?: number;
  options: CsvRowsOptions<CsvColumns | undefined>;
  outputDelimiter: string;
  path: string;
}

interface CommonOptionValues {
  readonly 'chunk-size'?: string;
  readonly 'columns'?: string;
  readonly 'compression'?: string;
  readonly 'delimiter'?: string;
  readonly 'encoding'?: string;
  readonly 'expected-header'?: readonly string[];
  readonly 'fixed-columns'?: string;
  readonly 'help'?: boolean;
  readonly 'max-compression-ratio'?: string;
  readonly 'max-decompressed-bytes'?: string;
  readonly 'min-data-rows'?: string;
  readonly 'require-header'?: boolean;
  readonly 'strict'?: boolean;
  readonly 'where'?: string;
  readonly 'where-eq'?: readonly string[];
  readonly 'where-in'?: readonly string[];
  readonly 'where-neq'?: readonly string[];
  readonly 'where-noin'?: readonly string[];
  readonly 'where-prefix'?: readonly string[];
  readonly 'where-regex'?: readonly string[];
  readonly 'zip-entry'?: string;
}

function parseCountInput(arguments_: readonly string[]): CountInput {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args: [...arguments_],
    options: countOptionDefinitions,
    strict: true,
  });
  if (values.help === true) {
    return { help: true, options: {}, path: '' };
  }
  if (positionals.length !== 1) {
    throw new Error('count requires one file path');
  }

  const options = parseCommonOptions(values);

  return { help: false, options, path: positionals[0] ?? '' };
}

function parseLinesInput(arguments_: readonly string[]): LinesInput {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args: [...arguments_],
    options: linesOptionDefinitions,
    strict: true,
  });
  if (values.help === true) {
    return { help: true, json: false, options: {}, outputDelimiter: ',', path: '' };
  }
  if (positionals.length !== 1) {
    throw new Error('lines requires one file path');
  }

  const limit = values.limit === undefined ? undefined : parseInteger(values.limit, 'limit', 1);
  const options = parseCommonOptions(values, values.strict === true && limit !== undefined);
  if (limit !== undefined && options.minDataRows !== undefined) {
    throw new Error('--limit cannot be combined with --min-data-rows');
  }
  if (limit !== undefined && options.strict === true) {
    if (options.compression !== 'none') {
      throw new Error('--strict with --limit does not support compressed input');
    }
    if (options.delimiter === 'auto') {
      throw new Error('--strict with --limit requires a fixed input delimiter');
    }
    if (options.encoding === 'auto') {
      throw new Error('--strict with --limit requires a fixed input encoding');
    }
    if (options.chunkSize !== undefined && options.chunkSize !== 1) {
      throw new Error('--strict with --limit requires --chunk-size 1');
    }
    options.chunkSize = 1;
  }
  const json = values.json === true;
  if (json && values['output-delimiter'] !== undefined) {
    throw new Error('--json cannot be combined with --output-delimiter');
  }
  const outputDelimiter = values['output-delimiter'] === undefined
    ? ','
    : parseOutputDelimiter(values['output-delimiter']);

  return {
    help: false,
    json,
    ...(limit === undefined ? {} : { limit }),
    options,
    outputDelimiter,
    path: positionals[0] ?? '',
  };
}

type MutableCliOptions<TOptions = CsvApiFileOptions> = { -readonly [Key in keyof TOptions]: TOptions[Key]; };

function parseCommonOptions(values: CommonOptionValues, fixedFormat = false): MutableCliOptions<CsvCountOptions> {
  const options: MutableCliOptions = {
    delimiter: parseDelimiter(values.delimiter ?? (fixedFormat ? ',' : 'auto')),
    encoding: parseEncoding(values.encoding ?? (fixedFormat ? 'utf8' : 'auto')),
  };
  if (values['chunk-size'] !== undefined) {
    options.chunkSize = parseInteger(values['chunk-size'], 'chunk size', 1, MAX_CHUNK_SIZE);
  }
  if (values.strict === true) {
    options.strict = true;
  }
  if (values['fixed-columns'] !== undefined) {
    options.fixedColumns = parseInteger(values['fixed-columns'], 'fixed columns', 1);
    normalizeFixedColumnsCount(options.fixedColumns, 'fixed column count');
  }
  if (values.columns !== undefined) {
    options.columns = parseColumns(values.columns, 'columns');
  }
  if (values['expected-header'] !== undefined) {
    options.expectedHeaders = values['expected-header'];
  }
  if (values['require-header'] === true) {
    options.requireHeader = true;
  }
  if (values['min-data-rows'] !== undefined) {
    options.minDataRows = parseInteger(values['min-data-rows'], 'minimum data rows', 0);
  }
  options.where = parseWhereOptions(values);

  options.compression = parseCompression(values) ?? (fixedFormat ? 'none' : 'auto');
  validateCountOptionCombinations(options);
  return options;
}

function parseDelimiter(value: string): CsvDelimiter {
  if (value === 'auto') {
    return value;
  }
  if (
    value.length !== 1
    || value.charCodeAt(0) > 0x7f
    || value === '"'
    || value === '\r'
    || value === '\n'
  ) {
    throw new Error(`delimiter must be one safe ASCII character or auto: ${JSON.stringify(value)}`);
  }
  return value;
}

function parseOutputDelimiter(value: string): string {
  const delimiter = parseDelimiter(value);
  if (delimiter === 'auto') {
    throw new Error('output delimiter must be one safe ASCII character; auto is not supported');
  }
  return delimiter;
}

function parseEncoding(value: string): CsvFileEncoding {
  if (value === 'auto') {
    return value;
  }
  const resolved = resolveInputEncoding(value);
  return typeof resolved === 'string' ? resolved : resolved.encoding as CsvEncoding;
}

function parseInteger(value: string, label: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    const range = maximum === Number.MAX_SAFE_INTEGER
      ? `greater than or equal to ${String(minimum)}`
      : `from ${String(minimum)} through ${String(maximum)}`;
    throw new Error(`${label} must be an integer ${range}: ${value}`);
  }
  return number;
}

function parseColumns(value: string, label: string): number[] {
  const columns = value.length === 0 ? [] : value.split(',').map((column) => parseInteger(column, label, 0));
  normalizeColumns(columns);
  return columns;
}

function parseCompression(values: CommonOptionValues): CsvCompression | undefined {
  const compression = values['compression'];
  const zipEntry = values['zip-entry'];
  const maxCompressionRatio = values['max-compression-ratio'];
  const maxDecompressedBytes = values['max-decompressed-bytes'];
  if (typeof compression !== 'string') {
    if (zipEntry !== undefined || maxCompressionRatio !== undefined || maxDecompressedBytes !== undefined) {
      throw new Error('ZIP options require --compression zip');
    }
    return undefined;
  }
  if (compression !== 'zip') {
    if (!compressionFormats.has(compression)) {
      throw new Error(`unsupported compression format: ${compression}`);
    }
    if (zipEntry !== undefined || maxCompressionRatio !== undefined || maxDecompressedBytes !== undefined) {
      throw new Error('ZIP options require --compression zip');
    }
    return compression as Bun.CompressionFormat | 'auto' | 'none';
  }
  if (typeof zipEntry !== 'string' || zipEntry.length === 0) {
    throw new Error('--compression zip requires --zip-entry <path>');
  }

  return {
    entry: zipEntry,
    format: 'zip',
    ...(typeof maxCompressionRatio === 'string'
      ? { maxCompressionRatio: parseUint32(maxCompressionRatio, 'maximum compression ratio') }
      : {}),
    ...(typeof maxDecompressedBytes === 'string'
      ? { maxDecompressedBytes: parseInteger(maxDecompressedBytes, 'maximum decompressed bytes', 1) }
      : {}),
  };
}

function validateCountOptionCombinations(options: CsvApiFileOptions): asserts options is CsvCountOptions {
  const hasStrictSchemaOptions = options.expectedHeaders !== undefined
    || options.requireHeader === true
    || options.minDataRows !== undefined;
  if (hasStrictSchemaOptions && options.strict !== true) {
    throw new Error('--expected-header, --require-header, and --min-data-rows require --strict');
  }
  if (options.fixedColumns !== undefined && options.strict !== true) {
    throw new Error('--fixed-columns requires --strict');
  }
  if (options.strict === true && options.where !== undefined) {
    throw new Error('--strict cannot be combined with filter options');
  }
}

async function streamLines(input: LinesInput, output: CliOutput): Promise<void> {
  let chunks: string[] = [];
  let chunksLength = 0;
  let emitted = 0;

  batches: for await (const rows of csv.rows(input.path, input.options)) {
    for (const row of rows) {
      const record = input.json ? `${JSON.stringify(row)}\n` : serializeCsvRecord(row, input.outputDelimiter);
      chunks.push(record);
      chunksLength += record.length;
      ++emitted;

      if (chunksLength >= OUTPUT_BUFFER_SIZE) {
        await output.write(chunks.join(''));
        chunks = [];
        chunksLength = 0;
      }
      if (emitted === input.limit) {
        break batches;
      }
    }

    if (chunksLength > 0) {
      await output.write(chunks.join(''));
      chunks = [];
      chunksLength = 0;
    }
  }

  if (chunksLength > 0) {
    await output.write(chunks.join(''));
  }
}

function serializeCsvRecord(row: readonly string[], delimiter: string): string {
  return `${row.map((field) => serializeCsvField(field, delimiter)).join(delimiter)}\n`;
}

function serializeCsvField(field: string, delimiter: string): string {
  if (!field.includes(delimiter) && !field.includes('"') && !field.includes('\r') && !field.includes('\n')) {
    return field;
  }
  return `"${field.replaceAll('"', '""')}"`;
}

function isBrokenPipe(error: unknown): boolean {
  return isObject(error) && error['code'] === 'EPIPE';
}

function parseUint32(value: string, label: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0 || number > 0xffff_ffff) {
    throw new Error(`${label} must be an integer from 1 through 4294967295: ${value}`);
  }
  return number;
}

function parseWhereOptions(values: {
  readonly 'where'?: string;
  readonly 'where-eq'?: readonly string[];
  readonly 'where-in'?: readonly string[];
  readonly 'where-neq'?: readonly string[];
  readonly 'where-noin'?: readonly string[];
  readonly 'where-prefix'?: readonly string[];
  readonly 'where-regex'?: readonly string[];
}): CsvFilter | undefined {
  const filters: CsvFilter[] = [];
  if (values.where !== undefined) {
    filters.push(parseWhereJson(values.where));
  }

  for (const expression of values['where-eq'] ?? []) {
    const { column, value } = parseColumnValue(expression, '--where-eq');
    filters.push(csv.column(column).equals(value));
  }

  for (const expression of values['where-neq'] ?? []) {
    const { column, value } = parseColumnValue(expression, '--where-neq');
    filters.push(csv.column(column).doesNotEqual(value));
  }

  const inValuesByColumn = new Map<number, string[]>();
  for (const expression of values['where-in'] ?? []) {
    const { column, value } = parseColumnValue(expression, '--where-in');
    const columnValues = inValuesByColumn.get(column);
    if (columnValues === undefined) {
      inValuesByColumn.set(column, [value]);
    } else {
      columnValues.push(value);
    }
  }
  for (const [column, inValues,] of inValuesByColumn) {
    filters.push(csv.column(column).isOneOf(inValues));
  }

  const notInValuesByColumn = new Map<number, string[]>();
  for (const expression of values['where-noin'] ?? []) {
    const { column, value } = parseColumnValue(expression, '--where-noin');
    const columnValues = notInValuesByColumn.get(column);
    if (columnValues === undefined) {
      notInValuesByColumn.set(column, [value]);
    } else {
      columnValues.push(value);
    }
  }
  for (const [column, notInValues,] of notInValuesByColumn) {
    filters.push(csv.column(column).isNoneOf(notInValues));
  }

  for (const expression of values['where-prefix'] ?? []) {
    const { column, value } = parseColumnValue(expression, '--where-prefix');
    filters.push(csv.column(column).startsWith(value));
  }
  for (const expression of values['where-regex'] ?? []) {
    filters.push(parseRegexExpression(expression));
  }

  const first = filters[0];
  if (first === undefined) {
    return undefined;
  }
  return filters.length === 1 ? first : csv.all(first, ...filters.slice(1));
}

function parseColumnValue(expression: string, option: string): { column: number; value: string; } {
  const separator = expression.indexOf('=');
  if (separator <= 0) {
    throw new Error(`${option} must use <column>=<value>: ${JSON.stringify(expression)}`);
  }
  const column = parseInteger(expression.slice(0, separator), `${option} column`, 0);
  normalizeFilterColumn(column);
  return { column, value: expression.slice(separator + 1) };
}

function parseRegexExpression(expression: string): CsvFilter {
  const { column, value } = parseColumnValue(expression, '--where-regex');
  const closingSlash = value.lastIndexOf('/');
  if (!value.startsWith('/') || closingSlash === 0) {
    throw new Error(`--where-regex must use <column>=/<pattern>/<flags>: ${JSON.stringify(expression)}`);
  }
  const source = value.slice(1, closingSlash);
  const flags = value.slice(closingSlash + 1);
  return csv.column(column).hasMatch(new RegExp(source, flags));
}

function parseWhereJson(value: string): CsvFilter {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`--where must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseWhereFilter(parsed, '--where');
}

function parseWhereFilter(value: unknown, label: string, depth = 0): CsvFilter {
  if (depth > MAX_FILTER_NESTING) {
    throw new Error(`--where nesting exceeds ${MAX_FILTER_NESTING}`);
  }
  if (!isObject(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  if ('all' in value) {
    requireExactKeys(value, ['all'], label);
    return parseWhereGroup(value['all'], `${label}.all`, csv.all, depth);
  }
  if ('any' in value) {
    requireExactKeys(value, ['any'], label);
    return parseWhereGroup(value['any'], `${label}.any`, csv.any, depth);
  }
  if ('not' in value) {
    requireExactKeys(value, ['not'], label);
    return csv.not(parseWhereFilter(value['not'], `${label}.not`, depth + 1));
  }
  return parseWherePredicate(value, label);
}

function parseWhereGroup(
  value: unknown,
  label: string,
  combine: (first: CsvFilter, ...rest: readonly CsvFilter[]) => CsvFilter,
  depth: number,
): CsvFilter {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  const first = parseWhereFilter(value[0], `${label}[0]`, depth + 1);
  const rest = value.slice(1).map((filter, index) => parseWhereFilter(filter, `${label}[${String(index + 1)}]`, depth + 1));
  return combine(first, ...rest);
}

function parseWherePredicate(value: Record<string, unknown>, label: string): CsvFilter {
  const column = value['column'];
  if (typeof column !== 'number') {
    throw new Error(`${label}.column must be a number`);
  }
  normalizeFilterColumn(column);

  if ('equals' in value) {
    requireExactKeys(value, ['column', 'equals'], label);
    return csv.column(column).equals(requireString(value['equals'], `${label}.equals`));
  }
  if ('in' in value) {
    requireExactKeys(value, ['column', 'in'], label);
    if (!Array.isArray(value['in']) || value['in'].length === 0) {
      throw new Error(`${label}.in must be a non-empty string array`);
    }
    return csv.column(column).isOneOf(
      value['in'].map((item, index) => requireString(item, `${label}.in[${String(index)}]`)),
    );
  }
  if ('notEquals' in value) {
    requireExactKeys(value, ['column', 'notEquals'], label);
    return csv.column(column).doesNotEqual(requireString(value['notEquals'], `${label}.notEquals`));
  }
  if ('notIn' in value) {
    requireExactKeys(value, ['column', 'notIn'], label);
    if (!Array.isArray(value['notIn']) || value['notIn'].length === 0) {
      throw new Error(`${label}.notIn must be a non-empty string array`);
    }
    return csv.column(column).isNoneOf(
      value['notIn'].map((item, index) => requireString(item, `${label}.notIn[${String(index)}]`)),
    );
  }
  if ('startsWith' in value) {
    requireExactKeys(value, ['column', 'startsWith'], label);
    return csv.column(column).startsWith(requireString(value['startsWith'], `${label}.startsWith`));
  }
  if ('regex' in value) {
    requireExactKeys(value, ['column', 'regex'], label);
    if (!isObject(value['regex'])) {
      throw new Error(`${label}.regex must contain source and optional flags strings`);
    }
    requireExactKeys(value['regex'], ['source', 'flags'], `${label}.regex`, true);
    const source = requireString(value['regex']['source'], `${label}.regex.source`);
    const flags = value['regex']['flags'] === undefined
      ? ''
      : requireString(value['regex']['flags'], `${label}.regex.flags`);
    return csv.column(column).hasMatch(new RegExp(source, flags));
  }
  throw new Error(`${label} must contain equals, in, notEquals, notIn, startsWith, or regex`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

function requireExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string,
  allowMissing = false,
): void {
  const keys = Object.keys(value);
  const unknownKey = keys.find((key) => !allowedKeys.includes(key));
  if (unknownKey !== undefined) {
    throw new Error(`${label} contains unknown property: ${unknownKey}`);
  }
  if (!allowMissing) {
    const missingKey = allowedKeys.find((key) => !Object.hasOwn(value, key));
    if (missingKey !== undefined) {
      throw new Error(`${label} is missing property: ${missingKey}`);
    }
  }
}

function usageError(output: CliOutput, message: string, helpCommand = 'csv --help'): number {
  output.error(`csv: ${message}\nRun '${helpCommand}' for usage.`);
  return 2;
}
