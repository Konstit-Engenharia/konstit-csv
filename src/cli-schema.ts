import {
  command,
  completionShells,
  flag,
  type Infer,
  option,
  parsers,
  positional,
} from '@konstit/cli';
import { resolveInputEncoding } from './normalize.js';
import type { CsvFileEncoding } from './types.js';

const encodingNames = [
  'auto',
  'utf8',
  'latin1',
  'utf-16le',
  'utf-16be',
  'windows-874',
  'windows-1250',
  'windows-1251',
  'windows-1252',
  'windows-1253',
  'windows-1254',
  'windows-1255',
  'windows-1256',
  'windows-1257',
  'windows-1258',
  'iso-8859-2',
  'iso-8859-3',
  'iso-8859-4',
  'iso-8859-5',
  'iso-8859-6',
  'iso-8859-7',
  'iso-8859-8',
  'iso-8859-8-i',
  'iso-8859-10',
  'iso-8859-13',
  'iso-8859-14',
  'iso-8859-15',
  'iso-8859-16',
  'big5',
  'euc-jp',
  'euc-kr',
  'gb18030',
  'gbk',
  'ibm866',
  'iso-2022-jp',
  'koi8-r',
  'koi8-u',
  'macintosh',
  'shift_jis',
  'x-mac-cyrillic',
  'x-user-defined',
] as const satisfies readonly CsvFileEncoding[];
const encodings = parsers.enum(encodingNames);
const encodingParser = {
  ...encodings,
  parse(label: string) {
    if (label === 'auto') {
      return encodings.parse(label);
    }
    // Resolve decoder aliases using the same Latin-1 and Windows-1252 rules as the CSV API.
    const encoding = resolveInputEncoding(label);
    return encodings.parse(typeof encoding === 'string' ? encoding : encoding.encoding);
  },
};

const compressionFormats = ['auto', 'none', 'gzip', 'deflate', 'deflate-raw', 'brotli', 'zstd', 'zip'] as const;
const byteSize = parsers.custom('BYTES', (input) => {
  // A unitless number is a byte count. Unit suffixes use the framework's SI and IEC scales.
  const bytes = Number(input);
  return Number.isNaN(bytes) ? parsers.byteSize.parse(input) : bytes;
});
const path = positional('path', parsers.string, { required: true, valueHint: 'file', describe: 'Input file path' });
const zipEntry = option('zip-entry', parsers.string, { valueName: 'PATH', describe: 'Select an entry inside a ZIP archive' });
const fileArgs = [
  path,
  option('delimiter', parsers.string, { describe: 'One safe ASCII character or auto (default: auto)' }),
  option('encoding', encodingParser, {
    valueName: 'ENCODING',
    describe: 'Input encoding or decoder alias (default: auto)',
  }),
  option('compression', parsers.enum(compressionFormats), {
    valueName: 'FORMAT',
    describe: `Input compression (default: auto). Choices: ${compressionFormats.join(', ')}`,
  }),
  option('chunk-size', byteSize, { describe: 'Read 1 B through 64 MiB per chunk (default: 1MiB). Example: 256KiB' }),
  zipEntry,
  option('max-compression-ratio', parsers.string, {
    valueName: 'RATIO',
    describe: 'Maximum ZIP expansion ratio, an integer from 1 through 4294967295',
  }),
  option('max-decompressed-bytes', byteSize, { describe: 'Maximum decompressed ZIP size (default: 64GiB)' }),
  flag('strict', { describe: 'Enable strict RFC 4180 validation' }),
  option('fixed-columns', parsers.string, { valueName: 'COUNT', describe: 'Require this positive field count in strict mode' }),
  option('columns', parsers.string, {
    valueName: 'INDEXES',
    describe: 'Zero-based column indexes in output order. The count command validates the indexes only',
  }),
  option('expected-header', parsers.string, { repeatable: true, describe: 'Expected header value. Repeat once per column in strict mode' }),
  flag('require-header', { describe: 'Require a header row in strict mode' }),
  option('min-data-rows', parsers.string, { valueName: 'COUNT', describe: 'Require at least this many data rows in strict mode' }),
  option('where', parsers.string, { valueName: 'JSON', describe: 'Advanced JSON can nest all, any, and not.' }),
  option('where-eq', parsers.string, { repeatable: true, valueName: 'COLUMN=VALUE', describe: 'Match an exact value' }),
  option('where-neq', parsers.string, { repeatable: true, valueName: 'COLUMN=VALUE', describe: 'Exclude an exact value' }),
  option('where-in', parsers.string, { repeatable: true, valueName: 'COLUMN=VALUE', describe: 'Match any listed value for this column' }),
  option('where-noin', parsers.string, {
    repeatable: true,
    valueName: 'COLUMN=VALUE',
    describe: 'Exclude all listed values for this column',
  }),
  option('where-prefix', parsers.string, { repeatable: true, valueName: 'COLUMN=VALUE', describe: 'Match a value prefix' }),
  option('where-regex', parsers.string, {
    repeatable: true,
    valueName: 'COLUMN=/RE/FLAGS',
    describe: 'Match an RE2-compatible regex (flags: i, m, s, u)',
  }),
] as const;

