# Latin-1 batch parser benchmark

The candidate converts Latin-1 directly into the batch data arena and uses the
specialized Latin-1 parser for fixed-column batches. Unfinished rows still spill
into owned carry buffers. The shared deferred-row predicate and UTF-8 parsing
path retain their original behavior.

## Results

Measured against `de483072b93f38efa08c607a85796fcf9e106643` on an AMD EPYC 9V74
KVM environment with a four-CPU quota and 16 GiB memory limit. Benchmark processes
ran serially on virtual CPU 2. Toolchain: Bun 1.4.4, Clang 19.1.7, C++20,
Release `-O3 -mavx2 -fomit-frame-pointer -funroll-loops`, ThinLTO, no PGO.
Values are medians of three interleaved rounds of mean iteration times; percent
changes describe time reductions, not throughput increases.

| Latin-1 operation                                             | Input                     |  Original | Candidate | Less time |
| ------------------------------------------------------------- | ------------------------- | --------: | --------: | --------: |
| Native fixed batch, mixed ASCII/accents, 20 columns           | about 8 MiB, preloaded    | 64.462 ms | 42.517 ms |     34.0% |
| Streaming fixed batch, quotes/escapes/multiline, 3 columns    | about 4 MiB, 1 MiB chunks |  12.95 ms |   8.28 ms |     36.1% |
| Streaming fixed batch, long ASCII fields, 3 columns           | about 4 MiB, 1 MiB chunks |  1.190 ms |  0.868 ms |     27.0% |
| Streaming ordinary batch, quotes/escapes/multiline, 3 columns | about 4 MiB, 1 MiB chunks |   8.97 ms |   8.22 ms |      8.4% |

The native timer includes parser creation, parsing, batch allocation and disposal;
file loading happens before timing. Streaming tests include Bun/FFI and batch
lifetime, but neither disk I/O nor materializing JavaScript field strings/arrays.
Separate-process peak RSS, including Python and input storage, was essentially
unchanged: for example, 55,836 KiB for the mixed Latin-1 fixed-batch input in both
versions. Allocation counts were not instrumented.

UTF-8 controls showed small, phase-dependent differences. One seven-round native
projection series measured +1.52% time (paired bootstrap mean interval
[+0.55%, +2.34%]); an independent final seven-round comparison of the original,
direct-output-only and combined versions measured -0.81% for the same candidate
(interval [-2.31%, +0.53%]). Repeated Bun fixed/dense controls did not confirm a
slowdown. No systematic UTF-8 regression was established, and no UTF-8 speedup is
claimed. These controls cannot prove absence of regressions on other workloads.

A mixed-encoding projection suite also showed apparent Latin-1 slowdowns of up
to about 17%, with between-round variation reaching about 11%. They did not
reappear when the encodings were measured in separate processes. This identifies
sensitivity to benchmark order/state; it does not isolate whether allocation,
JIT state, cache layout or another mechanism caused it. The normalized shared
`parse` instruction sequence matched the original after relocation annotations
were removed. Hardware cycle counters were unavailable in this VM.

These are synthetic shared-cloud results. Production data, ARM/NEON and physical
storage throughput were not measured in this experiment.

## Reproduction

Use separate worktrees for the original revision and PR head, with identical
compiler, build flags and Bun version. In each worktree, install the declared
dependencies and run `bun run build:native`. Preserve the original Linux library
as `/tmp/konstit-csv-before/libcsv_native.so` before building the candidate.
The commands below are Linux x64 examples and do not modify tracked fixtures.

The Bun benchmark files generate their inputs before timing:

```sh
CSV_NATIVE_LIBRARY_PATH=/tmp/konstit-csv-before/libcsv_native.so bun run bench -- latin1-batches.bench.ts --filter 'quoted/latin1/(batch|fixed)/1048576'
bun run bench -- latin1-batches.bench.ts --filter 'quoted/latin1/(batch|fixed)/1048576'
bun run bench -- latin1-batches.bench.ts --filter '/utf8/'
bun run bench -- latin1-projection.bench.ts --filter '/utf8/'
bun run bench -- latin1-projection.bench.ts --filter '/latin1/'
```

The original library can be loaded into the candidate benchmark harness through
`CSV_NATIVE_LIBRARY_PATH`. For native executable comparisons, use
`LD_LIBRARY_PATH` pointing at a directory containing the original library, while
preserving any existing entries. Alternate version order across repeated runs.

Generate the mixed 20-column native input:

```sh
bun -e '
const row = Buffer.from("1;João ação café;" + "x;".repeat(17) + "SP\r\n", "latin1");
const input = Buffer.alloc(Math.floor(8 * 1024 * 1024 / row.length) * row.length);
input.fill(row);
await Bun.write("/tmp/konstit-csv-latin1.csv", input);
'
CSV_NATIVE_BENCH_COMPACT=1 CSV_NATIVE_BENCH_FILE=/tmp/konstit-csv-latin1.csv CSV_NATIVE_BENCH_BYTES=0 CSV_NATIVE_BENCH_FILTER='native latin1 (batch|fixed batch 20 columns)' bun run bench:native
```

The optional compact native mode uses the existing Mitata measurement function
with 12–200 samples and a 250 ms target. It skips the runner's optimized-out noop
measurement and emits scalar JSON statistics instead of enormous sample arrays.
Its fixed-batch cases require exactly 20 input columns; ordinary runner behavior
is unchanged. The default Bun runner and its sampling settings are unchanged.
