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

## Full-file filtered materialization

This benchmark compares `csv.rows()` with `csv-parser` after `iconv-lite` decodes ISO-8859-1 input. Both commands parse
the complete `corpus/large/example.csv` file, apply equivalent column filters, and materialize every field in each
matching row. `@konstit/csv` applies the filters in native code; the `csv-parser` pipeline applies them to its
materialized JavaScript rows.

```sh
bun run bench:csv-parser:example
```

`hyperfine` must be available on `PATH`. The recorded `hyperfine -r 2` result produced 11,516,955 rows, 345,508,650
cells, and 1,808,786,228 characters in both implementations from the 6,780,467,695-byte corpus:

| Implementation                   |     Mean time ± σ |  Throughput |  Mean memory ± σ |  Relative result |
| -------------------------------- | ----------------: | ----------: | ---------------: | ---------------: |
| `@konstit/csv` with `csv.rows()` |  16.446 ± 0.095 s | 393.2 MiB/s | 480.8 ± 15.8 MiB | **6.12× faster** |
| `iconv-lite` + `csv-parser`      | 100.665 ± 1.037 s |  64.2 MiB/s | 369.1 ± 10.9 MiB |         Baseline |

Throughput is calculated from the corpus size and mean wall time; σ is the standard deviation across runs.
For this workload, `@konstit/csv` was 6.12× faster and completed in 83.7% less time, with 30.3% higher mean memory usage.

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
count and sum of IDs. TurboCSV and `@konstit/csv` batches use row views. `@konstit/csv` rows materializes arrays.
Both `@konstit/csv` APIs run with all columns and with `columns: [0]` to select just the ID.
PapaParse, csv-parse (sync), and fast-csv parse header-keyed objects.
The following run used Bun 1.4.4 on an Apple M4 running macOS. Each time is the mean of the middle three of five runs
after one warmup per parser and file. The multiplier in parentheses is elapsed time divided by the fastest time for
that fixture.

| Parser                            | 1k rows (ms) | 1k MiB/s | 10k rows (ms) | 10k MiB/s | 100k rows (ms) | 100k MiB/s |
| --------------------------------- | -----------: | -------: | ------------: | --------: | -------------: | ---------: |
| `@konstit/csv batches`              | 0.54 (1.95×) | 177.1 | 2.49 (1.29×) | 390.4 | 21.88 (1.26×) | 454.4 |
| `@konstit/csv batches columns: [0]` | 0.42 (1.53×) | 225.2 | 1.99 (1.03×) | 489.3 | 17.33 (1.00×) | 573.6 |
| `@konstit/csv rows`                 | 0.93 (3.38×) | 102.1 | 6.14 (3.18×) | 158.5 | 56.84 (3.28×) | 174.9 |
| `@konstit/csv rows columns: [0]`    | 0.28 (1.00×) | 344.8 | 1.93 (1.00×) | 504.7 | 18.11 (1.04×) | 549.0 |
| TurboCSV                          | 1.19 (4.31×) | 79.9 | 5.41 (2.81×) | 179.6 | 43.59 (2.52×) | 228.1 |
| TurboCSV fast                     | 0.42 (1.54×) | 224.6 | 3.41 (1.77×) | 285.1 | 26.49 (1.53×) | 375.3 |
| PapaParse                         | 0.62 (2.25×) | 153.3 | 5.84 (3.03×) | 166.4 | 51.68 (2.98×) | 192.4 |
| csv-parse (sync)                  | 2.80 (10.13×) | 34.0 | 19.87 (10.31×) | 48.9 | 200.04 (11.54×) | 49.7 |
| fast-csv                          | 2.83 (10.21×) | 33.8 | 23.28 (12.09×) | 41.8 | 226.77 (13.08×) | 43.8 |

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
