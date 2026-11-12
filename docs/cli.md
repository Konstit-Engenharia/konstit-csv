# Command-line interface

[← Back to the README](../README.md) · [TypeScript API](./api.md)

The `@konstit/csv` package includes a `csv` command for inspecting files,
counting records, and streaming filtered records. The examples use `bunx @konstit/csv`,
so they run without a global installation.

The examples in this guide use this small UTF-8 fixture. CSV columns are
zero-based, so `id` is column `0`, `name` is column `1`, and `state` is column
`2`.

```csv
id,name,state
1,Ada,SP
2,Grace,RJ
```

Save it as `data.csv` before trying the examples.

## Commands and help

```sh
bunx @konstit/csv --help
bunx @konstit/csv count --help
bunx @konstit/csv lines --help
bunx @konstit/csv probe --help
```

The top-level command has three subcommands:

| Command        | Description                                                                                         |
| -------------- | ----------------------------------------------------------------------------------------------------|
| `count <path>` | Print the number of CSV records, including the header row.                                          |
| `lines <path>` | Stream matching records as normalized UTF-8 CSV or newline-delimited JSON (NDJSON).                 |
| `probe <path>` | Print file size, encoding, delimiter, record endings, compression, and first record column count.   |

Each command accepts exactly one input path. The complete option list and
defaults are available from the command-specific help output.

## Inspect a file

```sh
bunx @konstit/csv probe data.csv
# File size: 34 B
# Encoding: utf8
# Delimiter: ","
# Line endings: LF
# Compression: none
# First record columns: 3
```

Size is the size of the regular file on disk. The other CSV details come from a sample of up to 64 KiB
after decompression. The probe recognizes the same stream compression signatures and filename hints as
`--compression auto`, plus plain files and ZIP archives. It reads the only file in a ZIP automatically after
ignoring directories and OS metadata. For archives containing multiple data files, pass `--zip-entry path/to/table.csv`.

Record endings can be LF, CRLF, CR, mixed, or absent. Newlines and separators inside quotes belong to their field.
A complete first record with no candidate separators has one column; an empty file has zero.
An inconclusive sample reports `undetermined` for the delimiter and `unknown` for details it cannot establish.

## Count records

`count` prints one integer. It counts every record, including a header row when
the file has one:

```sh
bunx @konstit/csv count data.csv
# 3
```

Use `--delimiter` to override detection, and `--chunk-size` to
choose the number of input bytes read per chunk. The chunk size must be from 1
through 67,108,864 bytes and defaults to 1 MiB.

```sh
bunx @konstit/csv count data.csv --delimiter ',' --chunk-size 262144
```

`count` also accepts the parser, compression, schema, projection, and filter
options described below. `--columns` validates the requested zero-based
indexes but does not change the count.

## Stream records

`lines` writes records as normalized UTF-8 CSV by default:

```sh
bunx @konstit/csv lines data.csv
```

The output uses comma delimiters, LF record endings, and standard quote
escaping. It is a new serialization of the parsed records, so it can differ
from the source delimiter, quoting, and line endings. Diagnostics are written
to stderr.

Use `--output-delimiter` to choose another safe ASCII delimiter:

```sh
bunx @konstit/csv lines data.csv --output-delimiter ';' > selected.csv
```

`--output-delimiter auto` is not supported. Output formatting does not change
the indexes used by filters; filters always refer to the original input
columns.

### NDJSON output

Pass `--json` to emit one JSON array of strings per record. This is NDJSON,
not one JSON document containing all records:

```sh
bunx @konstit/csv lines data.csv --json
```

```text
["id","name","state"]
["1","Ada","SP"]
["2","Grace","RJ"]
```

Embedded newlines and quotes are escaped according to JSON. `--json` writes
only NDJSON records to stdout and cannot be combined with
`--output-delimiter`.

## Input options

`count` and `lines` accept these file options:

