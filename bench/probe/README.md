# Combined encoding and delimiter probe

This benchmark measures how long it takes to get the first batch of materialized rows when both the encoding and delimiter are inferred. The Highway case uses `csv.rows(path, { encoding: 'auto', delimiter: 'auto' })`. The reference supplies a TypeScript probe to the same row iterator.

Both implementations read the same prefix of up to 64 KiB, use the existing delimiter tie-breaking rules, and replay the buffered chunks into the same parser. The reference uses Bun's `isUtf8()` and the existing TypeScript delimiter probe. The Highway library validates UTF-8, checks for legacy encoding bytes and finds CSV punctuation in the same vector loop. It tracks quotes and stable separator counts for the first 128 complete nonempty rows. Encoding checks continue to the end of the sample.

See the [API guide](../../docs/api.md) for encoding selection and sample limits.

## Reproduce

From the repository root, build the parser and run the checks and benchmarks. The probe uses the Highway headers from that target's native build. The large Latin-1 case runs when `corpus/large/example.csv` is available. The benchmark generates the remaining files.

```sh
bun run build:native
bun run test test/format-probe.test.ts test/encoding-auto.test.ts
bun run bench -- first-batch.bench.ts
CSV_PROBE_REVERSE=1 bun run bench -- first-batch.bench.ts
```

The timer starts before option capture and file open and stops when the first `next()` resolves. It includes buffered I/O, probing, any transcoding, parsing and row materialization. Each iteration closes the iterator after stopping the timer. Before timing, the benchmark compares each complete first batch to a parse with an explicit encoding and delimiter. Those reads also warm the OS file cache.

## Apple M4 prototype results

Four serial passes on macOS arm64 with Bun 1.4.4 used the locally built release parser. The reference ran first in passes 1 and 4, and Highway ran first in passes 2 and 3. The table shows the median of the four per-pass medians in microseconds. The last column shows the range of time reductions within matched passes. Negative values mean Highway took longer.

| Input             | Read chunk | Existing probe + isUtf8 (µs) | Highway (µs) | Paired reduction |
| ----------------- | ---------: | ---------------------------: | -----------: | ---------------: |
| Latin-1 corpus    |     64 KiB |                        255.5 |        185.1 |   24.5% to 28.8% |
| Wide quoted UTF-8 |     64 KiB |                        197.1 |        160.1 |   18.2% to 24.3% |
| Latin-1 corpus    |      1 MiB |                      2,126.8 |      2,042.4 |    −1.6% to 5.2% |
| Wide quoted UTF-8 |      1 MiB |                      1,581.0 |      1,561.2 |     0.2% to 3.7% |
| Tiny ASCII file   |      1 MiB |                         58.6 |         57.7 |     0.9% to 4.7% |
| Short ASCII rows  |      1 MiB |                      8,256.5 |      8,302.0 |    −1.3% to 1.0% |
| Windows-1252      |      1 MiB |                     17,976.9 |     18,094.8 |    −3.5% to 1.8% |
| UTF-16LE TSV      |      1 MiB |                      5,040.9 |      5,105.8 |    −2.8% to 0.4% |

The 64 KiB cases benefited in every pass. With the default 1 MiB read, both implementations materialize a larger batch before the caller receives the first row. The measured effect was smaller and often changed sign across passes. The comparison measures the combined implementation, which also avoids allocating JavaScript delimiter counts for each probe row. It cannot attribute the gain to SIMD alone.

The [per-pass measurements](results-m4.csv) include invocation counts and medians. To select the locally built parser for a repeat run, set `CSV_NATIVE_LIBRARY_PATH` to the absolute path of the release library for the host.
