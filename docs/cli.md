# Command-line interface

[← Back to the README](../README.md) · [TypeScript API](./api.md)

The `@konstit/csv` package includes a `csv` command for counting records and
streaming filtered records from a file. The examples use `bunx @konstit/csv`,
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
```

The top-level command has two subcommands:

| Command        | Description                                                                         |
| -------------- | ----------------------------------------------------------------------------------- |
| `count <path>` | Print the number of CSV records, including the header row.                          |
| `lines <path>` | Stream matching records as normalized UTF-8 CSV or newline-delimited JSON (NDJSON). |

Each command accepts exactly one input path. The complete option list and
defaults are available from the command-specific help output.

## Count records

`count` prints one integer. It counts every record, including a header row when
the file has one:

```sh
bunx @konstit/csv count data.csv
# 3
```

Use `--delimiter` when the input is not comma-delimited, and `--chunk-size` to
choose the number of input bytes read per chunk. The chunk size must be from 1
through 67,108,864 bytes and defaults to 1 MiB.

```sh
bunx @konstit/csv count data.csv --delimiter ',' --chunk-size 262144
```

`count` also accepts the parser, compression, schema, projection, and filter
options described below. `--columns` validates the requested zero-based
indexes but does not change the count. `--selected-columns` is an alias;
provide only one of the two options.

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

Both commands accept these file options:

| Option                             | Behavior                                                                               |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| `--delimiter <value>`              | One safe ASCII character, or `auto` for file operations. Defaults to `,`.              |
| `--encoding <value>`               | `utf8` (default), `latin1`, `iso88591`, or `iso-8859-1`.                               |
| `--chunk-size <bytes>`             | Input chunk size from 1 through 67,108,864 bytes. Defaults to 1 MiB.                   |
| `--compression <format>`           | `auto`, `gzip`, `deflate`, `deflate-raw`, `brotli`, `zstd`, or `zip`.                  |
| `--zip-entry <path>`               | ZIP entry to read; required with `--compression zip`. `*` selects the only file entry. |
| `--max-compression-ratio <ratio>`  | Maximum ZIP expansion ratio, from 1 through 4,294,967,295. Defaults to 1,000.          |
| `--max-decompressed-bytes <bytes>` | Maximum decompressed ZIP output size as a positive safe integer. Defaults to 64 GiB.   |

`--delimiter auto` detects comma, tab, semicolon, pipe, colon, caret, or tilde
from a bounded prefix while ignoring separators inside quoted fields. Detection
is available for file operations. Omit the option when comma is the input
delimiter.

Compressed input is streamed into the parser. The advanced byte-boundary helpers
in the TypeScript API require uncompressed input. ZIP input
supports stored and DEFLATE entries; encrypted entries and other compression
methods fail. ZIP options must be used together with `--compression zip` and a
non-empty `--zip-entry`.

For the repository's large Latin-1 corpus, follow the [dataset setup](./benchmarks.md#prepare-the-datasets),
then pass both the delimiter and encoding explicitly:

```sh
bunx @konstit/csv lines corpus/large/example.csv \
  --delimiter ';' --encoding latin1 --limit 10
bunx @konstit/csv count corpus/large/example.csv \
  --delimiter ';' --encoding latin1
```

## Projection

`--columns` selects input columns and controls their output order. The indexes
remain zero-based and refer to the input, even when the output is reordered:

```sh
bunx @konstit/csv lines data.csv --columns 2,1,0
```

The header and rows are projected in the same order. `--selected-columns` is a
legacy alias for `--columns`; the two options cannot be combined.

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

When `--strict` and `--limit` are used together, the input delimiter must be
fixed, compressed input (including `--compression auto`) is not supported, and
the chunk size must be omitted or set to `1`. The CLI uses one-byte chunks in
this mode to avoid read-ahead. A later input error can occur after earlier
records have already been written.

```sh
bunx @konstit/csv lines data.csv --strict --limit 2
```
