# Contributing

Thanks for contributing to `@konstit/csv`. This guide covers repository setup,
examples, validation, native development, prebuild maintenance, and releases.

Corpus downloads and benchmark methodology, commands, and results are documented
in [`docs/benchmarks.md`](docs/benchmarks.md).

## Development prerequisites

The package targets Bun `^1.4.0`. A fresh clone includes the tracked native
prebuilds, so the TypeScript API, examples, and tests can run without compiling
native code first.

Native development additionally requires:

- CMake 3.25 or newer
- Ninja
- Git
- Clang or AppleClang

CMake downloads the pinned Highway and `unordered_dense` sources on the first
configure. Native test configurations also download pinned Catch2 sources.
Fetched sources are reused from `.cache/fetchcontent/`.

## Set up a clone

```sh
bun install
```

The examples use `corpus/large/example.csv` by default. Follow the corpus setup
instructions in [`docs/benchmarks.md`](docs/benchmarks.md) before running an
example that uses that file.

## Run examples

The repository includes small programs for the public APIs:

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

### Example environment variables

Examples read semicolon-delimited input by default. Example-specific variables
take precedence over their benchmark counterparts, which makes it possible to
point a demo at a different file without changing benchmark configuration.

| Variable                    | Default or fallback                               | Purpose                                                                                           |
| --------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `CSV_EXAMPLE_FILE`          | `CSV_BENCH_FILE`, then `corpus/large/example.csv` | Input file for examples                                                                           |
| `CSV_BENCH_FILE`            | unset                                             | Benchmark input; also supplies the example input when `CSV_EXAMPLE_FILE` is unset                 |
| `CSV_EXAMPLE_DELIMITER`     | `CSV_BENCH_DELIMITER`, then `;`                   | Field delimiter for examples                                                                      |
| `CSV_BENCH_DELIMITER`       | unset                                             | Benchmark delimiter; also supplies the example delimiter when `CSV_EXAMPLE_DELIMITER` is unset    |
| `CSV_EXAMPLE_CHUNK_SIZE`    | `CSV_BENCH_CHUNK_SIZE`, then `8 MiB`              | Bytes read per example chunk                                                                      |
| `CSV_BENCH_CHUNK_SIZE`      | unset                                             | Benchmark chunk size; also supplies the example chunk size when `CSV_EXAMPLE_CHUNK_SIZE` is unset |
| `CSV_EXAMPLE_COLUMNS`       | `0,1,2`                                           | Comma-separated, zero-based columns selected by examples                                          |
| `CSV_EXAMPLE_LIMIT`         | `CSV_PRINT_ROWS`, then `10`                       | Maximum number of rows printed; some examples may parse more rows                                 |
| `CSV_PRINT_ROWS`            | unset                                             | Fallback print limit when `CSV_EXAMPLE_LIMIT` is unset                                            |
| `CSV_EXAMPLE_FILTER_COLUMN` | First selected column, usually `0`                | Zero-based source column used by filter examples                                                  |
| `CSV_EXAMPLE_FILTER_VALUE`  | unset                                             | Optional value for filter examples; unset disables the optional filter                            |

For corpus-specific encoding and download details, see the [benchmark guide](docs/benchmarks.md#prepare-the-datasets).

## Validate changes

Run the tests and static checks while developing:

```sh
bun run test
bun run lint
```

Install the repository's pre-push hook once per clone:

```sh
bun run hooks:install
```

The hook runs the full push validation. It builds the host's native libraries
and the Linux x64 library, checks TypeScript and C++ formatting, runs the
linters and type checker, runs the Bun test suite against the new host build,
and runs the native test suite. Linux x64 builds require Docker to be installed
and running. Run the same checks manually with:

```sh
bun run prepush
```

The hook validates the push; it does not publish packages.

## Develop the native library

To rebuild the native libraries for the current host while working on C++:

```sh
bun run build:native
bun run stage:native
```

The build writes architecture-specific outputs under
`build/<platform>-<arch>/`. On macOS, `bun run build:native` builds both
`darwin-arm64` and `darwin-x64`. The FFI loader uses the tracked library under
`prebuilds/<platform>-<arch>/` by default. Set `CSV_NATIVE_LIBRARY_PATH` to an
absolute library path when testing a specific local build. Target-specific and
legacy build paths remain development fallbacks when no tracked prebuild exists.

The supported native targets are Clang C++20 builds for macOS ARM64/x64 and
Linux x64. ARM64 requires NEON, and x64 requires AVX2; CPUs without those
instruction sets are not supported.

On macOS, build and stage the Linux x64 prebuild with Docker Desktop:

```sh
bun run prebuilds:linux
```

This command caches an Ubuntu 24.04 builder image with Clang, CMake, and Ninja,
mounts the repository at `/work`, builds the existing `linux-x64-release`
preset, and stages `prebuilds/linux-x64/libcsv_native.so`.

For direct target-specific builds, use the CMake presets. Use `ctest` to run the
native test suite after building with the sanitize preset:

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

## Maintain tracked prebuilds

Tracked prebuilds are the native inputs used to assemble releases. Use the
manual **Update prebuilds** workflow to rebuild and test every supported target.
The workflow records the runner and toolchain, signs each binary with a GitHub
build attestation, and creates one `tracked-prebuilds-<commit>` artifact.
Download that artifact, replace `prebuilds/`, and commit the result. Any prebuilds
without the required attestations must go through this workflow before release.

For a manual multi-host update without attestations, build and stage all
targets, then record and verify the binaries and native source inputs:

```sh
bun scripts/verify-native-package.ts --update-manifest
bun run verify:native-package
```

This local route produces checksum metadata only. Release publication requires
the attested workflow output.

Normal CI verifies and tests the tracked Linux prebuild without compiling native
code. A separate **Native source** workflow builds and tests Linux x64 only when
native source or build files change. Package release jobs do not rebuild native
code. Release publication verifies that each committed binary was signed by the
**Update prebuilds** workflow and that its attested source inputs match the
release commit.

## Build and release the package

Package assembly is separate from publication. `bun run build:package` verifies
the committed native libraries, uses Bun's transpiler for runtime JavaScript,
and uses TypeScript for declarations. It does not rebuild native code. The
JavaScript and declarations are written to `dist/`.

The **Package** workflow packs the tracked prebuilds once, attests the tarball,
and smoke-tests that exact file on Linux x64 and macOS ARM64/x64. Run the
workflow with a release tag to create a draft release, attach the tested
tarball, publish the immutable release, and publish the same tarball through the
protected `npm-publish` environment. Leave the release tag empty to build and
test without publishing.

Commit project changes before starting a release, then run the release command
from a clean `main` branch:

```sh
bun run release 0.4.2
```

The release script updates `package.json`, validates the project, creates the
release commit and annotated tag, pushes both atomically, starts the **Package**
workflow, waits for it, and verifies the immutable GitHub release and npm
version.

Use native mode only after the native source commit is already on
`origin/main`:

```sh
bun run release 0.4.2 --update-prebuilds
```

Native mode runs the manual **Update prebuilds** workflow for all supported
targets, downloads and verifies its tracked artifact, and commits the complete
`prebuilds/` replacement before continuing with the normal release flow.