| Option                             | Behavior                                                                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `--delimiter <value>`              | One safe ASCII character, or `auto` (the default) to infer the input delimiter.                                             |
| `--encoding <value>`               | A `Bun.Encoding` label, or `auto` (the default) to infer the input encoding.                                                |
| `--chunk-size <bytes>`             | Input chunk size from 1 through 67,108,864 bytes. Defaults to 1 MiB.                                                        |
| `--compression <format>`           | `auto` (default), `none`, `gzip`, `deflate`, `deflate-raw`, `brotli`, `zstd`, or `zip`.                                     |
| `--zip-entry <path>`               | ZIP entry to read; required with `--compression zip`. `*` selects the only file after ignoring directories and OS metadata. |
| `--max-compression-ratio <ratio>`  | Maximum ZIP expansion ratio, from 1 through 4,294,967,295. Defaults to 1,000.                                               |
| `--max-decompressed-bytes <bytes>` | Maximum decompressed ZIP output size as a positive safe integer. Defaults to 64 GiB.                                        |

`--delimiter auto` detects comma, tab, semicolon, pipe, colon, caret, or tilde
from a bounded prefix while ignoring separators inside quoted fields. Pass a fixed
delimiter for empty, single-column, ragged, or ambiguous input. To force the traditional
comma and UTF-8 settings, use `--delimiter ',' --encoding utf8`.

With automatic compression, `csv count data.csv.gz` decompresses gzip, `csv count data.csv` reads plain text,
and `csv count data.csv.zip` reads the archive's only data file after ignoring directories and OS metadata.
Plain CSV, TSV, and text MIME types are recognized, as are `.psv`, `.ssv`, and `.tab`. Use `--compression none`
to read a known plain file with an unrecognized name, or to read plain input from `/dev/stdin`.
The advanced byte-boundary helpers
in the TypeScript API require uncompressed input. ZIP input
supports stored and DEFLATE entries; encrypted entries and other compression
methods fail. ZIP options must be used together with `--compression zip` and a
non-empty `--zip-entry`.

Automatic ZIP selection skips files inside `__MACOSX/` or `.AppleDouble/` directories at any depth,
filenames starting with `._`, and `.DS_Store`, `Thumbs.db`, `ehthumbs.db`, `ehthumbs_vista.db`, and
`desktop.ini` (case-insensitive). Explicit entry names can select these files. Automatic selection requires
exactly one data file after these exclusions.
ZIP input requires a regular file because the native reader seeks through the archive's central directory.

For the repository's large Latin-1 corpus, follow the [dataset setup](./benchmarks.md#prepare-the-datasets),
then pass both the delimiter and encoding explicitly:

```sh
bunx @konstit/csv lines corpus/large/example.csv \
  --delimiter ';' --encoding latin1 --limit 10
bunx @konstit/csv count corpus/large/example.csv \
  --delimiter ';' --encoding latin1
```

Use `--encoding auto` with any input delimiter. For example, these commands detect the encoding of a
semicolon-separated file and infer both settings for an unknown export:

```sh
bunx @konstit/csv lines export.csv --encoding auto --delimiter ';'
bunx @konstit/csv count export.csv --encoding auto --delimiter auto
```

Both settings share a sample of up to 64 KiB after decompression. Automatic encoding covers UTF-8, Latin-1,
Windows-1252 and UTF-16 with a byte-order mark. The [API guide](./api.md) describes the legacy encoding heuristic.

For an export with a known encoding, pass its label explicitly. The decoder stays active
across input chunks, so a multibyte character split at a chunk boundary is decoded as one character:

```sh
bunx @konstit/csv lines windows-export.csv --encoding windows-1252
bunx @konstit/csv lines excel-export.csv --encoding utf-16le
bunx @konstit/csv lines japanese-export.csv --encoding shift_jis
```

`latin1`, `iso88591`, and `iso-8859-1` retain the parser's Latin-1 byte mapping. Use `windows-1252` when the source
uses the Windows mapping for bytes such as `0x80`.

Input delimiters must be one ASCII character. With a fallback encoding, decoding happens before parsing, and
`--delimiter auto` with an explicit encoding probes up to 64 KiB of the transcoded UTF-8 bytes. Bun's decoder replaces malformed byte sequences
and removes an initial UTF-16 byte-order mark using its default streaming behavior.

## Projection

`--columns` selects input columns and controls their output order. The indexes
remain zero-based and refer to the input, even when the output is reordered:

```sh
bunx @konstit/csv lines data.csv --columns 2,1,0
```

The header and rows are projected in the same order.

## Friendly filters

Friendly filter options use `column=value`, where `column` is a zero-based
input column index and the value is a string. Quote values that contain spaces
or shell metacharacters.

