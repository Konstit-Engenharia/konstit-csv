# Benchmarks

[README](../README.md) · [API guide](./api.md) · [Contributing](../CONTRIBUTING.md)

Run benchmarks from a repository checkout after following the [development setup](../CONTRIBUTING.md).
Full-file runs are CPU-bound; run them serially to avoid competing for CPU time when comparing results.

Results below were measured on November 18, 2026 at commit `f1db222`, on an Apple M4 with 16 GiB of RAM,
macOS 27.2 arm64 and Bun 1.4.4. All `@konstit/csv` timings used the tracked `prebuilds/darwin-arm64/libcsv_native.dylib`,
which matched a fresh local build byte for byte.
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

After one warmup, the five measured scans averaged **6.303 ± 0.353 s**, with a range of 6.014–6.722 s.

The producer inflates and CRC-checks the next chunk while the CSV parser scans the current one.
Copying each chunk into a reusable parser buffer keeps the background thread's memory independent of Bun's heap.

## ZIP file APIs and CLI

The table shows mean wall time over three full scans per workload. The ZIP reader overlaps decompression
with row and batch parsing. It uses system zlib on macOS arm64 and zlib-ng on Linux x64 and macOS x64.

| Workload              | Mean wall time ± σ | Output check                                                    |
| --------------------- | -----------------: | --------------------------------------------------------------- |
| CLI `count`           |    6.151 ± 0.060 s | 29,093,533 records                                              |
| Filtered `csv.rows()` |    6.736 ± 0.068 s | 11,516,955 rows, 345,508,650 cells and 1,808,786,228 characters |
| Filtered CLI `lines`  |    6.372 ± 0.015 s | Same SHA-256 digest on all three runs                           |

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
| `example.csv`     |      1 MiB |        10.43 s | 10.25–10.52 s |  620 MiB/s |
| `example.csv.zip` |      1 MiB |        10.40 s | 10.22–10.68 s |  622 MiB/s |
| `example.csv`     |    256 KiB |        10.52 s | 10.23–10.84 s |  615 MiB/s |
| `example.csv.zip` |    256 KiB |        10.39 s | 10.22–10.62 s |  622 MiB/s |

The ZIP mean was 0.03 s lower at 1 MiB and 0.13 s lower at 256 KiB. The measured ranges overlapped at both chunk sizes.
The native ZIP reader inflates and CRC-checks the next chunk while the current chunk is parsed and materialized.

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

| Implementation                   | Mean wall time ± σ |    Throughput | Mean peak RSS ± σ | Throughput vs. csv-parser |
| -------------------------------- | -----------------: | ------------: | ----------------: | ------------------------: |
| `@konstit/csv` with `csv.rows()` |    5.588 ± 0.091 s | 1,157.2 MiB/s |    96.9 ± 1.3 MiB |                    18.55× |
| `iconv-lite` + `csv-parser`      |  103.634 ± 1.095 s |    62.4 MiB/s |  156.9 ± 21.0 MiB |                     1.00× |

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

| Parser                 |  1k rows (ms) | 1k MiB/s |  10k rows (ms) | 10k MiB/s |  100k rows (ms) | 100k MiB/s |
| ---------------------- | ------------: | -------: | -------------: | --------: | --------------: | ---------: |
| `@konstit/csv batches` |  0.42 (1.43×) |    225.7 |   2.65 (1.54×) |     366.6 |   17.70 (1.48×) |      561.6 |
| `@konstit/csv rows`    |  0.30 (1.00×) |    323.1 |   1.72 (1.00×) |     565.6 |   12.00 (1.00×) |      828.8 |
| TurboCSV               |  0.62 (2.10×) |    153.9 |   5.51 (3.21×) |     176.4 |   47.91 (3.99×) |      207.5 |
| TurboCSV fast          |  0.39 (1.32×) |    245.6 |   3.36 (1.95×) |     289.7 |   28.20 (2.35×) |      352.6 |
| PapaParse              |  0.60 (2.02×) |    159.9 |   5.60 (3.26×) |     173.6 |   52.76 (4.40×) |      188.5 |
| csv-parse (sync)       | 3.01 (10.19×) |     31.7 | 21.30 (12.39×) |      45.6 | 211.19 (17.60×) |       47.1 |
| csv-parser             |  1.83 (6.21×) |     52.0 |  10.95 (6.37×) |      88.8 |  110.68 (9.23×) |       89.8 |
| fast-csv               | 3.37 (11.40×) |     28.3 | 24.62 (14.32×) |      39.5 | 241.95 (20.17×) |       41.1 |

The quoted customer fixtures were 17,159 bytes (100 rows) and 17,317,579 bytes (100k rows).

