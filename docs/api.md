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
`,` and the default encoding is UTF-8. Parsing options accept any `Bun.Encoding` label supported by Bun's
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

`csv.parse()` accepts bytes, not a file path. Compression and automatic delimiter detection are available through file
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
- `csv.batches(path, options)` streams disposable `NativeCsvBatch` objects.
- `csv.withBatches(path, options, callback)` closes each native batch after the callback settles.
- `csv.withRowViews(path, options, callback)` visits reusable row views without allocating one string array per row.
- `csv.withColumnarBatches(path, options, callback)` visits reusable columnar batch views.
- `csv.findCsvSafeSplitOffsets(path, count, options)` and `csv.findCsvSafeShards(path, count, options)` find record-safe
  byte boundaries for advanced applications that process file ranges themselves.

`columns` contains zero-based physical input indexes and preserves the requested output order. The legacy
`selectedColumns` spelling is still accepted, but the two properties cannot be supplied together.

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

## Compression and delimiter detection

File operations stream `gzip`, `deflate`, `deflate-raw`, Brotli, Zstandard, and ZIP input into the parser. Use an explicit
format or `compression: 'auto'`:

```ts
for await (const batch of csv.rows('data.csv.gz', { compression: 'auto' })) {
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

ZIP entry names must match exactly. `entry: '*'` is allowed only when the archive contains exactly one file entry;
directories are ignored. Encrypted entries and methods other than stored and DEFLATE are rejected. ZIP output is limited
by default to 64 GiB and a declared compression ratio of 1000; use `maxDecompressedBytes` and `maxCompressionRatio`
to apply stricter limits or to permit a larger trusted entry.

`delimiter: 'auto'` is supported for file operations. Detection probes at most 64 KiB after decompression and any transcoding,
ignores separators inside quoted fields, and considers comma, tab, semicolon, pipe, colon, caret, and tilde. File
extensions such as `.csv`, `.tsv`, `.tab`, and `.psv` are confirmed hints and can resolve an otherwise tied result,
including before a compression suffix such as `.gz`. Empty, single-column, inconsistent, and ambiguous probes fail;
specify a delimiter explicitly in those cases. Omitted `delimiter` remains comma. In-memory parsing and the byte-boundary
helpers use a fixed one-character delimiter, defaulting to comma.

`compression: 'auto'` reads at most four prefix bytes and combines supported signatures with `.gz`, `.gzip`, `.zst`,
`.zstd`, `.br`, `.zz`, `.zlib`, `.deflate`, and `.deflate-raw` extensions. Signature and extension mismatches fail. A
`.deflate` file without a zlib wrapper requires explicit `compression: 'deflate-raw'`.

Compressed input and automatic delimiter detection are supported by the file APIs. The byte-boundary helpers require an
uncompressed file and a fixed one-character delimiter.

UTF-8 (the default) and its aliases use the native UTF-8 parser. `latin1`, `iso88591`, and `iso-8859-1` use the
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
const rows = await csv.parse(Buffer.from([0x6e, 0x61, 0x6d, 0x65, 0x0a, 0x80, 0x0a]), {
  encoding: 'windows-1252',
});
// [['name'], ['€']]
```

## Record-safe byte boundaries

Advanced applications that process an uncompressed CSV file in their own pipeline can use the boundary helpers to avoid
starting a range in the middle of a quoted record. `findCsvSafeSplitOffsets()` returns record-safe starts plus the
terminal file boundary. `findCsvSafeShards()` returns the same boundaries as non-empty inclusive `{ start, end }` ranges.
These helpers only calculate offsets and ranges. They do not parse the ranges or schedule processing.

```ts
const offsets = csv.findCsvSafeSplitOffsets('data.csv', 4, { delimiter: ',' });
const shards = csv.findCsvSafeShards('data.csv', 4, { delimiter: ',' });

console.log(offsets);
console.log(shards);
```

These helpers scan source-file bytes and require uncompressed UTF-8 or Latin-1 input with a fixed one-character
delimiter. A small file can produce fewer non-empty shards than requested.

## Migration from removed worker APIs

Replace `parallelRows()` and `parallelCount()` with `csv.rows()` and `csv.count()`, and remove `workerCount` from
their options. For a `workerPool()` or `CsvWorkerPool` call site, pass the file path and options directly to
`csv.rows()` or `csv.count()` each time. Row batches arrive in file order.