const fileHelp = `ZIP input automatically selects the only data file, ignoring OS metadata.
Explicit ZIP options require --compression zip and --zip-entry.
Filters use original input column indexes. Friendly filter clauses use AND.
Strict mode cannot use filter options.

Encodings: ${encodingNames.join(', ')}
Decoder aliases such as utf-8, iso-8859-1, cp1252, and sjis are also accepted.`;
const count = command('count', {
  about: 'Count CSV records, including the header row',
  args: fileArgs,
  argsOverrideSelf: true,
  afterHelp: `${fileHelp}

Examples:
  csv count data.csv --chunk-size 256KiB
  csv count data.csv --where-eq 2=SP
  csv count data.csv --where-regex '1=/^ana/i'`,
});
const lines = command('lines', {
  about: 'Stream matching records as normalized UTF-8 CSV or NDJSON',
  args: [
    ...fileArgs,
    flag('json', { describe: 'Emit one JSON string array per record (NDJSON)' }),
    option('output-delimiter', parsers.string, { describe: 'One safe ASCII output delimiter (default: comma). Incompatible with --json' }),
    option('limit', parsers.string, {
      valueName: 'N',
      describe: 'Stop after matching output record N, numbered from 1. Incompatible with --min-data-rows',
    }),
  ],
  argsOverrideSelf: true,
  afterHelp: `${fileHelp}

With --strict and --limit, validation stops at the selected record. Set a fixed
delimiter and encoding (defaults: comma and UTF-8). Input must be uncompressed
and the chunk size must be 1 byte. Earlier records can be written before a later error.

Examples:
  csv lines data.csv --json --limit 10
  csv lines data.csv --columns 0,2 --where-eq 3=active`,
});
export type CountArguments = Infer<typeof count>;
export type LinesArguments = Infer<typeof lines>;

export const csvCommand = command('csv', {
  about: 'Inspect, count, and stream CSV records',
  subcommandRequired: true,
  subcommands: [
    count,
    lines,
    command('probe', {
      about: 'Inspect file size, compression, encoding, delimiter, line endings, and first record width',
      args: [path, zipEntry],
      argsOverrideSelf: true,
      afterHelp: 'Samples up to 64 KiB of CSV. For a ZIP archive with multiple data files, select one with --zip-entry.',
    }),
    command('completion', {
      about: 'Print a shell completion script for csv',
      args: [positional('shell', parsers.enum(completionShells), { required: true, describe: completionShells.join(', ') })],
    }),
  ],
  afterHelp: 'Run without installing: bunx @konstit/csv <command> <path>',
});
