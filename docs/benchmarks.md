# Benchmarks

[README](../README.md) · [API guide](./api.md) · [Contributing](../CONTRIBUTING.md)

Run benchmarks from a repository checkout after following the [development setup](../CONTRIBUTING.md).
Full-file runs are CPU-bound; run them serially to avoid competing for CPU time when comparing results.

Results below were measured on November 16, 2026 at commit `bfb5042`, on an Apple M4 with 16 GiB of RAM,
macOS 27.2 arm64 and Bun 1.4.4. All `@konstit/csv` timings used the tracked `prebuilds/darwin-arm64/libcsv_native.dylib`.
The ZIP count, ZIP API and CLI, and full-file filtered comparisons used hyperfine 2.0.0.
Where shown, ± denotes one sample standard deviation.

## Prepare the datasets

The files in `corpus/large/` are too large to commit to the repository. Download and prepare them with Bun:

```sh
bun scripts/download-large-corpus.ts
```

The script requires `unzip` and skips files that already exist.

- `example.csv` is an approximately 6 GB ISO-8859-1-encoded Brazilian government data dump after extraction. The source is
  [Arquivos Receita](https://arquivos.receitafederal.gov.br/public.php/dav/files/gn672Ad4CF8N6TK/Dados/Cadastros/CNPJ/2026-08/Estabelecimentos0.zip).
- `formatted_addresses_tagged.random.tsv.gz` is part of the libpostal training data and remains compressed for the
  benchmarks. The source is the
  [Internet Archive](https://archive.org/download/libpostal-parser-training-data-20170304/formatted_addresses_tagged.random.tsv.gz).

For manual downloads, place both files in `corpus/large/` before running the benchmarks or examples that use them.
`example.csv` is semicolon-delimited and uses Latin-1. When reading it through the API, specify both settings:

```ts
import { csv } from '@konstit/csv';

for await (
  const batch of csv.rows('corpus/large/example.csv', {
    delimiter: ';',
    encoding: 'latin1',
    columns: [0, 1, 2],
  })
) {
  for (const row of batch) {
    console.log(row);
  }
}
```

This example demonstrates the input settings; it is not a benchmark. Printing every row adds substantial I/O work.

## Count a ZIP entry

The ZIP count benchmark uses `corpus/large/example.csv.zip`. Its DEFLATE-compressed `example.csv` entry occupies
2,013,124,420 bytes and expands to 6,780,467,695 bytes. Each scan counts 29,093,533 records.

```sh
CSV_NATIVE_LIBRARY_PATH="$PWD/prebuilds/darwin-arm64/libcsv_native.dylib" \
  hyperfine --warmup 1 --runs 5 --show-output 'bun --silent src/cli.ts count corpus/large/example.csv.zip'
```

After one warmup, the five measured scans averaged **5.756 ± 0.044 s** (range: 5.711–5.819 s).

The producer inflates and CRC-checks the next chunk while the CSV parser scans the current one.
Copying each chunk into a reusable parser buffer keeps the background thread's memory independent of Bun's heap.

## ZIP file APIs and CLI

The table shows mean wall time over three full scans per workload. The ZIP reader overlaps decompression
with row and batch parsing. It uses system zlib on macOS arm64 and zlib-ng on Linux x64 and macOS x64.

| Workload              | Mean wall time ± σ | Output check                                                    |
| --------------------- | -----------------: | --------------------------------------------------------------- |
| CLI `count`           |    5.869 ± 0.082 s | 29,093,533 records                                              |
| Filtered `csv.rows()` |    8.201 ± 0.010 s | 11,516,955 rows, 345,508,650 cells and 1,808,786,228 characters |
| Filtered CLI `lines`  |    6.325 ± 0.036 s | Same SHA-256 digest on all three runs                           |

The row benchmark uses the Latin-1 filters and materialization loop described below, reading the `example.csv`
entry in 1 MiB chunks. The CLI output benchmark includes the cost of hashing the projected records.
All three runs produced `81f8eee44ad0d5d85696f3cdc615444a8d2f77389fd7b1d0bda60bb0102aac26`.

```sh
set -o pipefail
bun bench/csv-parser/example-file.ts konstit-csv-zip
bun --silent src/cli.ts lines corpus/large/example.csv.zip --where-eq 19=EX --columns 0,19 | shasum -a 256
```

## Materialize every row from plain CSV and ZIP

```sh
bun run bench -- example-zip-materialization.bench.ts
CSV_BENCH_CHUNK_SIZE=262144 bun run bench -- example-zip-materialization.bench.ts
```

This benchmark reads `corpus/large/example.csv` and `corpus/large/example.csv.zip` through `csv.rows()`.
Both use automatic compression detection, a semicolon delimiter, Latin-1, `fixedColumns: 30` and
`reuseArrays: true`. Each scan consumes every field before advancing the batch and checks for 29,093,533 rows,
872,805,990 cells and 4,162,040,956 characters. The chunk size defaults to 1 MiB and can be set with
`CSV_BENCH_CHUNK_SIZE`.

At each chunk size, each input ran once to warm up and then 12 times for measurement.
The inputs ran serially, plain CSV first, with the filesystem cache left warm.
Throughput uses the 6,780,467,695-byte uncompressed size for both inputs.

| Input             | Chunk size | Mean wall time |       Min–max | Throughput |
| ----------------- | ---------: | -------------: | ------------: | ---------: |
| `example.csv`     |      1 MiB |        16.52 s | 16.20–16.78 s |  391 MiB/s |
| `example.csv.zip` |      1 MiB |        16.52 s | 15.81–17.02 s |  391 MiB/s |
| `example.csv`     |    256 KiB |        16.74 s | 16.32–17.78 s |  386 MiB/s |
| `example.csv.zip` |    256 KiB |        16.53 s | 15.86–17.77 s |  391 MiB/s |

At 1 MiB, plain CSV and ZIP had the same mean to the nearest 0.01 s. At 256 KiB the ZIP mean was
0.21 s lower, within the observed run-to-run variation. The native ZIP reader inflates and CRC-checks
the next chunk while the current chunk is parsed and materialized.

## Fixed column counts in materialized UTF-8 rows

`bun run bench -- fixed-columns-rows.bench.ts` reads the checked-in five-column UTF-8 fixture through `csv.rows()`.
Set `CSV_BENCH_FILE`, `CSV_BENCH_FIXED_COLUMNS`, and `CSV_BENCH_DELIMITER` to use another input.
The benchmark consumes every returned field and checks row, field and character totals.

The table compares the row offset lookup in `3e46ffc` with indexing by the validated width on an Apple M4
with Bun 1.4.4 and 1 MiB chunks. Times are medians of three process means per revision, with serial runs
in both orders. The narrow input contained 250,000 semicolon-delimited UTF-8 rows of the form
`0;João0;SP`. The wide input used the first 100,000 rows of `example.csv`, transcoded from Latin-1 to UTF-8.
The projection returns the last column followed by the first.

| Input and output      | Allocate, offsets | Allocate, stride | Reuse, offsets | Reuse, stride |
| --------------------- | ----------------: | ---------------: | -------------: | ------------: |
| Narrow, all 3 columns |          25.61 ms |         25.14 ms |       24.23 ms |      23.88 ms |
| Narrow, projected     |          20.25 ms |         19.03 ms |       18.25 ms |      18.00 ms |
| Wide, all 30 columns  |          52.10 ms |         49.40 ms |       48.37 ms |      46.61 ms |
| Wide, projected       |          29.14 ms |         28.72 ms |       27.39 ms |      27.66 ms |

## Full-file filtered materialization

Each command reads the complete ISO-8859-1 file at `corpus/large/example.csv` and materializes every field in rows
where column 5 equals `02` and column 19 differs from `EX` (zero-based indexes). The input has no header.

- `@konstit/csv` filters in native code and returns matching rows through `csv.rows()` with `reuseArrays: true`.
- `csv-parser` reads a stream decoded by `iconv-lite` and filters the resulting JavaScript rows.

```sh
bun run bench:csv-parser:example
```

`hyperfine` must be available on `PATH`. Each target ran twice, with a fresh process for each scan.
All four runs produced 11,516,955 rows, 345,508,650 cells, and
1,808,786,228 characters from the 6,780,467,695-byte corpus.

| Implementation                   | Mean wall time ± σ |  Throughput | Mean peak RSS ± σ | Throughput vs. csv-parser |
| -------------------------------- | -----------------: | ----------: | ----------------: | ------------------------: |
| `@konstit/csv` with `csv.rows()` |    7.852 ± 0.062 s | 823.5 MiB/s |    94.6 ± 0.6 MiB |                    13.13× |
| `iconv-lite` + `csv-parser`      |  103.115 ± 0.493 s |  62.7 MiB/s |  135.3 ± 11.1 MiB |                     1.00× |

Throughput is the original corpus size divided by mean wall time.

These are recorded results from two runs on one machine, not a universal performance guarantee. Hardware, runtime,
encoding, filters, output representation, and input shape affect results. Re-run the comparison in your environment
before using these figures to make a performance decision.

## TurboCSV library comparison

```sh
bun run bench:libs-comparison
```

This ports [TurboCSV's file benchmark](https://github.com/bytebrujo/bun-csv/blob/d1217818230788a8a4f48ebc023a71cd1a57feb4/test/benchmark-comparison.ts).
It generates and reuses the 1k, 10k, and 100k row UTF-8 fixtures in `corpus/turbocsv/`. The runner also picks up
[`customers-100.csv`](https://github.com/bytebrujo/bun-csv/blob/d1217818230788a8a4f48ebc023a71cd1a57feb4/samples/customers-100.csv)
and [Datablist's `customers-100000.csv`](https://www.datablist.com/learn/csv/download-sample-csv-files#customers-dataset)
if placed there. TurboCSV fast mode runs only on unquoted inputs.

Each parser reads the file, excludes the header, and consumes the first field of each data row. Each run checks the row
count and sum of IDs. Both `@konstit/csv` cases use `columns: [0]` to select just the ID. TurboCSV and
`@konstit/csv` batches read the ID through row views. The `@konstit/csv` rows case uses `reuseArrays: true`.
PapaParse, csv-parse (sync), csv-parser, and fast-csv parse header-keyed objects.
After one warmup per parser and file, the runner takes the mean of the middle three of five timed reads.
The multiplier in parentheses is elapsed time divided by the fastest time for that fixture.

| Parser                 | 1k rows (ms) | 1k MiB/s |  10k rows (ms) | 10k MiB/s |  100k rows (ms) | 100k MiB/s |
| ---------------------- | -----------: | -------: | -------------: | --------: | --------------: | ---------: |
| `@konstit/csv batches` | 0.47 (1.13×) |    204.1 |   2.49 (1.09×) |     391.2 |   17.62 (1.01×) |      564.3 |
| `@konstit/csv rows`    | 0.45 (1.10×) |    209.8 |   2.29 (1.00×) |     425.3 |   17.52 (1.00×) |      567.4 |
| TurboCSV               | 0.98 (2.37×) |     97.6 |   5.59 (2.44×) |     174.1 |   47.23 (2.70×) |      210.5 |
| TurboCSV fast          | 0.41 (1.00×) |    231.2 |   3.47 (1.52×) |     280.3 |   29.37 (1.68×) |      338.5 |
| PapaParse              | 0.62 (1.51×) |    152.9 |   5.66 (2.48×) |     171.7 |   53.94 (3.08×) |      184.3 |
| csv-parse (sync)       | 2.90 (7.04×) |     32.9 |  22.15 (9.69×) |      43.9 | 211.77 (12.09×) |       47.0 |
| csv-parser             | 1.82 (4.41×) |     52.4 |  10.90 (4.77×) |      89.2 |  106.15 (6.06×) |       93.7 |
| fast-csv               | 3.41 (8.26×) |     28.0 | 24.40 (10.67×) |      39.9 | 238.37 (13.60×) |       41.7 |

The quoted customer fixtures were 17,159 bytes (100 rows) and 17,317,579 bytes (100k rows).

| Parser                 | 100 customers (ms) | 100 MiB/s | 100k customers (ms) | 100k MiB/s |
| ---------------------- | -----------------: | --------: | ------------------: | ---------: |
| `@konstit/csv batches` |       0.14 (1.78×) |     117.3 |       23.34 (1.11×) |      707.5 |
| `@konstit/csv rows`    |       0.09 (1.18×) |     177.4 |       20.96 (1.00×) |      788.0 |
| TurboCSV               |       0.08 (1.00×) |     208.6 |       54.38 (2.59×) |      303.7 |
| PapaParse              |       0.16 (2.05×) |     101.8 |       57.09 (2.72×) |      289.3 |
| csv-parse (sync)       |      0.82 (10.45×) |      20.0 |     315.33 (15.05×) |       52.4 |
| csv-parser             |       0.39 (4.97×) |      42.0 |      162.89 (7.77×) |      101.4 |
| fast-csv               |       0.41 (5.21×) |      40.1 |     318.58 (15.20×) |       51.8 |

`bun run bench -- comparison/libs-comparison.bench.ts` measures the same workloads with mitata.
The values below are mitata's mean milliseconds to read each file and consume its IDs.

| Parser                 | 1k rows | 10k rows | 100k rows | 100 customers | 100k customers |
| ---------------------- | ------: | -------: | --------: | ------------: | -------------: |
| `@konstit/csv batches` |   0.233 |     2.09 |     18.49 |         0.075 |          20.53 |
| `@konstit/csv rows`    |   0.230 |     1.96 |     17.32 |         0.076 |          19.48 |
| TurboCSV               |   0.587 |     4.71 |     47.87 |         0.075 |          51.32 |
| TurboCSV fast          |   0.264 |     2.45 |     26.44 |             — |              — |
| PapaParse              |   0.499 |     5.15 |     53.41 |         0.074 |          54.34 |
| csv-parse (sync)       |    2.04 |    20.86 |    208.87 |         0.350 |         311.25 |
| csv-parser             |    1.10 |    10.59 |    108.62 |         0.216 |         164.12 |
| fast-csv               |    2.34 |    22.57 |    235.53 |         0.318 |         323.95 |

On the generated 1k-row file, TurboCSV fast had the shortest time in the five-read comparison,
while `@konstit/csv rows` had the shortest mitata mean. On both 100k-row files, `@konstit/csv rows`
had the shortest time in both runners.

## Run smaller benchmarks

The benchmark runner selects files by name, imports them, and runs `mitata` once:

```sh
bun run bench -- field-access.bench.ts
```

Benchmark files live under `bench/` and use the `*.bench.ts` suffix. They register benchmarks without calling `run()`.
Keep fixture generation and unrelated setup outside measured operations, and validate or consume results.

The field-access benchmark reads one field from 10,000 parsed rows 20 times (200,000 accesses per iteration).
Mean times were 14.66 ms for `fieldBytes`, 20.60 ms for `fieldBuffer`, and 15.60 ms for `fieldString`.

This command compares materialized rows, row views, and columnar batches on the same three columns of the checked-in fixture.

```sh
CSV_BENCH_FILE=corpus/bench/regression-smoke-25000-rows.csv CSV_BENCH_DELIMITER=, CSV_BENCH_COLUMNS=0,2,4 \
  bun run bench -- materialization-serial.bench.ts
```

Each case took one timed scan with 8 MiB chunks. All seven consumed 25,001 rows (including the header),
75,003 fields and 511,068 bytes of field content. Throughput uses the 1,022,473-byte file size.

| Access method                          | Wall time |  Throughput |
| -------------------------------------- | --------: | ----------: |
| `csv.rows()`                           |   7.42 ms | 131.4 MiB/s |
| Native `rowsInto()` with reused arrays |   6.91 ms | 141.1 MiB/s |
| Batch `scanColumns()`                  |   4.21 ms | 231.5 MiB/s |
| Batch column ranges                    |   5.30 ms | 184.1 MiB/s |
| Batch field bytes                      |   8.85 ms | 110.2 MiB/s |
| Row view bytes                         |   5.87 ms | 166.2 MiB/s |
| Row view strings                       |   6.93 ms | 140.7 MiB/s |

For small correctness and performance checks:

```sh
bun run bench:regression-smoke
bun run bench:csv-parser:guard
```

The smoke checks passed on the 25,000-data-row fixture. Medians of three samples:

| Operation                 | Median |
| ------------------------- | -----: |
| Materialize buffer        | 7.7 ms |
| Strict materialize buffer | 8.0 ms |
| Count file                | 3.7 ms |
| Count where equal         | 2.8 ms |
| Stream materialize file   | 8.8 ms |
| Projected filter file     | 3.0 ms |

The count guard returned 100,001 records (including the header) for both parsers. Over five samples,
the native median was 0.66 ms and the `csv-parser` median was 53.42 ms, a ratio of 81.30× against a 3× minimum.

## Select the native library

Benchmark scripts can rebuild native code, but the loader prefers the tracked library in `prebuilds/` over local
build outputs. Set `CSV_NATIVE_LIBRARY_PATH` to the absolute library path when measuring a particular local build.
See [native development](../CONTRIBUTING.md#develop-the-native-library) for build and staging instructions.

For custom inputs, see the [example and benchmark environment variables](../CONTRIBUTING.md#example-environment-variables).
Record the dataset, native library, runtime, machine, and repeated-run statistics alongside new measurements.
