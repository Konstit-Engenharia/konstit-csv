# @konstit/csv

A CSV toolkit for Bun with native parsing, streaming file access, filtering, and column selection.

[Quick start](#quick-start) · [Choose an API](#choose-an-api) · [CLI](#cli) · [Documentation](#documentation)

- Stream large files in batches, or parse a buffer you already have in memory.
- Filter records and select columns before materializing results as JavaScript rows.
- Read compressed input, detect delimiters, and decode the encodings supported by Bun's `TextDecoder`.
- Use native batches and reusable views for low-allocation access.

## Installation

Requires **Bun `^1.4.0`**. Published packages include native libraries for these targets:

| Operating system | Architecture | CPU requirement |
| ---------------- | ------------ | --------------- |
| macOS 13+        | ARM64        | NEON            |
| macOS 13+        | x64          | AVX2            |
| Linux            | x64          | AVX2            |

```sh
bun add @konstit/csv
```

No native build is needed on supported targets. For building from source, see
[Contributing](https://github.com/Konstit-Engenharia/csv-parser/blob/main/CONTRIBUTING.md).

## Quick start

Parse a buffer with `await csv.parse()`. Save this example as `parse.ts`:

```ts
import { csv } from '@konstit/csv';

const input = Buffer.from('id,name,state\n1,Ada,SP\n2,Grace,RJ\n');
const rows = await csv.parse(input);

console.log(rows);
// [
//   ['id', 'name', 'state'],
//   ['1', 'Ada', 'SP'],
//   ['2', 'Grace', 'RJ'],
// ]
```

```sh
bun parse.ts
```

Each row is an array of strings. Headers remain ordinary records, and numeric-looking fields remain strings.
The default delimiter is a comma and the default encoding is UTF-8. File and buffer APIs accept any `Bun.Encoding`
label. UTF-8 and Latin-1 use the native fast paths. For other encodings, the reader converts the input to UTF-8,
one chunk at a time for files.

## Stream a file

For files that do not fit in memory, use `csv.rows()`. Create `data.csv` with the same sample data:

```csv
id,name,state
1,Ada,SP
2,Grace,RJ
```

```ts
import { csv } from '@konstit/csv';

for await (const batch of csv.rows('data.csv')) {
  for (const row of batch) {
    console.log(row);
  }
}
```

Each iteration yields a **batch of rows** in file order, so use the inner loop to process individual records. Process
batches as they arrive to avoid collecting the complete file in memory. The header is returned as the first row.

To count records without materializing rows:

```ts
import { csv } from '@konstit/csv';

console.log(await csv.count('data.csv')); // 3, including the header
```

## Choose an API

| Task                         | API                                                 | Result or lifecycle                                    |
| ---------------------------- | --------------------------------------------------- | ------------------------------------------------------ |
| Parse an in-memory buffer    | `await csv.parse(buffer)`                           | All rows as arrays of strings                          |
| Stream a file                | `csv.rows(path)`                                    | Async stream of row batches                            |
| Count records                | `await csv.count(path)`                             | Record count, optionally filtered                      |
| Access native batches        | `csv.withBatches(path, options, callback)`          | Callback with automatic batch disposal                 |
| Reuse row or columnar views  | `csv.withRowViews()` / `csv.withColumnarBatches()`  | Synchronous callback; views are scoped to the callback |
| Supply your own input chunks | `NativeCsvParser`                                   | Manual parser and batch disposal                       |
| Find record-safe boundaries  | `findCsvSafeSplitOffsets()` / `findCsvSafeShards()` | Advanced byte-range processing                         |

For code that uses workers, see the [migration guide](https://github.com/Konstit-Engenharia/csv-parser/blob/main/docs/api.md#migration-from-removed-worker-apis).

Start with `csv.rows()` for streaming records. Use batches or views when you need byte access or lower allocation
overhead. Advanced applications can use the record-safe boundary helpers to divide an uncompressed CSV file into
byte ranges for their own processing pipeline. See the [API guide](https://github.com/Konstit-Engenharia/csv-parser/blob/main/docs/api.md)
for options and resource lifetimes.

## Common operations

These examples read the `data.csv` shown above.

### Filter records and select columns

Column indexes are zero-based **source column indexes**: `id` is `0`, `name` is `1`, and `state` is `2`.
Filters use source indexes even when output columns are reordered.

```ts
import { csv } from '@konstit/csv';

for await (
  const batch of csv.rows('data.csv', {
    columns: [1, 0],
    where: csv.column(2).equals('SP'),
  })
) {
  console.log(batch); // [['Ada', '1']]
}
```

The filter also applies to the header, which does not match `'SP'` here. Combine conditions with `csv.all()`,
`csv.any()`, and `csv.not()`. Filters support equality, membership, prefixes, and RE2 regular expressions.

See [Filters](https://github.com/Konstit-Engenharia/csv-parser/blob/main/docs/api.md#filters) for matching rules
and supported regex syntax.

### Read compressed files

Create a gzip copy of the sample file:

```sh
gzip -c data.csv > data.csv.gz
```

```ts
import { csv } from '@konstit/csv';

for await (
  const batch of csv.rows('data.csv.gz', {
    compression: 'auto',
    delimiter: 'auto',
  })
) {
  for (const row of batch) {
    console.log(row);
  }
}
```

Decompression streams into the parser. File APIs support gzip, deflate, deflate-raw, Brotli, Zstandard, and selected
ZIP entries. Automatic delimiter detection is also available for file APIs.

For a ZIP archive, select an entry with `compression: { format: 'zip', entry: 'data.csv' }`. See
[Compression](https://github.com/Konstit-Engenharia/csv-parser/blob/main/docs/api.md#compression-and-delimiter-detection)
for supported formats, detection rules, and limits.

### Validate input

```ts
import { csv } from '@konstit/csv';

const rows = await csv.parse(
  Buffer.from('id,name,state\n1,Ada,SP\n2,Grace,RJ\n'),
  {
    strict: true,
    expectedHeaders: ['id', 'name', 'state'],
    minDataRows: 1,
  },
);

console.log(rows.length); // 3
```

Strict mode validates quote syntax and can check header and row-count requirements. It supports column selection
with `csv.parse()` and `csv.rows()`, but cannot be combined with filters. See
[Strict validation](https://github.com/Konstit-Engenharia/csv-parser/blob/main/docs/api.md#strict-validation)
for supported combinations.

## CLI

Count records or emit the first records as newline-delimited JSON:

```sh
bunx @konstit/csv count data.csv
# 3

bunx @konstit/csv lines data.csv --json --limit 2
# ["id","name","state"]
# ["1","Ada","SP"]
```

Without `--json`, `lines` writes normalized UTF-8 CSV. Both commands support column filters; `lines` also supports
column selection. Use `bunx @konstit/csv lines --help` or read the
[CLI guide](https://github.com/Konstit-Engenharia/csv-parser/blob/main/docs/cli.md) for flags and output behavior.

## Documentation

- [API guide](https://github.com/Konstit-Engenharia/csv-parser/blob/main/docs/api.md): filters, encoding, compression,
  validation, typed options, batches, views, advanced byte boundaries, and manual parsing.
- [CLI guide](https://github.com/Konstit-Engenharia/csv-parser/blob/main/docs/cli.md): commands, filters, output formats,
  and option constraints.
- [Benchmarks](https://github.com/Konstit-Engenharia/csv-parser/blob/main/docs/benchmarks.md): datasets, commands,
  recorded measurements, and their limitations.
- [Contributing](https://github.com/Konstit-Engenharia/csv-parser/blob/main/CONTRIBUTING.md): repository setup, examples,
  validation, native development, and releases.

## Performance

The parser uses native C++ with AVX2 on x64 and NEON on ARM64. Filtering and counting can avoid creating JavaScript
rows for records you do not need. The [benchmark guide](https://github.com/Konstit-Engenharia/csv-parser/blob/main/docs/benchmarks.md)
records a full-file comparison, including memory use and reproduction commands. Results depend on the workload,
hardware, and selected API.

## Contributing

See [Contributing](https://github.com/Konstit-Engenharia/csv-parser/blob/main/CONTRIBUTING.md) to run the project locally,
validate changes, or rebuild the native libraries.

## License

MIT © 2026 KONSTIT ENGENHARIA E TECNOLOGIA LTDA. See
[LICENSE](https://github.com/Konstit-Engenharia/csv-parser/blob/main/LICENSE) and
[third-party notices](https://github.com/Konstit-Engenharia/csv-parser/blob/main/THIRD_PARTY_NOTICES.md).
