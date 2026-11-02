# @konstit/csv

A high-performance CSV toolkit for Bun, powered by a native C++ parser. Stream large and compressed files, select
columns, apply composable filters, and process data in parallel without loading the complete dataset into memory.

## Features

- Stream CSV files or parse in-memory buffers without loading a complete file into memory.
- Read materialized rows, native batches, reusable row views, or columnar batch views.
- Select and reorder zero-based input columns before materialization.
- Filter inside the native parser with `equals`, `doesNotEqual`, `isOneOf`, `isNoneOf`, `startsWith`, and RE2 regular expressions.
- Compose nested native filters with `csv.all()`, `csv.any()`, and `csv.not()`.
- Process file shards in parallel with Bun workers or reuse workers through `csv.workerPool()`.
- Find CSV-safe split offsets without breaking quoted records or embedded newlines.
- Stream gzip, deflate, deflate-raw, Brotli, Zstandard, and ZIP input into serial APIs.
- Select an exact ZIP entry or use `entry: '*'` when the archive contains exactly one file.
- Detect comma, tab, semicolon, pipe, colon, caret, and tilde delimiters for serial file operations.
- Decode UTF-8 and Latin-1 input and emit UTF-8 strings.
- Validate strict quote syntax, fixed column counts, headers, and minimum data-row counts.
- Use typed option helpers, immutable filters, and explicit resource disposal from TypeScript.
- Run native C++20 parsing with AVX2 on x64 and NEON on ARM64.

## Quick Start

```sh
bun add @konstit/csv
```

```ts
import { csv } from '@konstit/csv';

const path = 'corpus/large/example.csv';

for await (
  const rows of csv.rows(path, {
    delimiter: ';',
    columns: [0, 1, 2],
    chunkSize: 8 * 1024 * 1024,
  })
) {
  for (const row of rows) {
    console.log(row);
  }
}
```

In this repo, `corpus/large/example.csv` is semicolon-delimited. Pass `delimiter: ';'` for examples and benchmarks that read it.

### Large corpus files

The files in `corpus/large/` are too large to commit to this repository. Download and prepare them with Bun. The script
requires `unzip` and skips files that already exist:

```sh
bun scripts/download-large-corpus.ts
```

