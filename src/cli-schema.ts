import {
  command,
  completionShells,
  flag,
  type Infer,
  option,
  parsers,
  positional,
} from '@konstit/cli';
import packageInfo from '../package.json';
import { resolveInputEncoding } from './normalize.js';

const encodings = parsers.enum([
  'auto',
  { value: 'utf8', aliases: ['utf-8'] },
  { value: 'latin1', aliases: ['iso88591', 'iso-8859-1'] },
  'utf-16le',
  'utf-16be',
  'windows-874',
  'windows-1250',
  'windows-1251',
  { value: 'windows-1252', aliases: ['cp1252'] },
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
  { value: 'shift_jis', aliases: ['sjis'] },
  'x-mac-cyrillic',
  'x-user-defined',
]);
const encodingParser = {
  ...encodings,
  parse(label: string) {
    try {
      return encodings.parse(label);
    } catch {
      // Bun recognizes additional decoder labels, including case and whitespace variants.
      const encoding = resolveInputEncoding(label);
      return encodings.parse(typeof encoding === 'string' ? encoding : encoding.encoding);
    }
  },
};

const compressionFormats = ['auto', 'none', 'gzip', 'deflate', 'deflate-raw', 'brotli', 'zstd', 'zip'] as const;
const positiveUint32 = parsers.range(1, 0xffff_ffff, { integer: true });
const byteSize = parsers.custom(parsers.byteSize.label, (input) => {
  const bare = Number(input);
  return parsers.byteSize.parse(Number.isNaN(bare) ? input : `${bare}B`);
});
const positiveByteSize = parsers.refine(byteSize, (bytes) => bytes > 0, 'expected at least 1 byte');
const chunkSize = parsers.refine(positiveByteSize, (bytes) => bytes <= 64 * 1024 * 1024, 'expected at most 64 MiB');
const inputDelimiter = parsers.refine(
  parsers.string,
  (value) => value === 'auto' || isSafeDelimiter(value),
  'expected one safe ASCII character or auto',
);
const outputDelimiter = parsers.refine(parsers.string, isSafeDelimiter, 'expected one safe ASCII character');
const path = positional('path', parsers.string, { required: true, valueHint: 'file', describe: 'Input file path' });
const zipEntry = option('zip-entry', parsers.refine(parsers.string, (value) => value.length > 0, 'expected a non-empty ZIP entry name'), {
  valueName: 'PATH',
  describe: 'Select an entry inside a ZIP archive',
});

function isSafeDelimiter(value: string): boolean {
  return value.length === 1 && value.charCodeAt(0) <= 0x7f && value !== '"' && value !== '\r' && value !== '\n';
}

const fileArgs = [
  path,
  option('delimiter', inputDelimiter, { describe: 'One safe ASCII character or auto (default: auto)' }),
  option('encoding', encodingParser, {
    valueName: 'ENCODING',
    describe: 'Input encoding or decoder alias (default: auto)',
  }),
  option('compression', parsers.enum(compressionFormats), {
    valueName: 'FORMAT',
    describe: `Input compression (default: auto). Choices: ${compressionFormats.join(', ')}`,
  }),
  option('chunk-size', chunkSize, {
    describe: 'Read 1 B through 64 MiB per chunk (default: 1MiB). Example: 256KiB',
  }),
  zipEntry,
  option('max-compression-ratio', positiveUint32, {
    valueName: 'RATIO',
    describe: 'Maximum ZIP expansion ratio, an integer from 1 through 4294967295',
  }),
  option('max-decompressed-bytes', positiveByteSize, { describe: 'Maximum decompressed ZIP size (default: 64GiB)' }),
  flag('strict', { describe: 'Enable strict RFC 4180 validation' }),
  option('fixed-columns', positiveUint32, { valueName: 'COUNT', describe: 'Require this positive field count in strict mode' }),
  option('columns', parsers.string, {
    valueName: 'INDEXES',
    describe: 'Zero-based column indexes in output order. The count command validates the indexes only',
  }),
  option('expected-header', parsers.string, { repeatable: true, describe: 'Expected header value. Repeat once per column in strict mode' }),
  flag('require-header', { describe: 'Require a header row in strict mode' }),
  option('min-data-rows', parsers.range(0, Number.MAX_SAFE_INTEGER, { integer: true }), {
    valueName: 'COUNT',
    describe: 'Require at least this many data rows in strict mode',
  }),
  option('where', parsers.json(), { valueName: 'JSON', describe: 'Advanced JSON can nest all, any, and not.' }),
  option('where-eq', parsers.keyValue, { repeatable: true, valueName: 'COLUMN=VALUE', describe: 'Match an exact value' }),
  option('where-neq', parsers.keyValue, { repeatable: true, valueName: 'COLUMN=VALUE', describe: 'Exclude an exact value' }),
  option('where-in', parsers.keyValue, { repeatable: true, valueName: 'COLUMN=VALUE', describe: 'Match any listed value for this column' }),
  option('where-noin', parsers.keyValue, {
    repeatable: true,
    valueName: 'COLUMN=VALUE',
    describe: 'Exclude all listed values for this column',
  }),
  option('where-prefix', parsers.keyValue, { repeatable: true, valueName: 'COLUMN=VALUE', describe: 'Match a value prefix' }),
  option('where-regex', parsers.keyValue, {
    repeatable: true,
    valueName: 'COLUMN=/RE/FLAGS',
    describe: 'Match an RE2-compatible regex (flags: i, m, s, u)',
  }),
] as const;

const fileRelations = {
  requires: [['zip-entry', 'compression']],
  requiresIf: [['compression', 'zip', 'zip-entry']],
  groups: [
    {
      name: 'zip-limits',
      members: ['max-compression-ratio', 'max-decompressed-bytes'],
      multiple: true,
      requires: ['zip-entry'],
    },
    {
      name: 'schema',
      members: ['fixed-columns', 'expected-header', 'require-header', 'min-data-rows'],
      multiple: true,
      requires: ['strict'],
    },
    {
      name: 'filters',
      members: ['where', 'where-eq', 'where-neq', 'where-in', 'where-noin', 'where-prefix', 'where-regex'],
      multiple: true,
      conflicts: ['strict'],
    },
  ],
} as const;

const fileHelp = `ZIP input automatically selects the only data file, ignoring OS metadata.
Explicit ZIP options require --compression zip and --zip-entry.
Filters use original input column indexes. Friendly filter clauses use AND.
Strict mode cannot use filter options.

Encodings: ${encodings.choices?.map(({ value, aliases }) => aliases ? `${value} (${aliases.join(', ')})` : value).join(', ')}
Other Bun TextDecoder labels are also accepted.`;
const count = command('count', {
  ...fileRelations,
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
  ...fileRelations,
  conflicts: [['json', 'output-delimiter'], ['limit', 'min-data-rows']],
  about: 'Stream matching records as normalized UTF-8 CSV or NDJSON',
  args: [
    ...fileArgs,
    flag('json', { describe: 'Emit one JSON string array per record (NDJSON)' }),
    option('output-delimiter', outputDelimiter, {
      default: ',',
      describe: 'One safe ASCII output delimiter (default: comma). Incompatible with --json',
    }),
    option('limit', parsers.range(1, Number.MAX_SAFE_INTEGER, { integer: true }), {
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
  version: packageInfo.version,
  defaultToHelp: true,
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