Replace `CsvParallelRowsOptions`, `CsvParallelCountOptions`, and `CsvWorkerPoolOptions` with `CsvRowsOptions` or
`CsvCountOptions` for the corresponding operation. `CsvSingleThreadRowsOptions` is an alias for `CsvRowsOptions`.

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
`minDataRows` counts records after the first row. The header remains in the returned rows and in `csv.count()`; these
options validate it rather than remove it.

Strict validation cannot be combined with `where`. Strict selected columns are supported by materialized rows. Native
projected-batch methods do not support strict mode, and columnar-batch callbacks reject strict mode when
`columns` is supplied.

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

The public option types reject unsupported combinations, including strict filters and using both `columns` and
`selectedColumns`. Projection and filter indexes are integers from `0` through `2024`; a
projection may contain at most 2024 unique columns. A filter program may contain at most 2024 predicates and 4096 total
predicates and Boolean operators. Invalid values fail before parsing starts.

File and in-memory operations snapshot their options when called, before asynchronous iteration begins. Projection arrays,
expected headers, and nested ZIP settings are copied, so later mutation of the original options does not affect an active
operation. The option types are readonly, but this is a type-level contract rather than a runtime freeze: caller-owned
objects remain mutable. Filters created by `csv.column()`, `csv.all()`, `csv.any()`, and `csv.not()` are immutable and
reusable. Start a new operation to apply changed settings.

## Native batches and reusable views

Use `withBatches()` when you need native-backed row access, byte ranges, or low-allocation materialization while keeping
batch cleanup automatic:

```ts
await csv.withBatches('data.csv', {}, (batch) => {
  batch.forEachRow((row) => {
    console.log({
      id: row.getPhysical(0),
      name: row.getPhysical(1),
      state: row.getPhysical(2),
      stateBytes: row.bytes(2),
      stateRange: row.range(2),
    });
  });
});
```

The callback may be asynchronous; its batch is closed after the callback settles. If you use `csv.batches()` directly,
close every yielded batch or use explicit resource management:

```ts
for await (using batch of csv.batches('data.csv')) {
  console.log(batch.rowCount, batch.totalFields);
}
```

`NativeCsvBatch` provides `rowCount`, `totalFields`, `dataLength`, `closed`, `rows()`, `rowsInto(target, columns?)`,
`forEachRow()`, `data()`, `dataView()`, `rowOffsets()`, `fieldOffsets()`, `rowFieldCount()`, `fieldRange()`, `fieldBytes()`,
`fieldBuffer()`, `fieldString()`, `countWhereEquals()`, `close()`, `dispose()`, and `[Symbol.dispose]`.

The row methods `get()`, `getPhysical()`, `pick()`, and `pickPhysical()` index the fields stored in the current batch.
In `csv.batches()` and its callback helpers, unfiltered batches retain all source fields. When a filter is combined
with a projection, the batch stores projected fields, so `get(0)` and `getPhysical(0)` both refer to projected position
`0`; neither translates an original source index. Use `row.selectedColumns` to map projected positions back to input columns:

```ts
await csv.withRowViews(
  'data.csv',
  { columns: [0, 2] as const, where: csv.column(2).equals('SP') },
  (row) => {
    console.log(row.selectedColumns); // [0, 2]
    console.log(row.get(0), row.get(1)); // '1', 'SP'
  },
);
```

`withRowViews()` invokes a synchronous callback for each row. Its reusable view is invalid when the callback returns.
Read strings or copy raw bytes before returning if the values must outlive the callback; do not retain the view.

`withColumnarBatches()` follows the same lifetime rule for a reusable columnar view. Its callback must be synchronous,
its raw buffers may alias native storage, and data that must outlive the callback must be copied. It does not support
strict validation with selected columns.

`rowOffsets()` and `fieldOffsets()` return `BigUint64Array`. Convert an offset to `number` only after checking it is within
`Number.MAX_SAFE_INTEGER` and the associated backing data. Columnar `scanColumns()` supplies JavaScript-safe numeric
ranges in a `Float64Array`.

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

The parser also exposes projected-batch methods and direct native count-filter methods. Projection and filter settings
apply at the current stream position. Keep them consistent across chunks that may belong to one logical row; complete
that row or call `reset()` before changing them. `selectedColumns` passed to the constructor is validated but does not
configure `writeBatch()`; use the explicit projected methods for low-level projection.

`NativeCsvParser` accepts native UTF-8 and Latin-1 labels. It captures `encoding`, `delimiter`, `strict`, and
`fixedColumns` at construction. It does not support
`delimiter: 'auto'` or schema metadata options. Dispose the parser with `close()`, `dispose()`, or `using`; its
`closed` property reports whether the native handle has been released.