- `example.csv` is an approximately 6 GB ISO-8859-1-encoded Brazilian government data dump after extraction. Download
  it from [Arquivos Receita](https://arquivos.receitafederal.gov.br/public.php/dav/files/gn672Ad4CF8N6TK/Dados/Cadastros/CNPJ/2026-08/Estabelecimentos0.zip).
- `formatted_addresses_tagged.random.tsv.gz` is part of the libpostal training data and remains compressed for the
  benchmarks. Download it from the
  [Internet Archive](https://archive.org/download/libpostal-parser-training-data-20170304/formatted_addresses_tagged.random.tsv.gz).

For manual downloads, place both files in `corpus/large/` before running benchmarks or examples that use them.

## Library API

Import the `csv` namespace for file-oriented helpers:

```ts
import { csv } from '@konstit/csv';

const rowCount = await csv.count('data.csv', { delimiter: ';' });

const selected = csv.rows('data.csv', {
  delimiter: ';',
  columns: [0, 2],
  where: csv.all(
    csv.column(2).isOneOf(['SP', 'RJ']),
    csv.column(1).startsWith('A'),
    csv.column(3).hasMatch(/^[0-9]{5}-[0-9]{3}$/),
  ),
});

const compressed = csv.rows('data.csv.gz', {
  compression: 'auto',
  delimiter: 'auto',
});

const zipped = csv.rows('export.zip', {
  compression: { format: 'zip', entry: 'data/export.csv' },
});
```

Supported helpers:

- `csv.parse(buffer, options)` parses one buffer and returns rows.
- `csv.rows(path, options)` streams materialized row arrays.
- `csv.batches(path, options)` streams `NativeCsvBatch` objects.
- `csv.withBatches(path, options, callback)` owns batch close handling around a callback.
- `csv.count(path, options)` counts rows, optionally with native filters.
- `csv.withRowViews(path, options, callback)` streams reusable row views with managed lifetimes.
- `csv.withColumnarBatches(path, options, callback)` streams reusable columnar batch views.
- `csv.workerPool(path, options)` creates a reusable pool for repeated parallel operations.
- `csv.findCsvSafeSplitOffsets(path, count, options)` and `csv.findCsvSafeShards(path, count, options)` split files at record boundaries.

### Filters

Filters select a zero-based physical column first. Each condition method returns a complete, validated, immutable filter.
The selected column is reusable, and one filter can be reused across row, count, and worker APIs:

```ts
const state = csv.column(2);
const isSP = state.equals('SP');
const isSouthEast = state.isOneOf(['SP', 'RJ']);

await csv.count('data.csv', { where: isSP });
await csv.count('data.csv', { where: isSouthEast, workerCount: 4 });
```

The condition methods are `equals`, `doesNotEqual`, `isOneOf`, `isNoneOf`, `startsWith`, and `hasMatch`. Binary
`Buffer` and `Uint8Array` operands are copied during construction so later caller mutation cannot change a filter.
The `where` option accepts only filters created by this API; TypeScript object-literal predicates are not supported.
If a row does not contain the selected column, it does not match, including for `doesNotEqual` and `isNoneOf`.
Use `hasMatch()` for regular expressions:

```ts
const selected = csv.rows('data.csv', {
  where: csv.column(1).hasMatch(/^ana$/iu),
});
```

Regex filters use statically linked RE2 and search the field. Use `^` and `$` for a full-field match. The supported flags
are `i`, `m`, `s`, and `u`. Unicode matching is enabled by default; `u` documents the JavaScript pattern intent. The
`g`, `d`, `y`, and `v` flags are rejected. RE2 does not support lookaround or backreferences. `hasMatch()` converts
JavaScript Unicode escapes and escaped `/` characters, then validates the RE2 expression immediately. A compiled
pattern is limited to 4096 UTF-8 bytes, and one operation can use at most 32 regex filters.

Use `csv.all()` when every child must match, `csv.any()` when at least one child must match, and `csv.not()` to negate
one child. Groups can be nested. `all` and `any` require at least one filter:

```ts
const filter = csv.all(
  csv.any(
    csv.column(2).equals('SP'),
    csv.column(2).equals('RJ'),
  ),
  csv.not(csv.column(1).startsWith('B')),
);
```

Boolean groups are evaluated by the native parser. A predicate for a missing column has an unknown result. `csv.not()`
keeps that result unknown, so a missing column does not become a match. `csv.any()` still matches when another child is
true.

Serial file operations accept `compression: 'auto' | 'gzip' | 'deflate' | 'deflate-raw' | 'brotli' | 'zstd'`.
Decompression streams into the parser and does not buffer the complete file. `auto` reads at most four prefix bytes and
combines signatures with `.gz`, `.gzip`, `.zst`, `.zstd`, `.br`, `.zz`, `.zlib`, `.deflate`, or `.deflate-raw`.
Signature and extension mismatches fail. A `.deflate` file without a zlib wrapper requires explicit `deflate-raw`.
Compressed input does not support worker pools, parallel operations, or CSV byte-offset sharding.

ZIP input uses `compression: { format: 'zip', entry: 'path/in/archive.csv' }`. The selected stored or DEFLATE entry
is decoded in bounded native chunks with zlib-ng AVX2 or NEON acceleration. Entry names must match exactly. Use
`entry: '*'` to select the file when the archive contains exactly one file; directory entries are ignored. Archives
with zero or multiple files fail in this mode. Encrypted entries and compression methods other than stored and
DEFLATE fail. The defaults limit output to 64 GiB and the declared compression ratio to 1000. Use
`maxDecompressedBytes` and `maxCompressionRatio` to set lower application limits or to permit a larger trusted entry.

Serial file operations also accept `delimiter: 'auto'`. Detection probes at most 64 KiB of decompressed data and
ignores separators inside quoted fields. It checks comma, tab, semicolon, pipe, colon, caret, and tilde. The `.csv`,
`.tsv`, `.tab`, and `.psv` extensions are confirmed hints, including before a compression extension such as `.gz`.
Empty, single-column, inconsistent, and ambiguous probes fail with an error. Omitted `delimiter` still means comma.
Automatic delimiter detection does not support in-memory parsing, workers, parallel operations, or byte-offset sharding.

`delimiter` suggests common CSV delimiters in TypeScript while accepting any string. Runtime parsing still requires
exactly one character unless a serial file operation uses `auto`.

## Strict Validation

`strict: true` validates RFC-style quote syntax for row materialization:

```ts
await csv.parse(Buffer.from('id,name\n1,"Ada'), { strict: true });
// throws: native CSV parser failed: strict CSV quote syntax error: unterminated quoted field
```

Strict mode also validates optional schema metadata during row parsing:

```ts
await csv.parse(Buffer.from('id,name\n1,Ada\n'), {
  strict: true,
  expectedHeaders: ['id', 'name'],
  minDataRows: 1,
});
```

- `expectedHeaders` validates the first row exactly.
- `requireHeader` rejects empty input when a header row is required.
- `minDataRows` validates row count after the header row.

Strict mode currently covers row batches, `count()` without filters, `fixedColumns`, and row schema metadata. Projected
batches and count filters reject `strict: true` explicitly until they have strict native variants.

## Typed Options

Use the option factories when you want literal-preserving inference without repeating `satisfies` everywhere:

```ts
import {
  csv,
  defineCountOptions,
  defineRowsOptions,
} from '@konstit/csv';

const columns = [0, 2] as const;

const rowOptions = defineRowsOptions({
  columns,
  delimiter: ';',
  where: csv.column(1).equals('SP'),
});

const countOptions = defineCountOptions({
  strict: true,
});

for await (const rows of csv.rows('data.csv', rowOptions)) {
  console.log(rows);
}

console.log(await csv.count('data.csv', countOptions));
```

The public option types reject combinations unsupported by the native path, including strict validation with filters or
workers. `columns` and the legacy `selectedColumns` alias are mutually exclusive. Each operation accepts only the
options supported by its native path.

Parsing and file operations capture their options when called, before the first `next()` call on a returned stream.
That configuration stays fixed until the operation finishes. Projection arrays, expected headers, and nested ZIP
settings are copied; later changes to the original options do not affect the operation. A worker pool captures its
configuration when created and uses it for every operation. Caller-owned objects remain mutable, and filters created
with `csv.column()`, `csv.all()`, `csv.any()`, and `csv.not()` remain reusable.
Option types are readonly. Start a new operation (or create a new pool) to apply changed settings.

Column indexes are integers from `0` through `2024`. A projection may contain at most 2024 columns and must not repeat
an index. A filter can contain at most 2024 predicates and 4096 total predicates and Boolean operators. Invalid values
fail before parsing begins.

## Batch API

Use batches when you need low allocation row access or byte ranges.

```ts
import { csv } from '@konstit/csv';

await csv.withBatches(
  'data.csv',
  { delimiter: ';' },
  (batch) => {
    batch.forEachRow((row) => {
      console.log({
        rowIndex: row.rowIndex,
        first: row.getPhysical(0),
        bytes: row.bytes(0),
        range: row.range(0),
        selected: row.pickPhysical([0, 2]),
      });
    });
  },
);
```

`row.get()`, `row.getPhysical()`, `row.pick()`, and `row.pickPhysical()` all read physical CSV column indexes.
If you requested projected columns elsewhere in the API, `row.selectedColumns` is metadata that lets you map projected
positions back to source columns.

If you use `csv.batches()` directly, declare each batch with `using` so it is disposed after its iteration:

```ts
for await (using batch of csv.batches('data.csv', { delimiter: ';' })) {
  console.log(batch.rowCount);
}
```

`NativeCsvBatch` exposes:

- `rowCount`, `totalFields`
- `rows()`
- `rowsInto(target, columns?)`
- `forEachRow(callback)`
- `data()`, `dataView()`
- `rowOffsets()`, `fieldOffsets()`
- `rowFieldCount(rowIndex)`
- `fieldRange(rowIndex, columnIndex)`
- `fieldBytes(rowIndex, columnIndex)`
- `fieldBuffer(rowIndex, columnIndex)`
- `fieldString(rowIndex, columnIndex)`
- `countWhereEquals(columnIndex, value)`
- `close()`

`rowOffsets()` and `fieldOffsets()` return `BigUint64Array`. Convert individual offsets to `number` only after checking
that they are within `Number.MAX_SAFE_INTEGER` and the associated backing data. `scanColumns()` supplies its
JavaScript-safe numeric ranges in a `Float64Array`.

## Manual Parser API

Use `NativeCsvParser` when you already own chunking:

```ts
import { NativeCsvParser } from '@konstit/csv';

using parser = new NativeCsvParser({ delimiter: ';' });
const rowsBuffer: string[][] = [];

using batch = parser.writeBatch(Buffer.from('1;Ana\n2;Bia\n'), true);
console.log(batch.rowsInto(rowsBuffer));
```

Always dispose parser-owned batches and the parser. `NativeCsvParser` supports row batches, projected batches, and direct
count filters.

Keep filter and projection options consistent across chunks belonging to the same row. Complete the row or reset the
parser before changing those options; fields already consumed cannot be re-evaluated with a different filter.

Resource objects expose `close()`, `dispose()`, `closed`, and `Symbol.dispose`, so explicit-resource-management syntax works
in Bun:

```ts
using parser = new NativeCsvParser({ delimiter: ';' });
using batch = parser.writeBatch(Buffer.from('1;Ana\n'), true);
console.log(batch.rows());
```

## CLI

Count every CSV record in a file, including the header row:

```sh
bunx @konstit/csv count data.csv
bunx @konstit/csv count data.csv --delimiter ';' --chunk-size 262144
```

Stream parsed records as normalized UTF-8 CSV:

```sh
bunx @konstit/csv lines data.csv
bunx @konstit/csv lines data.csv --limit 10
bunx @konstit/csv lines data.csv --json --limit 10
bunx @konstit/csv lines data.csv --columns 0,2 --where-eq 3=active --limit 10
bunx @konstit/csv lines input.tsv --delimiter $'\t' --output-delimiter ',' > selected.csv
```

`--limit N` stops after matching output record `N`, numbered from 1. A quoted field can contain embedded newlines, but
its enclosing record counts as one. The header counts only when it is emitted. Early stop validates only the consumed
input prefix, so `--limit` cannot be combined with `--min-data-rows`. With `--strict`, a limit requires a fixed input
delimiter and either an omitted chunk size or `--chunk-size 1`; the CLI uses one-byte chunks to avoid strict read-ahead.
`--strict` with `--limit` cannot use `--compression`, including `auto`.

`lines` writes normalized UTF-8 CSV, not the original source bytes. The default output uses commas, LF record endings,
and standard quote escaping. Use `--output-delimiter` to select another safe ASCII delimiter. `--columns` selects the
output fields and their order. Filters still use the original input column indexes.

Use `--json` for newline-delimited JSON. Each output line is one array of strings, including the header when it is
emitted. JSON output escapes embedded field newlines and quotes. Stdout contains only JSON records. Diagnostics remain
on stderr. `--json` cannot be combined with `--output-delimiter`.

The CLI uses one process and exposes the serial file, parser, projection, and filter fields as flags. It does not expose
`workerCount`. Run `csv count --help` or `csv lines --help` for the complete list. Friendly filter flags use
`column=value`. Repeat `--where-in` or `--where-noin` for each value. Different filter clauses combine with AND. CLI
filter values are strings; use the TypeScript API for `workerCount` and binary `Buffer` or `Uint8Array` values.

```sh
bunx @konstit/csv count data.csv --delimiter ';' --where-eq 2=SP
bunx @konstit/csv count data.csv --where-neq 2=SP
bunx @konstit/csv count data.csv --where-in 2=SP --where-in 2=RJ --where-prefix 1=A
bunx @konstit/csv count data.csv --where-noin 2=SP --where-noin 2=RJ
bunx @konstit/csv count data.csv --where-regex '1=/^A/i'
bunx @konstit/csv lines data.csv --where-in 2=SP --where-in 2=RJ --limit 25
bunx @konstit/csv lines data.csv --columns 0,1 --json --limit 25
```

The large corpus file in this repository is semicolon-delimited:

```sh
bunx @konstit/csv lines corpus/large/example.csv --delimiter ';' --limit 10
bunx @konstit/csv lines corpus/large/example.csv --delimiter ';' --columns 0,1,2 --limit 100 > sample.csv
```

For generated or advanced CLI filters, `--where <json>` accepts a CLI-only serializable filter shape. This JSON shape
is separate from the TypeScript filter API:

```sh
bunx @konstit/csv count data.csv --where '{"all":[{"any":[{"column":2,"equals":"SP"},{"column":2,"equals":"RJ"}]},{"not":{"column":1,"startsWith":"B"}}]}'
```

CLI JSON filters can nest `all`, `any`, and `not`. Friendly filter flags still combine with AND.

## Examples

```sh
bun run example:first-rows
bun run example:api:rows
bun run example:api:count
bun run example:api:batches
bun run example:api:typed-options
bun run example:api:strict-options
bun run example:api:worker-count
bun run example:api:worker-rows
bun run example:api:worker-pool
bun run example:api:shards
```

Example environment variables:

- `CSV_EXAMPLE_FILE`: Input file for examples. It defaults to `CSV_BENCH_FILE`, then
  `corpus/large/example.csv`.
- `CSV_BENCH_FILE`: Input file for benchmarks. It also provides the example input when `CSV_EXAMPLE_FILE` is not set.
- `CSV_EXAMPLE_DELIMITER`: Field delimiter for examples. It defaults to `CSV_BENCH_DELIMITER`, then `;`.
- `CSV_BENCH_DELIMITER`: Field delimiter for benchmarks. It also provides the example delimiter when
  `CSV_EXAMPLE_DELIMITER` is not set.
- `CSV_EXAMPLE_CHUNK_SIZE`: Number of bytes read per chunk by examples. It defaults to `CSV_BENCH_CHUNK_SIZE`, then
  8 MiB.
- `CSV_BENCH_CHUNK_SIZE`: Number of bytes read per chunk by benchmarks. It also provides the example chunk size when
  `CSV_EXAMPLE_CHUNK_SIZE` is not set.
- `CSV_EXAMPLE_COLUMNS`: Comma-separated, zero-based column indexes selected by examples. The default is `0,1,2`.
- `CSV_EXAMPLE_LIMIT`: Maximum number of rows printed by examples. It defaults to `CSV_PRINT_ROWS`, then `10`. This
  limits output, but some examples can still parse more rows.
- `CSV_PRINT_ROWS`: Fallback output limit used when `CSV_EXAMPLE_LIMIT` is not set.
- `CSV_EXAMPLE_FILTER_COLUMN`: Zero-based column index used by examples with a filter. It defaults to the first selected
  column, usually `0`.
- `CSV_EXAMPLE_FILTER_VALUE`: Match value used by examples with a filter. If it is not set, those examples do not apply
  the optional filter.

## Validation

```sh
bun run test
bun run lint
```

Install the repository's pre-push hook once per clone:

```sh
bun run hooks:install
```

Before every push, the hook builds the host's native libraries and the Linux x64 library, checks TypeScript and C++
formatting, runs the linters and type checker, runs the Bun test suite against the new host build, and runs the native
test suite. Building Linux x64 requires Docker to be installed and running. Run the same checks manually with
`bun run prepush`. The hook only validates the push. It does not publish packages.

### Full-file filtered materialization benchmark

This benchmark compares `csv.rows()` with `csv-parser` after `iconv-lite` decodes ISO-8859-1 input. Both commands parse
the complete `corpus/large/example.csv` file, apply equivalent column filters, and materialize every field in each
matching row. `@konstit/csv` applies the filters in native code; the `csv-parser` pipeline applies them to its
materialized JavaScript rows.

```sh
bun run bench:csv-parser:example
```

In the recorded `hyperfine -r 2` result, both commands produced 11,516,955 rows, 345,508,650 cells, and 1,808,786,228
characters from the 6,780,467,695-byte corpus:

| Implementation                   | Mean time |  Throughput |  Relative result |
| -------------------------------- | --------: | ----------: | ---------------: |
| `@konstit/csv` with `csv.rows()` |  45.223 s | 143.0 MiB/s | **2.32× faster** |
| `iconv-lite` + `csv-parser`      | 104.835 s |  61.7 MiB/s |         Baseline |

For this workload, `@konstit/csv` was 2.32× faster and completed in 56.9% less time. This result contains only two runs
on one machine, so use it as a measured workload result, not a universal performance guarantee. Full-file benchmarks
are long CPU-bound runs. Run them separately when comparing numbers. `hyperfine` must be available on `PATH`.

Small correctness/performance smoke:

```sh
bun run bench:regression-smoke
bun run bench:csv-parser:guard
```

## Setup

The repository and packaged release artifacts include native libraries for macOS 13+ ARM64/x64 and Linux x64. After
`bun install`, a fresh clone can run the Bun API, examples, and tests without compiling native code.

To rebuild the native libraries while developing C++ code:

```sh
bun install
bun run build:native
bun run stage:native
```

Native development requires CMake 3.25+, Ninja, Git, and Clang/AppleClang. CMake downloads pinned Highway and
unordered_dense sources during the first configure; native test configurations also download pinned Catch2 sources.
The downloaded sources are reused from `.cache/fetchcontent/`.

The native build writes architecture-specific outputs under `build/<platform>-<arch>/`. On macOS, `bun run build:native`
builds both `darwin-arm64` and `darwin-x64`. The FFI loader uses the tracked library under
`prebuilds/<platform>-<arch>/` by default. Set `CSV_NATIVE_LIBRARY_PATH` to an absolute library path to test a specific
local build. Target-specific and legacy build paths remain development fallbacks when no tracked prebuild exists.

On macOS, build and stage the Linux x64 prebuild with Docker Desktop:

```sh
bun run prebuilds:linux
```

The command caches an Ubuntu 24.04 image with Clang, CMake, and Ninja, mounts the repository at `/work`, builds the
existing `linux-x64-release` preset, and stages `prebuilds/linux-x64/libcsv_native.so`.

Tracked prebuilds are the native release inputs. Use the manual `Update prebuilds` workflow to rebuild and test all
targets. The workflow records the runner and toolchain, signs each binary with a GitHub build attestation, and creates one
`tracked-prebuilds-<commit>` artifact. Download that artifact, replace `prebuilds/`, and commit the result. Run this
workflow once before the first release that uses this policy because the existing binaries have no build attestations.

For a manual multi-host update without attestations, build and stage all targets, then record and verify the binaries and
native source inputs:

```sh
bun scripts/verify-native-package.ts --update-manifest
bun run verify:native-package
```

This local route produces checksum metadata only. Release publication requires the attested workflow output.

Normal CI verifies and tests the tracked Linux prebuild without compiling native code. A separate `Native source`
workflow builds and tests Linux x64 only when native source or build files change. Package release jobs do not rebuild
native code. Release publication also verifies that each committed binary was signed by the `Update prebuilds` workflow
and that its attested source inputs match the release commit.

The supported native targets are Clang C++20 builds for macOS ARM64/x64 and Linux x64. ARM64 requires NEON, and x64
requires AVX2. CPUs without those instruction sets are not supported. Target-specific configuration is available through
CMake presets, for example:

```sh
cmake --preset darwin-arm64-release
cmake --build --preset darwin-arm64-release
cmake --preset linux-x64-sanitize
cmake --build --preset linux-x64-sanitize
ctest --preset linux-x64-sanitize
```

If no matching library exists, imports fail with:

```txt
native library not found. Run: bun run build:native
```

Package assembly is separate from publication. `bun run build:package` verifies the committed native libraries, uses
Bun's transpiler for runtime JavaScript, and uses TypeScript for declarations. It does not rebuild native code. The
JavaScript and declarations are written to `dist/`. The `Package` workflow packs the tracked prebuilds once, attests the
tarball, and smoke-tests that exact file on Linux x64 and macOS ARM64/x64. Run the workflow with a release tag to create a
draft release, attach the tested tarball, publish the immutable release, and publish the same tarball through the protected
`npm-publish` environment. Leave the release tag empty to build and test without publishing.

Commit project changes before starting a release, then run one command from a clean `main` branch:

```sh
bun run release 0.4.2
```

The release script updates `package.json`, validates the project, creates the release commit and annotated tag, pushes
both atomically, starts the `Package` workflow, waits for it, and verifies the immutable GitHub release and npm version.
Use the explicit native mode after the native source commit is already on `origin/main`:

```sh
bun run release 0.4.2 --update-prebuilds
```

Native mode runs the manual `Update prebuilds` workflow for all supported targets, downloads and verifies its tracked
artifact, and commits the complete `prebuilds/` replacement before it continues with the normal release flow.

## License

MIT © 2026 KONSTIT ENGENHARIA E TECNOLOGIA LTDA. See [`LICENSE`](./LICENSE) and
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).