```sh
# state equals SP
bunx @konstit/csv lines data.csv --where-eq 2=SP

# state is SP or RJ; repeated values on one column form one IN filter
bunx @konstit/csv lines data.csv --where-in 2=SP --where-in 2=RJ

# name starts with A
bunx @konstit/csv lines data.csv --where-prefix 1=A

# name matches an RE2-compatible regular expression
bunx @konstit/csv lines data.csv --where-regex '1=/^A/i'
```

The available friendly options are:

| Option                                  | Meaning                                                                                            |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `--where-eq <column=value>`             | Match one exact value.                                                                             |
| `--where-neq <column=value>`            | Exclude one exact value.                                                                           |
| `--where-in <column=value>`             | Add a value to an `IN` filter. Repeat for multiple values on the same column.                      |
| `--where-noin <column=value>`           | Add a value to a `NOT IN` filter. Repeat for multiple values on the same column.                   |
| `--where-prefix <column=value>`         | Match values beginning with the supplied prefix.                                                   |
| `--where-regex <column=/pattern/flags>` | Match an RE2-compatible JavaScript regular expression. Supported flags are `i`, `m`, `s`, and `u`. |

Different friendly clauses are combined with AND. For example, this selects
Ada because both clauses must match:

```sh
bunx @konstit/csv lines data.csv \
  --where-prefix 1=A --where-eq 2=SP
```

The CLI exposes string filter values. Use the [TypeScript API](./api.md) for
advanced byte-boundary helpers and binary `Buffer` or `Uint8Array` operands.

## Advanced JSON filters

Use `--where <json>` when the filter needs nested boolean groups. The JSON
shape is specific to the CLI and is separate from the TypeScript filter API.
Groups use `all`, `any`, and `not`. Predicates contain a zero-based `column`
and exactly one of `equals`, `in`, `notEquals`, `notIn`, `startsWith`, or
`regex`:

```sh
bunx @konstit/csv lines data.csv \
  --where '{"all":[{"any":[{"column":2,"equals":"SP"},{"column":2,"equals":"RJ"}]},{"not":{"column":1,"startsWith":"G"}}]}'
```

The equivalent JSON filter can use `in` for the two state values:

```json
{
  "all": [
    { "column": 2, "in": ["SP", "RJ"] },
    { "not": { "column": 1, "startsWith": "G" } }
  ]
}
```

Regex predicates use an object with `source` and optional `flags` strings:

```json
{
  "column": 1,
  "regex": { "source": "^A", "flags": "i" }
}
```

JSON groups must be non-empty. Nested filters can be at most 128 levels deep.
Friendly clauses still combine with AND when they are used alongside
`--where`.

## Validation and early stopping

`--strict` enables RFC-style quote validation. Schema checks are available in
strict mode:

| Option                      | Behavior                                                                               |
| --------------------------- | -------------------------------------------------------------------------------------- |
| `--fixed-columns <count>`   | Require a positive integer number of fields in every row.                              |
| `--expected-header <value>` | Require an exact header value; repeat once per header column.                          |
| `--require-header`          | Reject empty input when a header row is required.                                      |
| `--min-data-rows <count>`   | Require at least this many data rows after the header; accepts a non-negative integer. |

The CLI requires `--strict` for `--fixed-columns`, even though that option
checks row field counts rather than header metadata. The header and data-row
checks (`--expected-header`, `--require-header`, and `--min-data-rows`) are
strict schema metadata and also require `--strict`. Strict mode cannot be
combined with filter options. `count --strict` likewise cannot use filters.

`lines --limit N` stops after matching output record `N`, numbered from 1. A
quoted field containing embedded newlines still counts as one record. The
header is counted only when it is emitted. Because early stopping validates
only the consumed input prefix, `--limit` cannot be combined with
`--min-data-rows`.

When `--strict` and `--limit` are used together, the input delimiter and encoding must be
fixed (defaulting to comma and UTF-8), compression defaults to `none` and must stay disabled, and
the chunk size must be omitted or set to `1`. The CLI uses one-byte chunks in
this mode to avoid read-ahead. A later input error can occur after earlier
records have already been written.

```sh
bunx @konstit/csv lines data.csv --strict --limit 2
```
