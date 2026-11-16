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

Run `csv` without arguments to list the subcommands. Use the full subcommand name.
Help uses color in interactive terminals. Redirecting stdout, setting `NO_COLOR`, or using `TERM=dumb` produces plain text.

```sh
bunx @konstit/csv --help
bunx @konstit/csv count --help
bunx @konstit/csv lines --help
bunx @konstit/csv probe --help
bunx @konstit/csv help count
```

| Command              | Description                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `count <path>`       | Print the number of CSV records, including the header row.                                  |
| `lines <path>`       | Stream matching records as normalized UTF-8 CSV or newline-delimited JSON (NDJSON).         |
| `probe <path>`       | Inspect the file format and first record width. Use `--json` for a machine-readable report. |
| `completion <shell>` | Print a completion script for Bash, Zsh, Fish, or PowerShell.                               |

`count`, `lines`, and `probe` each take one input path. Use `csv help <command>`
or `csv <command> --help` for command options. Parsing stops when it reaches
`-h` or `--help`, so `csv count --help --unknown` prints help and exits successfully.
An unknown option before `--help` produces a usage error (exit code 2). The same applies to values
checked during argument parsing. For example, `csv lines data.csv --limit=-1 --help` exits with code 2.

Scalar options and flags may be supplied once per invocation. For example, `--limit 2 --limit 1`
exits with code 2. In scripts that append overrides, pass only the intended value.
`--expected-header` and the friendly `--where-*` options accept multiple occurrences.

## Shell completion

With the `csv` executable on your path, load the script for your shell to complete commands,
options, file paths, and values such as encodings and compression formats.

| Shell      | Load into the current session                                  |
| ---------- | -------------------------------------------------------------- |
| Bash       | `source <(csv completion bash)`                                |
| Zsh        | `source <(csv completion zsh)` after `compinit`                |
| Fish       | `csv completion fish \| source`                                |
| PowerShell | `csv completion powershell \| Out-String \| Invoke-Expression` |

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
The report displays the selected member name as UTF-8. Its extension supplies the same delimiter hint whether the
member was selected automatically or by name. For example, `parts.tsv` favors a tab when tabs and commas
both occur consistently.

Record endings can be LF, CRLF, CR, mixed, or absent. Newlines and separators inside quotes belong to their field.
A complete first record with no candidate separators has one column; an empty file has zero.
An inconclusive sample reports `undetermined` for the delimiter and includes the reason. The probe
distinguishes an empty payload, a sample with no complete non-empty record, records with no supported
separator, inconsistent separator counts, and tied candidates. Ties list the candidate characters.
Delimiter detection uses up to the first 128 complete non-empty records in the sample.

Pass `--delimiter` or `--encoding` independently. Both accept the same values and aliases as `count`
and `lines`, and both default to `auto`. The report marks each override as `(explicit)`. Passing `auto`
requests inference.
In this example, the probe decodes the sample as UTF-16LE and counts semicolons outside quotes to
measure the first record's width.

```sh
bunx @konstit/csv probe parts.txt --encoding utf-16le --delimiter ';'
```

`--json` prints one JSON object followed by a newline. For example, probing a file containing
`id;qty\n1;4\n` produces the following fields (shown indented).

```sh
bunx @konstit/csv probe parts.txt --delimiter ';' --json
```

```json
{
  "fileSizeBytes": 11,
  "sampleBytes": 11,
  "sampleReachedEof": true,
  "compression": "none",
  "zipEntry": null,
  "encoding": "utf8",
  "encodingSource": "inferred",
  "delimiter": ";",
  "delimiterSource": "explicit",
  "delimiterReason": null,
  "firstRecordColumns": 2,
  "lineEnding": "LF"
}
```

`fileSizeBytes` counts bytes on disk, including the entire archive for ZIP input. `sampleBytes` counts
up to 65,536 decompressed payload bytes before text decoding, including any byte-order mark.
`sampleReachedEof` is true when that sample covers the entire payload or selected ZIP member.
When detection is inconclusive, `delimiter` and `delimiterSource` are null and `delimiterReason`
contains the explanation. `firstRecordColumns` is null when the width is unknown. `zipEntry` is null
for non-ZIP input. An inconclusive delimiter still produces a successful report. Invalid options exit
with code 2, and input errors exit with code 1 and a diagnostic on stderr.

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
bunx @konstit/csv count data.csv --delimiter ',' --chunk-size 256KiB
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
| `--skip-rows <N>`                  | Skip the first N input records, including any header, before filtering. Defaults to 0.                                      |
| `--compression <format>`           | `auto` (default), `none`, `gzip`, `deflate`, `deflate-raw`, `brotli`, `zstd`, or `zip`.                                     |
| `--zip-entry <path>`               | ZIP entry to read; required with `--compression zip`. `*` selects the only file after ignoring directories and OS metadata. |
| `--max-compression-ratio <ratio>`  | Maximum ZIP expansion ratio, from 1 through 4,294,967,295. Defaults to 1,000.                                               |
| `--max-decompressed-bytes <bytes>` | Maximum decompressed ZIP output size as a positive safe integer. Defaults to 64 GiB.                                        |

`--skip-rows`, `--fixed-columns`, `--min-data-rows`, `--limit`, and `--max-compression-ratio` take base-10 integers.
For example, write `--limit 100` for one hundred records and `--min-data-rows 0` for a zero minimum.

`--chunk-size` and `--max-decompressed-bytes` accept a bare byte count or a size with a unit.
For example, `256KiB` equals `262144` bytes and `1.5MB` equals `1500000` bytes.
Units are case-sensitive: `B`, `KB`, `MB`, `GB`, `TB`, `KiB`, `MiB`, `GiB`, and `TiB`.
The result must be a whole number of bytes within the option's range.

`csv count --help` and `csv lines --help` list the encoding and compression choices.
Encoding aliases accepted by Bun also work, including `utf-8`, `cp1252`, and `sjis`.

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

Input delimiters must be one ASCII character. With a fallback encoding, decoding happens before parsing.
When given `--delimiter auto` and an explicit encoding, `count` and `lines` probe up to 64 KiB of the transcoded
UTF-8 bytes. Bun's decoder replaces malformed byte sequences and removes an initial UTF-16 byte-order mark
using its default streaming behavior.

## Projection

Pass all zero-based input indexes in one comma-separated `--columns` value, in the desired output order.

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

`count` and `lines` apply `--skip-rows N` before filtering. A quoted field containing
embedded newlines belongs to one input record. `lines --limit N` emits at most N matching
records across all chunks. Both options accept non-negative safe integers. A zero limit emits no records.

Strict validation starts at the first input record, including skipped rows, and stops when the output limit
is reached. Header checks use the original header. Skipped data rows count toward `--min-data-rows`,
which must be satisfied within the consumed prefix. With a zero limit, schema checks see an empty prefix.
The usual format detection and compression settings apply and can read ahead.

```sh
bunx @konstit/csv lines data.csv --strict --skip-rows 1 --limit 2
```
