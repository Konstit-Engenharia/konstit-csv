# Benchmarks

[README](../README.md) · [API guide](./api.md) · [Contributing](../CONTRIBUTING.md)

Run benchmarks from a repository checkout after following the [development setup](../CONTRIBUTING.md).
Full-file runs are CPU-bound; run them serially to avoid competing for CPU time when comparing results.

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
2,013,124,420 bytes and expands to 6,780,467,695 bytes. To compare revisions on macOS arm64, run this command
from each checkout with the same archive at the input path.

```sh
CSV_NATIVE_LIBRARY_PATH="$PWD/prebuilds/darwin-arm64/libcsv_native.dylib" \
  hyperfine --warmup 1 --runs 5 --show-output 'bun --silent src/cli.ts count corpus/large/example.csv.zip'
```

On an Apple M4 running macOS arm64 and Bun 1.4.4, both versions returned 29,093,533 records on every run.
The table shows the mean and sample standard deviation over five timed runs per version.

| ZIP count implementation  |        Wall time |        Peak RSS |
| ------------------------- | ---------------: | --------------: |
| Serial reader (`e169164`) | 12.454 ± 0.044 s | 103.3 ± 4.8 MiB |
| Two-buffer reader         |  8.421 ± 0.102 s |  47.9 ± 0.6 MiB |

The producer inflates and CRC-checks the next chunk while the CSV parser scans the current one.
Copying each chunk into a reusable parser buffer keeps the background thread's memory independent of Bun's heap.

## Full-file filtered materialization

Each command reads the complete ISO-8859-1 file at `corpus/large/example.csv` and materializes every field in rows
where column 5 equals `02` and column 19 differs from `EX` (zero-based indexes). The input has no header.

- `@konstit/csv` filters in native code and returns matching rows through `csv.rows()` with `reuseArrays: true`.
- `csv-parser` reads a stream decoded by `iconv-lite` and filters the resulting JavaScript rows.

```sh
bun run bench:csv-parser:example
```

`hyperfine` must be available on `PATH`. On an Apple M4 with 16 GiB of RAM running macOS arm64 and Bun 1.4.4,
each target ran twice in a fresh process. All four runs produced 11,516,955 rows, 345,508,650 cells, and
1,808,786,228 characters from the 6,780,467,695-byte corpus.

| Implementation                      |  Mean wall time ± σ |  Throughput |    Mean peak RSS ± σ | Throughput vs. csv-parser |
| ----------------------------------- | ------------------: | ----------: | -------------------: | ------------------------: |
| `@konstit/csv` with `csv.rows()`    |     7.303 ± 0.048 s | 885.5 MiB/s |       92.6 ± 0.4 MiB |                    13.81× |
| `iconv-lite` + `csv-parser`         |   100.847 ± 1.263 s |  64.1 MiB/s |      144.8 ± 2.7 MiB |                     1.00× |

Throughput is the original corpus size divided by mean wall time. σ is the sample standard deviation across runs.

These are recorded results from two runs on one machine, not a universal performance guarantee. Hardware, runtime,
encoding, filters, output representation, and input shape affect results. Re-run the comparison in your environment
before using these figures to make a performance decision.

## TurboCSV library comparison

```sh
bun run bench:libs-comparison
```

This ports [TurboCSV's file benchmark](https://github.com/bytebrujo/bun-csv/blob/d1217818230788a8a4f48ebc023a71cd1a57feb4/test/benchmark-comparison.ts).
It generates and reuses the 1k, 10k, and 100k row UTF-8 fixtures in `corpus/turbocsv/`. It also picks up the upstream
`customers-100.csv` and `customers-100000.csv` samples if placed there. TurboCSV fast mode runs only on unquoted inputs.

Each parser reads the file, excludes the header, and consumes the first field of each data row. Each run checks the row
count and sum of IDs. Both `@konstit/csv` cases use `columns: [0]` to select just the ID. TurboCSV and
`@konstit/csv` batches read the ID through row views. The `@konstit/csv` rows case uses `reuseArrays: true`.
PapaParse, csv-parse (sync), and fast-csv parse header-keyed objects.
The following run used Bun 1.4.4 on an Apple M4 running macOS. Each time is the mean of the middle three of five runs
after one warmup per parser and file. The multiplier in parentheses is elapsed time divided by the fastest time for
that fixture.

| Parser                | 1k rows (ms) | 1k MiB/s |  10k rows (ms) | 10k MiB/s |  100k rows (ms) | 100k MiB/s |
| --------------------- | -----------: | -------: | -------------: | --------: | --------------: | ---------: |
| `@konstit/csv batches` | 0.49 (1.24×) |    193.8 |   2.21 (1.12×) |     440.2 |   15.86 (1.00×) |      627.0 |
| `@konstit/csv rows`    | 0.55 (1.39×) |    173.7 |   1.97 (1.00×) |     494.3 |   16.00 (1.01×) |      621.4 |
| TurboCSV              | 0.61 (1.53×) |    157.5 |   5.40 (2.75×) |     179.9 |   45.37 (2.86×) |      219.1 |
| TurboCSV fast         | 0.40 (1.00×) |    240.9 |   3.27 (1.66×) |     297.4 |   27.81 (1.75×) |      357.5 |
| PapaParse             | 0.61 (1.54×) |    156.6 |   5.20 (2.64×) |     187.1 |   51.95 (3.28×) |      191.4 |
| csv-parse (sync)      | 2.95 (7.45×) |     32.4 | 19.72 (10.02×) |      49.3 | 203.28 (12.82×) |       48.9 |
| fast-csv              | 2.91 (7.35×) |     32.8 | 22.22 (11.29×) |      43.8 | 225.44 (14.22×) |       44.1 |

For mitata sampling of the same workloads, run `bun run bench -- comparison/libs-comparison.bench.ts`.

## Run smaller benchmarks

The benchmark runner selects files by name, imports them, and runs `mitata` once:

```sh
bun run bench -- field-access.bench.ts
```

Benchmark files live under `bench/` and use the `*.bench.ts` suffix. They register benchmarks without calling `run()`.
Keep fixture generation and unrelated setup outside measured operations, and validate or consume results.

This command compares materialized rows, row views, and columnar batches on the same three columns of the checked-in fixture.

```sh
CSV_BENCH_FILE=corpus/bench/regression-smoke-25000-rows.csv CSV_BENCH_DELIMITER=, CSV_BENCH_COLUMNS=0,2,4 \
  bun run bench -- materialization-serial.bench.ts
```

For small correctness and performance checks:

```sh
bun run bench:regression-smoke
bun run bench:csv-parser:guard
```

## Select the native library

Benchmark scripts can rebuild native code, but the loader prefers the tracked library in `prebuilds/` over local
build outputs. Set `CSV_NATIVE_LIBRARY_PATH` to the absolute library path when measuring a particular local build.
See [native development](../CONTRIBUTING.md#develop-the-native-library) for build and staging instructions.

For custom inputs, see the [example and benchmark environment variables](../CONTRIBUTING.md#example-environment-variables).
Record the dataset, native library, runtime, machine, and repeated-run statistics alongside new measurements.
