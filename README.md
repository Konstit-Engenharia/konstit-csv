# @konstit/csv

A high-performance streaming CSV parsing library for Bun using a native C++ parser with SIMD acceleration (AVX2/NEON), streaming file access, filtering, and column selection.

[Quick start](#quick-start) · [Choose an API](#choose-an-api) · [CLI](#cli) · [Documentation](#documentation)

- Stream large files in batches, or parse a buffer you already have in memory.
- Filter records and select columns before materializing results as JavaScript rows.
- Reads [RFC 4180](https://www.rfc-editor.org/info/rfc4180) CSV. Set `strict: true` to reject malformed quoting.
- Tested against [csv-spectrum](https://github.com/maxogden/csv-spectrum), selected [W3C CSVW](https://w3c.github.io/csvw/tests/) cases,
  and fixtures derived from [csvkit](https://github.com/wireservice/csvkit).
- Stream compressed files:
  - zip
  - gzip
  - brotli
  - zstd
  - deflate
- Auto detect delimiters, encoding and compression.
- UTF-8 and Latin-1 have specialized native fast paths.
  - More encodings are supported out of the box, including Windows-1252, UTF-16LE, and Shift_JIS.

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
File and buffer APIs default to a comma delimiter. Buffers default to UTF-8; file readers detect UTF-8, Latin-1,
Windows-1252 or BOM-marked UTF-16 from the first 64 KiB after decompression. Set `delimiter: 'auto'` on a file
to detect both from the same sample. To skip detection, pass the encoding and delimiter explicitly.
UTF-8 and Latin-1 use native paths; other supported `Bun.Encoding` labels are transcoded to UTF-8.

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

| Task                         | API                                                 | Result or lifecycle                                 |
| ---------------------------- | --------------------------------------------------- | --------------------------------------------------- |
| Parse an in-memory buffer    | `await csv.parse(buffer)`                           | All rows as arrays of strings                       |
| Stream a file                | `csv.rows(path)`                                    | Async stream of row batches                         |
| Count records                | `await csv.count(path)`                             | Record count, optionally filtered                   |
| Access native batches        | `csv.batches(path, options)`                        | Use `using` to close each batch after its iteration |
| Visit rows or scan columns   | `batch.forEachRow()` / `batch.scanColumns()`        | Read projected fields by position within the batch  |
| Supply your own input chunks | `NativeCsvParser`                                   | Manual parser and batch disposal                    |
| Find record-safe boundaries  | `findCsvSafeSplitOffsets()` / `findCsvSafeShards()` | Advanced byte-range processing                      |

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
    delimiter: 'auto',
  })
) {
  for (const row of batch) {
    console.log(row);
  }
}
```

File APIs and the CLI detect compression by default and read plain CSV, TSV, and text files directly.
For a plain file with an unrecognized name, use `compression: 'none'` or `--compression none`.
Decompression streams into the parser.

ZIP archives automatically select the only data file, ignoring directories and OS metadata.
For archives with multiple data files, select an entry with `compression: { format: 'zip', entry: 'data.csv' }`. See
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

Inspect a file, count its records, or emit the first records as newline-delimited JSON:

```sh
bunx @konstit/csv probe data.csv

bunx @konstit/csv count data.csv
# 3

bunx @konstit/csv lines data.csv --json --limit 2
# ["id","name","state"]
# ["1","Ada","SP"]
```

The CLI detects input encoding and delimiter by default. Without `--json`, `lines` writes normalized UTF-8 CSV.
`count` and `lines` support column filters; `lines` also supports
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
