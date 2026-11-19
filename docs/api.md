# TypeScript API

[Back to the README](../README.md) · [CLI usage](../README.md#cli)

`@konstit/csv` requires Bun `^1.4.0`. The package parses CSV bytes with a native parser and exposes a high-level
streaming API plus lower-level batch and parser surfaces.

The examples in this guide use the same UTF-8 input:

```ts
const source = Buffer.from(
  'id,name,state\n1,Ada,SP\n2,Grace,RJ\n',
);
```

To run the file examples, save the same data as `data.csv` in your working directory:

```csv
id,name,state
1,Ada,SP
2,Grace,RJ
```

Rows are mutable arrays of decoded strings. The parser does not assign special meaning to a header row: parsing and
counting include every physical record unless your application skips or filters one explicitly. The default delimiter is
`,`. File readers default to `encoding: 'auto'`; buffers default to UTF-8. Parsing options accept any `Bun.Encoding` label supported by Bun's
`TextDecoder`.

## Start with an in-memory buffer

Use `csv.parse()` when the complete input is already in memory. It is asynchronous and returns a promise containing all
rows:

```ts
import { csv } from '@konstit/csv';

const rows = await csv.parse(source);

console.log(rows);
// [
//   ['id', 'name', 'state'],
//   ['1', 'Ada', 'SP'],
//   ['2', 'Grace', 'RJ'],
// ]
```

`csv.parse()` accepts bytes, not a file path. Compression and automatic delimiter and encoding detection are available through file
APIs instead. Use `columns` to project and reorder fields:

```ts
const names = await csv.parse(source, { columns: [1] as const });
// [['name'], ['Ada'], ['Grace']]
```

## Stream a local file

`csv.rows()` returns an async generator. Each yielded value is one non-empty batch of materialized row arrays, and both
batches and rows are yielded in file order, so there are two loops:

```ts
for await (const batch of csv.rows('data.csv')) {
  for (const row of batch) {
    console.log(row);
  }
}
```

By default, you can retain batches and individual rows. Set `reuseArrays: true` on a file stream to let the iterator refill
the batch and its row arrays. Treat both as read-only and finish using them before requesting the next batch.
Use `row.slice()` to keep a row or retain individual field strings directly.

File streams preserve file order, and `count()` counts records without returning row arrays, including the header when
one is present:

```ts
const totalRecords = await csv.count('data.csv');
```

The `csv` namespace provides these helpers:

- `csv.parse(buffer, options)` returns a promise of all materialized rows.
- `csv.rows(path, options)` streams materialized row batches.
- `csv.count(path, options)` counts records, optionally through a native filter.
- `csv.batches(path, options)` streams disposable native field batches or [raw record batches](#raw-record-batches).
- `csv.findCsvSafeSplitOffsets(path, count, options)` and `csv.findCsvSafeShards(path, count, options)` find record-safe
  byte boundaries for advanced applications that process file ranges themselves.

`columns` contains zero-based physical input indexes and preserves the requested output order.

### Skip and limit records

`skipRows` skips the first input records, including any header, before applying filters. `limit` caps the total
number of matching records emitted or counted. Quoted fields containing newlines still belong to one record.
Both options accept non-negative safe integers. The defaults are zero skipped rows and unlimited output.
A zero limit or a skip beyond the end yields no records.

```ts
const rows = await csv.parse(source, { skipRows: 1, limit: 1 });
// [['1', 'Ada', 'SP']]
```

These options apply to buffer parsing, file streams, native batches, counts, and manual parsers.
Strict validation starts at the first input record, including skipped rows. The original header is checked
against `expectedHeaders`, and skipped data rows contribute to `minDataRows`. Parsing stops when the output
limit is reached, so schema requirements must be satisfied within the consumed prefix. A zero limit
validates an empty prefix. File format detection and decompression can read ahead.

## Filters

Create filters with `csv.column(index)`. The index is a zero-based physical input column. A column builder can create
many immutable predicates, and the resulting filter can be reused by row and count APIs:

```ts
const state = csv.column(2);
const inSoutheast = state.isOneOf(['SP', 'RJ']);
const startsWithA = csv.column(1).startsWith('A');

const where = csv.all(inSoutheast, startsWithA);

for await (const batch of csv.rows('data.csv', { where })) {
  console.log(batch); // [['1', 'Ada', 'SP']]
}

console.log(await csv.count('data.csv', { where }));
```

Available condition methods are `equals`, `doesNotEqual`, `isOneOf`, `isNoneOf`, `startsWith`, and `hasMatch`. Binary
`Buffer` and `Uint8Array` operands, and the arrays passed to membership filters, are copied when the filter is created.
The `where` option accepts only filters created by this API; object-literal predicates are not accepted. A missing
column does not match, including for `doesNotEqual` and `isNoneOf`.

Compose filters with `csv.all()`, `csv.any()`, and `csv.not()`:

```ts
const where = csv.all(
  csv.any(
    csv.column(2).equals('SP'),
    csv.column(2).equals('RJ'),
  ),
  csv.not(csv.column(1).startsWith('G')),
);
```

Groups may be nested, and `all`/`any` require at least one child. Boolean evaluation uses three-valued semantics for a
missing column: `not` preserves the unknown result, while `any` can still match when another child is true.

`hasMatch()` validates a JavaScript `RegExp` against the statically linked RE2 engine and searches within each field.
Supported flags are `i`, `m`, `s`, and `u`; `g`, `d`, `y`, and `v` are rejected. RE2 does not support lookaround or
backreferences. Unicode matching is enabled by default; `u` documents the JavaScript pattern intent. `hasMatch()`
converts JavaScript Unicode escapes and escaped `/` characters before validating the expression. Use `^` and `$` for a
full-field match. Patterns are limited to 4096 UTF-8 bytes, and one operation can contain at most 32 regex predicates.

## Field transforms

Use `transform` with `csv.parse()`, `csv.rows()`, `csv.batches()`, or the `NativeCsvParser` constructor.
Build a reusable chain with `csv.transform()` and bind it to one or more zero-based physical input columns with `.on(...columns)`.
Filters, fixed widths and strict headers use the original record.
Accepted rows emit transformed values in the requested column order, including through native batch byte views.

```ts
const state = csv.column(2);
const rows = await csv.parse(Buffer.from('Ana;12,50; sp \nBia;9,00;SP'), {
  delimiter: ';',
  where: state.equals(' sp '),
  columns: [2, 0, 1] as const,
  transform: [
    state.trim().upper().map({ SP: 'São Paulo' }, 'Unknown'),
    csv.column(1).replace(',', '.'),
  ],
});
// [['São Paulo', 'Ana', '12.50']]
```

| Operation                      | Behavior                                                                                                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trim()`                       | Remove leading and trailing Unicode White_Space.                                                                                                                  |
| `upper()`, `lower()`           | Apply full Unicode default casing. For example, `Straße` uppercases to `STRASSE` and `ΟΣ` lowercases to `ος`.                                                     |
| `unaccent()`                   | Canonically decompose, remove every character with the Unicode Diacritic property, then recompose to NFC. `ã`, `a\u0303`, `a´` and `a^` all become `a`.           |
| `replace(search, replacement)` | Replace every non-overlapping match of a nonempty literal string or an RE2-compatible `RegExp`.                                                                   |
| `map(values, defaultValue?)`   | Look up the whole field once in a map or plain object. An unmatched field emits `defaultValue` when supplied (including `''`), or its current value when omitted. |
| `date(format, defaultValue?)`  | Emit a valid date as `YYYY-MM-DD`, `DD-MM-YYYY`, or `DD/MM/YYYY`. Invalid fields emit the fallback string, which defaults to `''`.                                |

With a string search, both arguments are literal. For example, `.replace('.', '$1')` changes `a.b.c` to `a$1b$1c`.
With a regex search, the parser compiles each active pattern and parses its replacement templates once during setup. Columns, batches and stream resets reuse them.
Patterns follow the same syntax, flags and 4096-byte limit as `hasMatch()`, with `g` also accepted. Every match is replaced with or without `g`.
Regex replacements accept JavaScript capture syntax. For example, `.replace(/(?<code>[A-Z]+)-(\d+)/, '$2/$<code>')` changes `AB-12 CD-34` to `12/AB 34/CD`.
Use `$1` through `$99` for numbered captures, `$<name>` for a named capture, `$&` for the whole match, and `$$` for a dollar sign.
With only one group, `$10` inserts group 1 followed by a literal `0`, and `$2` stays literal. An unmatched optional group inserts an empty string.
An unknown name inserts an empty string if the pattern has named groups. Otherwise `$<name>` stays literal.
All other text, including backslashes and JavaScript’s prefix and suffix references, is literal. Invalid RE2 patterns raise a `SyntaxError` during parser setup.

`date()` accepts `YYYYMMDD`, `YYYY-MM-DD`, `DD-MM-YYYY`, and `DD/MM/YYYY` input with ASCII digits and years 0001 through 9999.
It checks Gregorian month lengths and leap years. For example, `.date('DD/MM/YYYY', 'Unknown')` converts
`20261117` to `17/11/2026` and `29/02/2023` to `Unknown`. Chain `.trim()` first to accept surrounding whitespace.

`unaccent()` uses the Unicode 17.0 Diacritic property. Normalization, case conversion and whitespace use Unicode 15.1.
Literal replacement and mapping operands must be well-formed strings and match exactly.
Steps run left to right. A chain can be reused or extended without mutating it. Supply at most one chain per column.
For example, `const clean = csv.transform().trim().upper()` can be used as `transform: [clean.on(0, 2)]`
for one file and `transform: [clean.on(3)]` for another. Calling `.on()` on an already bound chain selects a new set
of target columns. For a single column, `csv.column(2).trim()` is shorthand for `csv.transform().trim().on(2)`.
`map(values, 'Unknown')` emits `'Unknown'` for an unmatched field. Later steps in the chain receive the mapped value or fallback.
The chain captures map entries or a plain object's own enumerable string keys and values when built. Readers capture the list of chains at invocation.
A present empty field can be mapped with the key `''`. A missing projected field emits `''` padding.
An unselected field receives no transform. Manual parser resets retain transforms, and count writes bypass them.

## Compression and delimiter detection

File operations default to `compression: 'auto'`. They stream gzip, deflate, raw deflate, Brotli, and Zstandard input
into the parser and read recognized plain text files directly. ZIP archives automatically select the only data file,
ignoring directories and OS metadata. Select an entry explicitly for archives containing multiple data files.

```ts
for await (const batch of csv.rows('data.csv.gz')) {
  console.log(batch);
}

for await (
  const batch of csv.rows('export.zip', {
    compression: { format: 'zip', entry: 'data/export.csv' },
  })
) {
  console.log(batch);
}
```

ZIP entry names must match exactly. `entry: '*'` selects the only file after ignoring directories and OS metadata.
Ignored metadata includes files inside `__MACOSX/` or `.AppleDouble/` directories at any depth, filenames starting
with `._`, and `.DS_Store`, `Thumbs.db`, `ehthumbs.db`, `ehthumbs_vista.db`, and `desktop.ini` (case-insensitive).
Explicit entry names can select these files. Automatic selection fails when zero or multiple data files remain.
ZIP input requires a regular file because the native reader seeks through the archive's central directory.
Encrypted entries and methods other than stored and DEFLATE are rejected. ZIP output is limited
by default to 64 GiB and a declared compression ratio of 1000; use `maxDecompressedBytes` and `maxCompressionRatio`
to apply stricter limits or to permit a larger trusted entry.

`delimiter: 'auto'` is supported for file operations. With an explicit encoding it probes at most 64 KiB after decompression and any transcoding,
ignores separators inside quoted fields, and considers comma, tab, semicolon, pipe, colon, caret, and tilde. The at sign
(`@`) is selected only when it has a stable positive count and none of those delimiters do. File
extensions such as `.csv`, `.tsv`, `.tab`, and `.psv` are confirmed hints and can resolve an otherwise tied result,
including before a compression suffix such as `.gz`. Empty, single-column, inconsistent, and ambiguous probes fail;
specify a delimiter explicitly in those cases. Omitted `delimiter` remains comma. In-memory parsing and the byte-boundary
helpers use a fixed one-character delimiter, defaulting to comma.

File readers default to `encoding: 'auto'`, which uses up to the first 64 KiB of decompressed input. It works with the default comma, an explicit delimiter
(including single-column files), or `delimiter: 'auto'`. When both are automatic, the reader uses the same sample for both
decisions. It replays buffered bytes into the parser, so the file is read once.

The probe honors initial UTF-8 and UTF-16LE/BE byte-order marks and removes the mark from the first field.
Without a mark, a UTF-8-compatible sample (including ASCII) selects UTF-8. Otherwise, a byte in `0x80–0x9F`
selects Windows-1252, and other legacy samples select Latin-1. BOM-less NUL bytes and UTF-32 signatures produce errors.
Detection is a best guess for the entire file. For example, if the sample is all ASCII and later rows use Latin-1 accents,
pass `encoding: 'latin1'` explicitly. Supply an explicit label for other encodings such as Shift_JIS.

Compression detection checks the signature and the `.gz`, `.gzip`, `.zst`, `.zstd`, `.br`, `.zz`, `.zlib`, `.deflate`,
and `.deflate-raw` suffixes. When neither identifies compression, the reader checks `Bun.file(path).type`.
It reads `text/csv`, `text/tab-separated-values`, and `text/plain` directly, ignoring MIME parameters such as the charset.
It also recognizes `.psv`, `.ssv`, and `.tab` when Bun reports a generic binary type.
Pass `compression: 'none'` for known plain input with an unknown MIME type, such as an extensionless file or stdin.
Signature and extension mismatches and corrupt compressed streams still fail. A `.deflate` file without a zlib wrapper
requires explicit `compression: 'deflate-raw'`.

Compressed input and automatic delimiter detection are supported by the file APIs. The byte-boundary helpers require an
uncompressed file and a fixed one-character delimiter.

Explicit `encoding: 'utf8'` skips encoding detection. UTF-8 and its aliases use the native UTF-8 parser. `latin1`, `iso88591`, and `iso-8859-1` use the
native Latin-1 parser. With these three labels, byte `0x80` decodes to U+0080. Use `windows-1252` for an export
that uses the same byte for `€`. For the repository's large Latin-1 corpus, pass `encoding: 'latin1'`:

```ts
for await (
  const batch of csv.rows('corpus/large/example.csv', {
    delimiter: ';',
    encoding: 'latin1',
    columns: [0, 1, 2],
  })
) {
  console.log(batch);
}
```

Bun decodes other input encodings, including `windows-1252`, `utf-16le`, and `shift_jis`, before CSV parsing.
Files retain one decoder across chunks. Both file and buffer APIs use an ASCII delimiter for transcoded input.
The decoder replaces malformed sequences with U+FFFD and consumes an initial UTF-16 byte-order mark matching the
selected byte order. In-memory parsing uses the same option:

```ts
const rows = await csv.parse(
  Buffer.from([0x6e, 0x61, 0x6d, 0x65, 0x0a, 0x80, 0x0a]),
  {
    encoding: 'windows-1252',
  },
);
// [['name'], ['€']]
```

## Record-safe byte boundaries

Advanced applications that process an uncompressed CSV file in their own pipeline can use the boundary helpers to avoid
starting a range in the middle of a quoted record. `csv.findCsvSafeSplitOffsets()` returns record-safe starts plus the
terminal file boundary. `csv.findCsvSafeShards()` returns the same boundaries as non-empty inclusive `{ start, end }` ranges.
These helpers only calculate offsets and ranges. They do not parse the ranges or schedule processing.

```ts
const offsets = csv.findCsvSafeSplitOffsets('data.csv', 4, { delimiter: ',' });
const shards = csv.findCsvSafeShards('data.csv', 4, { delimiter: ',' });

console.log(offsets);
console.log(shards);
```

These helpers scan source-file bytes and require uncompressed UTF-8 or Latin-1 input with a fixed one-character
delimiter. A small file can produce fewer non-empty shards than requested.

## Strict validation

Set `strict: true` to validate RFC-style quote syntax. This applies to `csv.parse()`, `csv.rows()`, batches, and
unfiltered counts:

```ts
await csv.parse(
  Buffer.from('id,name,state\n1,"Ada,SP'),
  { strict: true },
);
// throws a strict CSV quote-syntax error
```

Strict row parsing can still project columns: the parser validates each complete row first, then materializes the
requested columns.

Use `fixedColumns` to require a specific number of fields in every input row, including rows rejected by a filter.
For example, `fixedColumns: 3` with `columns: [0]` requires three input fields and returns the first field.

```ts
const strictProjection = await csv.parse(source, {
  columns: [0, 2] as const,
  strict: true,
});
// [['id', 'state'], ['1', 'SP'], ['2', 'RJ']]
```

Schema metadata is checked only when strict mode is enabled:

```ts
const checked = await csv.parse(source, {
  strict: true,
  expectedHeaders: ['id', 'name', 'state'],
  requireHeader: true,
  minDataRows: 2,
});
```

`expectedHeaders` compares the first row exactly. `requireHeader` rejects empty input when a header row is required.
`minDataRows` counts records after the first row. By default the header is included in returned rows and in `csv.count()`.

Strict validation cannot be combined with `where`. Use `csv.rows()` for strict parsing with column selection.
Native batches support strict validation only when `columns` is omitted.

## Typed options and configuration snapshots

The option factories preserve literal tuple inference while checking the operation-specific option shape:

```ts
import {
  csv,
  defineCountOptions,
  defineRowsOptions,
} from '@konstit/csv';

const columns = [0, 2] as const;

const rowOptions = defineRowsOptions({
  columns,
  where: csv.column(2).equals('SP'),
});

const countOptions = defineCountOptions({ strict: true });

for await (const batch of csv.rows('data.csv', rowOptions)) {
  console.log(batch); // rows are typed as [string, string][]
}

console.log(await csv.count('data.csv', countOptions));
```

The public option types reject strict filters and strict projected batches. Projection and filter indexes are integers from `0` through `2024`; a
projection may contain at most 2024 unique columns. A filter program may contain at most 2024 predicates and 4096 total
predicates and Boolean operators. Invalid values fail before parsing starts.

File and in-memory operations snapshot their options when called, before asynchronous iteration begins. Projection arrays,
expected headers, and nested ZIP settings are copied, so later mutation of the original options does not affect an active
operation. The option types are readonly, but this is a type-level contract rather than a runtime freeze: caller-owned
objects remain mutable. Filters created by `csv.column()`, `csv.all()`, `csv.any()`, and `csv.not()` are immutable and
reusable. Start a new operation to apply changed settings.

## Native batches and reusable views

Use `csv.batches()` for native-backed row access, byte ranges, or low-allocation materialization.
Each batch owns native memory. The `using` declaration closes it when the iteration ends, including on `break` or error:

```ts
for await (using batch of csv.batches('data.csv')) {
  batch.forEachRow((row) => {
    console.log({
      id: row.get(0),
      name: row.get(1),
      state: row.get(2),
      stateBytes: row.bytes(2),
      stateRange: row.range(2),
    });
  });
}
```

`batch.forEachRow()` reuses one row view and requires a synchronous callback. The view is valid only during
the callback. You can keep decoded strings. Copy borrowed bytes before closing the batch.

`NativeCsvBatch` provides `rowCount`, `totalFields`, `dataLength`, `closed`, `rows()`, `rowsInto(target, columns?)`,
`forEachRow()`, `data()`, `dataView()`, `rowOffsets()`, `fieldOffsets()`, `rowFieldCount()`, `fieldRange()`, `fieldBytes()`,
`fieldBuffer()`, `fieldString()`, `scanColumns()`, `forEachColumnRange()`, `forEachColumnBytes()`,
`countWhereEquals()`, `close()`, and `[Symbol.dispose]`.

In `csv.batches()`, `columns` selects the stored fields in the requested order.
Filters always use physical input indexes. Row accessors, including `get()` and `pick()`,
and batch methods such as `scanColumns()` use positions in the resulting batch. `pick(columns)` captures the indexes
before reading fields. `rowsInto(target, columns)` captures them before filling the target.

```ts
for await (
  using batch of csv.batches('data.csv', {
    columns: [2, 0],
    where: csv.column(2).equals('SP'),
  })
) {
  batch.forEachRow((row) => {
    console.log(row.get(0), row.get(1)); // state (source 2), id (source 0)
  });
}
```

`rowOffsets()` and `fieldOffsets()` return `BigUint64Array`. Convert an offset to `number` only after checking it is within
`Number.MAX_SAFE_INTEGER` and the associated backing data. Columnar `scanColumns()` supplies JavaScript-safe numeric
ranges in a `Float64Array`. Each scan copies the requested column indexes before the first callback, so every row
uses the column order supplied for that call.

### Literal TSV

Set `delimiter: '\t'` for TSV and `quote: false` when the producer uses double quotes as ordinary field data.
Set `recordDelimiter: '\n'` to end records at LF and preserve carriage returns, including a CR before LF.
These options can be set independently in the JavaScript parsing and counting APIs. Strict validation and
byte-offset sharding require the default dialect.

### Raw record batches

Use `output: 'raw-records'` with `quote: false` and `recordDelimiter: '\n'` to stream accepted records
from a file as original decompressed bytes. Filters address zero-based physical columns.

```ts
import { csv } from '@konstit/csv';

for await (
  using batch of csv.batches('training.tsv.gz', {
    compression: 'gzip',
    delimiter: '\t',
    quote: false,
    recordDelimiter: '\n',
    output: 'raw-records',
    where: csv.column(1).isOneOf(['br', 'BR', 'Br', 'bR']),
  })
) {
  for (let i = 0; i < batch.rowCount; ++i) {
    if (batch.rowFieldCount(i) === 3) {
      const record = batch.rowBytes(i);
      // Consume the bytes here or call record.slice() to retain a copy.
    }
  }
}
```

`NativeCsvRawRecordBatch.rowBytes(i)` returns a borrowed `Uint8Array` valid until the batch is closed.
The view includes CRLF or LF when present. An unterminated final record is returned as-is.
`rowFieldCount(i)` includes every physical field, including empty fields. Use it before applying
a caller-defined cap on valid rows. The parser's `limit` counts all filter matches.

Raw batches support native UTF-8 and Latin-1 encodings for filter comparisons and default to UTF-8.
The output preserves every source byte, including any BOM and bytes that are invalid UTF-8.
Projection, field transforms, and strict validation are available with parsed field output.

## Manual parser

Use `NativeCsvParser` when your application already owns input chunking:

```ts
import { NativeCsvParser } from '@konstit/csv';

using parser = new NativeCsvParser();
const rows: string[][] = [];

using first = parser.writeBatch(
  Buffer.from('id,name,state\n1,Ada,SP\n2,Grace'),
  false,
);
rows.push(...first.rows());

using final = parser.writeBatch(Buffer.from(',RJ\n'), true);
rows.push(...final.rows());

console.log(rows);
```

`writeBatch()` may retain an incomplete final row until the next write. Pass `true` as the final argument on the last
write, or call `endBatch()` to flush it. Returned batches own native memory and must be closed or disposed. The
convenience `write()` and `end()` methods materialize rows and close their temporary batches automatically.

Pass `columns` and predicates to the constructor. Filters match physical input columns, and rows contain the selected
fields in the requested order. Use `equalsFilter` for a single equality check, `filters` for predicates combined with
AND, or `filterProgram` for a postfix Boolean expression. Supply one filter form per parser.

```ts
using parser = new NativeCsvParser({
  columns: [1],
  equalsFilter: { column: 2, value: 'SP' },
});
parser.write(Buffer.from('1,Ada,SP\n2,Bob,RJ\n'), true); // [['Ada']]
parser.reset();
parser.writeCount(Buffer.from('1,Ada,SP\n2,Bob,RJ\n'), true); // 1
```

To migrate from per-write settings, move the projection and predicates to `new NativeCsvParser(...)`.
Replace `writeProjectedBatch*` and `endProjectedBatch*` with `writeBatch` and `endBatch`. Replace
`writeCountWhere*` and `endCountWhere*` with `writeCount` and `endCount`. Pass only input bytes and the optional
final flag to writes. The parser owns its configuration across writes, flushes, and resets.

`NativeCsvParser` accepts native UTF-8 and Latin-1 labels. It captures `encoding`, `delimiter`, `strict`,
`fixedColumns`, `skipRows`, and `limit` at construction. The skip and limit apply across writes and restart on `reset()`.
Strict mode requires unfiltered, unprojected input.
It does not support
`delimiter: 'auto'` or schema metadata options. Dispose the parser with `close()` or `using`; its
`closed` property reports whether the native handle has been released.