| Parser                 | 100 customers (ms) | 100 MiB/s | 100k customers (ms) | 100k MiB/s |
| ---------------------- | -----------------: | --------: | ------------------: | ---------: |
| `@konstit/csv batches` |       0.21 (2.41×) |      77.6 |       21.14 (1.44×) |      781.3 |
| `@konstit/csv rows`    |       0.09 (1.00×) |     187.0 |       14.70 (1.00×) |    1,123.5 |
| TurboCSV               |       0.09 (1.06×) |     177.1 |       52.78 (3.59×) |      312.9 |
| PapaParse              |       0.17 (1.95×) |      95.7 |       57.42 (3.91×) |      287.6 |
| csv-parse (sync)       |      0.88 (10.03×) |      18.6 |     312.42 (21.25×) |       52.9 |
| csv-parser             |       0.39 (4.49×) |      41.7 |     163.85 (11.15×) |      100.8 |
| fast-csv               |       0.45 (5.10×) |      36.6 |     312.50 (21.26×) |       52.8 |

`bun run bench -- comparison/libs-comparison.bench.ts` measures the same workloads with mitata.
The values below are mitata's mean milliseconds to read each file and consume its IDs.

| Parser                 | 1k rows | 10k rows | 100k rows | 100 customers | 100k customers |
| ---------------------- | ------: | -------: | --------: | ------------: | -------------: |
| `@konstit/csv batches` |   0.226 |     2.01 |     18.69 |         0.075 |          20.96 |
| `@konstit/csv rows`    |   0.199 |     1.39 |     13.36 |         0.074 |          15.18 |
| TurboCSV               |   0.477 |     4.77 |     47.74 |         0.074 |          51.59 |
| TurboCSV fast          |   0.254 |     2.48 |     26.48 |             — |              — |
| PapaParse              |   0.501 |     5.08 |     54.79 |         0.074 |          54.92 |
| csv-parse (sync)       |    2.04 |    20.49 |    209.52 |         0.346 |         310.20 |
| csv-parser             |    1.09 |    10.80 |    105.94 |         0.218 |         167.45 |
| fast-csv               |    2.19 |    22.73 |    232.82 |         0.321 |         323.93 |

`@konstit/csv rows` had the shortest time on all five fixtures in the five-read comparison and on four fixtures
in mitata. On the 100-customer fixture, the mitata means for PapaParse, TurboCSV, and `@konstit/csv rows`
all rounded to 0.074 ms.

## Run smaller benchmarks

The benchmark runner selects files by name, imports them, and runs `mitata` once:

```sh
bun run bench -- field-access.bench.ts
```

Benchmark files live under `bench/` and use the `*.bench.ts` suffix. They register benchmarks without calling `run()`.
Keep fixture generation and unrelated setup outside measured operations, and validate or consume results.

The field-access benchmark reads one field from 10,000 parsed rows 20 times (200,000 accesses per iteration).
Mean times were 13.74 ms for `fieldBytes`, 19.17 ms for `fieldBuffer`, and 14.80 ms for `fieldString`.

This command compares materialized rows, row views, and columnar batches on the same three columns of the checked-in fixture.

```sh
CSV_BENCH_FILE=corpus/bench/regression-smoke-25000-rows.csv CSV_BENCH_DELIMITER=, CSV_BENCH_COLUMNS=0,2,4 \
  bun run bench -- materialization-serial.bench.ts
```

Each case took one timed scan with 8 MiB chunks. All seven consumed 25,001 rows (including the header),
75,003 fields and 511,068 bytes of field content. Throughput uses the 1,022,473-byte file size.

| Access method                          | Wall time |  Throughput |
| -------------------------------------- | --------: | ----------: |
| `csv.rows()`                           |   3.56 ms | 273.6 MiB/s |
| Native `rowsInto()` with reused arrays |   3.45 ms | 282.4 MiB/s |
| Batch `scanColumns()`                  |   3.80 ms | 256.9 MiB/s |
| Batch column ranges                    |   4.94 ms | 197.4 MiB/s |
| Batch field bytes                      |   8.38 ms | 116.4 MiB/s |
| Row view bytes                         |   5.44 ms | 179.2 MiB/s |
| Row view strings                       |   6.20 ms | 157.2 MiB/s |

For small correctness and performance checks:

```sh
bun run bench:regression-smoke
bun run bench:csv-parser:guard
```

The smoke checks passed on the 25,000-data-row fixture. Medians of three samples:

| Operation                 | Median |
| ------------------------- | -----: |
| Materialize buffer        | 3.7 ms |
| Strict materialize buffer | 3.4 ms |
| Count file                | 3.2 ms |
| Count where equal         | 2.8 ms |
| Stream materialize file   | 4.2 ms |
| Projected filter file     | 2.8 ms |

The count guard returned 100,001 records (including the header) for both parsers. Over five samples,
the native median was 0.65 ms and the `csv-parser` median was 52.62 ms, a ratio of 80.46× against a 3× minimum.

## Select the native library

Benchmark scripts can rebuild native code, but the loader prefers the tracked library in `prebuilds/` over local
build outputs. Set `CSV_NATIVE_LIBRARY_PATH` to the absolute library path when measuring a particular local build.
See [native development](../CONTRIBUTING.md#develop-the-native-library) for build and staging instructions.

For custom inputs, see the [example and benchmark environment variables](../CONTRIBUTING.md#example-environment-variables).
Record the dataset, native library, runtime, machine, and repeated-run statistics alongside new measurements.
