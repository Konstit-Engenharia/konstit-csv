import {
  dlopen,
  type Pointer,
  suffix,
} from 'bun:ffi';
import {
  existsSync,
  statSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';

export type { Pointer } from 'bun:ffi';
export { toArrayBuffer } from 'bun:ffi';

/**
 * Address of a native CSV resource, represented by Bun FFI as a pointer or bigint.
 *
 * A handle must originate from the matching native CSV ABI and remain valid for
 * the operation using it. Wrapping a batch handle in `NativeCsvBatch` transfers
 * responsibility for releasing that resource to the batch.
 */
export type NativePointer = Pointer | bigint;

// Keep storage behind the zero-length view so FFI receives a stable buffer object while buffer_length reports zero.
const EMPTY_BUFFER_STORAGE = new Uint8Array(1);
export const EMPTY_BUFFER = EMPTY_BUFFER_STORAGE.subarray(0, 0);
// Native projection and filter-offset APIs require a non-null pointer even when their element count is zero.
export const EMPTY_U32 = new Uint32Array(1);
export const DEFAULT_CHUNK_SIZE = 1024 * 1024;

const CSV_SYMBOLS = {
  // C signature:
  // uint32_t csv_probe_format(const uint8_t* bytes, uint32_t size, bool eof, bool infer_encoding, uint32_t* output);
  csv_probe_format: {
    args: [
      'buffer', // const uint8_t* bytes
      'u32', // uint32_t size
      'bool', // bool eof
      'bool', // bool infer_encoding
      'ptr', // uint32_t* output (eight elements, or null to skip delimiter detection)
    ],
    returns: 'u32',
  },
  // C signature:
  // int csv_runtime_supports_avx2();
  csv_runtime_supports_avx2: {
    args: [],
    returns: 'int',
  },
  // C signature:
  // void* csv_parser_create(int encoding, uint8_t delimiter);
  csv_parser_create: {
    args: ['int', 'u8'],
    returns: 'ptr',
  },
  // C signature:
  // void csv_parser_destroy(void* parser);
  csv_parser_destroy: {
    args: ['ptr'],
    returns: 'void',
  },
  // C signature:
  // void csv_parser_reset(void* parser);
  csv_parser_reset: {
    args: ['ptr'],
    returns: 'void',
  },
  // C signature:
  // void* csv_parser_write_batch(void* parser, const uint8_t* data, uint64_t len, bool final);
  csv_parser_write_batch: {
    args: ['ptr', 'buffer', 'buffer_length', 'bool'],
    returns: 'ptr',
  },
  // C signature:
  // void* csv_parser_finish_batch(void* parser);
  csv_parser_finish_batch: {
    args: ['ptr'],
    returns: 'ptr',
  },
  // C signature:
  // void* csv_parser_write_strict_batch(void* parser, const uint8_t* data, uint64_t len, bool final);
  csv_parser_write_strict_batch: {
    args: ['ptr', 'buffer', 'buffer_length', 'bool'],
    returns: 'ptr',
  },
  // C signature:
  // void* csv_parser_finish_strict_batch(void* parser);
  csv_parser_finish_strict_batch: {
    args: ['ptr'],
    returns: 'ptr',
  },
  // C signature:
  // void* csv_parser_write_fixed_batch(void* parser, const uint8_t* data, uint64_t len, bool final,
  //                                    uint32_t fixed_columns);
  csv_parser_write_fixed_batch: {
    args: ['ptr', 'buffer', 'buffer_length', 'bool', 'u32'],
    returns: 'ptr',
  },
  // C signature:
  // void* csv_parser_finish_fixed_batch(void* parser, uint32_t fixed_columns);
  csv_parser_finish_fixed_batch: {
    args: ['ptr', 'u32'],
    returns: 'ptr',
  },
  // C signature:
  // void* csv_parser_write_strict_fixed_batch(void* parser, const uint8_t* data, uint64_t len, bool final,
  //                                           uint32_t fixed_columns);
  csv_parser_write_strict_fixed_batch: {
    args: ['ptr', 'buffer', 'buffer_length', 'bool', 'u32'],
    returns: 'ptr',
  },
  // C signature:
  // void* csv_parser_finish_strict_fixed_batch(void* parser, uint32_t fixed_columns);
  csv_parser_finish_strict_fixed_batch: {
    args: ['ptr', 'u32'],
    returns: 'ptr',
  },
  // C signature:
  // void* csv_parser_write_projected_batch(void* parser, const uint8_t* data, uint64_t len, bool final,
  //                                        bool has_projection, const uint32_t* selected_columns,
  //                                        uint64_t selected_columns_len, bool has_filter,
  //                                        uint32_t filter_column, const uint8_t* filter_value,
  //                                        uint64_t filter_value_len);
  csv_parser_write_projected_batch: {
    args: ['ptr', 'buffer', 'buffer_length', 'bool', 'bool', 'buffer', 'u64', 'bool', 'u32', 'buffer', 'buffer_length'],
    returns: 'ptr',
  },
  // C signature:
  // void* csv_parser_finish_projected_batch(void* parser, bool has_projection,
  //                                         const uint32_t* selected_columns, uint64_t selected_columns_len,
  //                                         bool has_filter, uint32_t filter_column,
  //                                         const uint8_t* filter_value, uint64_t filter_value_len);
  csv_parser_finish_projected_batch: {
    args: ['ptr', 'bool', 'buffer', 'u64', 'bool', 'u32', 'buffer', 'buffer_length'],
    returns: 'ptr',
  },
  // C signature:
  // void* csv_parser_write_projected_batch_where_all(
  //     void* parser, const uint8_t* data, uint64_t len, bool final, bool has_projection,
  //     const uint32_t* selected_columns, uint64_t selected_columns_len,
  //     const uint32_t* filter_descriptors, uint64_t filter_count, const uint8_t* values_data,
  //     uint64_t values_data_len, const uint32_t* value_offsets, uint64_t total_value_count);
  csv_parser_write_projected_batch_where_all: {
    args: [
      'ptr',
      'buffer',
      'buffer_length',
      'bool',
      'bool',
      'buffer',
      'u64',
      'buffer',
      'u64',
      'buffer',
      'buffer_length',
      'buffer',
      'u64',
    ],
    returns: 'ptr',
  },
  // C signature:
  // void* csv_parser_finish_projected_batch_where_all(
  //     void* parser, bool has_projection, const uint32_t* selected_columns,
  //     uint64_t selected_columns_len, const uint32_t* filter_descriptors, uint64_t filter_count,
  //     const uint8_t* values_data, uint64_t values_data_len, const uint32_t* value_offsets,
  //     uint64_t total_value_count);
  csv_parser_finish_projected_batch_where_all: {
    args: ['ptr', 'bool', 'buffer', 'u64', 'buffer', 'u64', 'buffer', 'buffer_length', 'buffer', 'u64'],
    returns: 'ptr',
  },
  // C signature:
  // void csv_batch_destroy(void* batch);
  csv_batch_destroy: {
    args: ['ptr'],
    returns: 'void',
  },
  // C signature:
  // uint64_t csv_batch_row_count(void* batch);
  csv_batch_row_count: {
    args: ['ptr'],
    returns: 'u64',
  },
  // C signature:
  // uint64_t csv_batch_total_fields(void* batch);
  csv_batch_total_fields: {
    args: ['ptr'],
    returns: 'u64',
  },
  // C signature:
  // uint64_t csv_batch_data_len(void* batch);
  csv_batch_data_len: {
    args: ['ptr'],
    returns: 'u64',
  },
  // C signature:
  // const uint8_t* csv_batch_data_ptr(void* batch);
  csv_batch_data_ptr: {
    args: ['ptr'],
    returns: 'ptr',
  },
  // C signature:
  // const uint64_t* csv_batch_row_offsets_ptr(void* batch);
  csv_batch_row_offsets_ptr: {
    args: ['ptr'],
    returns: 'ptr',
  },
  // C signature:
  // const uint64_t* csv_batch_field_offsets_ptr(void* batch);
  csv_batch_field_offsets_ptr: {
    args: ['ptr'],
    returns: 'ptr',
  },
  // C signature:
  // uint64_t csv_batch_count_where_equals(void* batch, uint32_t column, const uint8_t* value, uint64_t value_len);
  csv_batch_count_where_equals: {
    args: ['ptr', 'u32', 'buffer', 'buffer_length'],
    returns: 'u64',
  },
  // C signature:
  // uint64_t csv_parser_write_count(void* parser, const uint8_t* data, uint64_t len, bool final);
  csv_parser_write_count: {
    args: ['ptr', 'buffer', 'buffer_length', 'bool'],
    returns: 'u64',
  },
  // C signature:
  // uint64_t csv_parser_count_trusted_newlines(const uint8_t* data, uint64_t len);
  csv_parser_count_trusted_newlines: {
    args: ['buffer', 'buffer_length'],
    returns: 'u64',
  },
  // C signature:
  // const char* csv_regex_validate(const uint8_t* pattern, uint64_t pattern_len);
  csv_regex_validate: {
    args: ['buffer', 'buffer_length'],
    returns: 'cstring',
  },
  // C signature:
  // void* csv_parser_find_split_offsets(const char* path, uint64_t shard_count, uint8_t delimiter);
  csv_parser_find_split_offsets: {
    args: ['cstring', 'u64', 'u8'],
    returns: 'ptr',
  },
  // C signature:
  // void csv_split_offsets_batch_destroy(void* batch);
  csv_split_offsets_batch_destroy: {
    args: ['ptr'],
    returns: 'void',
  },
  // C signature:
  // uint64_t csv_split_offsets_batch_count(void* batch);
  csv_split_offsets_batch_count: {
    args: ['ptr'],
    returns: 'u64',
  },
  // C signature:
  // const uint64_t* csv_split_offsets_batch_ptr(void* batch);
  csv_split_offsets_batch_ptr: {
    args: ['ptr'],
    returns: 'ptr',
  },
  // C signature:
  // uint64_t csv_parser_finish_count(void* parser);
  csv_parser_finish_count: {
    args: ['ptr'],
    returns: 'u64',
  },
  // C signature:
  // uint64_t csv_parser_write_count_where_all(
  //     void* parser, const uint8_t* data, uint64_t len, bool final,
  //     const uint32_t* filter_descriptors, uint64_t filter_count, const uint8_t* values_data,
  //     uint64_t values_data_len, const uint32_t* value_offsets, uint64_t total_value_count);
  csv_parser_write_count_where_all: {
    args: ['ptr', 'buffer', 'buffer_length', 'bool', 'buffer', 'u64', 'buffer', 'buffer_length', 'buffer', 'u64'],
    returns: 'u64',
  },
  // C signature:
  // uint64_t csv_parser_finish_count_where_all(
  //     void* parser, const uint32_t* filter_descriptors, uint64_t filter_count,
  //     const uint8_t* values_data, uint64_t values_data_len, const uint32_t* value_offsets,
  //     uint64_t total_value_count);
  csv_parser_finish_count_where_all: {
    args: ['ptr', 'buffer', 'u64', 'buffer', 'buffer_length', 'buffer', 'u64'],
    returns: 'u64',
  },
  // C signature:
  // uint64_t csv_parser_write_count_where_equals(void* parser, const uint8_t* data, uint64_t len, bool final,
  //                                              uint32_t filter_column, const uint8_t* filter_value,
  //                                              uint64_t filter_value_len);
  csv_parser_write_count_where_equals: {
    args: ['ptr', 'buffer', 'buffer_length', 'bool', 'u32', 'buffer', 'buffer_length'],
    returns: 'u64',
  },
  // C signature:
  // uint64_t csv_parser_finish_count_where_equals(void* parser, uint32_t filter_column,
  //                                               const uint8_t* filter_value, uint64_t filter_value_len);
  csv_parser_finish_count_where_equals: {
    args: ['ptr', 'u32', 'buffer', 'buffer_length'],
    returns: 'u64',
  },
  // C signature:
  // uint64_t csv_parser_write_count_where_in(void* parser, const uint8_t* data, uint64_t len, bool final,
  //                                          uint32_t filter_column, const uint8_t* values_data,
  //                                          uint64_t values_data_len, const uint32_t* value_offsets,
  //                                          uint64_t value_count);
  csv_parser_write_count_where_in: {
    args: ['ptr', 'buffer', 'buffer_length', 'bool', 'u32', 'buffer', 'buffer_length', 'buffer', 'u64'],
    returns: 'u64',
  },
  // C signature:
  // uint64_t csv_parser_finish_count_where_in(void* parser, uint32_t filter_column,
  //                                           const uint8_t* values_data, uint64_t values_data_len,
  //                                           const uint32_t* value_offsets, uint64_t value_count);
  csv_parser_finish_count_where_in: {
    args: ['ptr', 'u32', 'buffer', 'buffer_length', 'buffer', 'u64'],
    returns: 'u64',
  },
  // C signature:
  // uint64_t csv_parser_write_count_where_starts_with(void* parser, const uint8_t* data, uint64_t len,
  //                                                   bool final, uint32_t filter_column,
  //                                                   const uint8_t* filter_value, uint64_t filter_value_len);
  csv_parser_write_count_where_starts_with: {
    args: ['ptr', 'buffer', 'buffer_length', 'bool', 'u32', 'buffer', 'buffer_length'],
    returns: 'u64',
  },
  // C signature:
  // uint64_t csv_parser_finish_count_where_starts_with(void* parser, uint32_t filter_column,
  //                                                    const uint8_t* filter_value, uint64_t filter_value_len);
  csv_parser_finish_count_where_starts_with: {
    args: ['ptr', 'u32', 'buffer', 'buffer_length'],
    returns: 'u64',
  },
  // C signature:
  // void* csv_zip_reader_create(const char* path, const uint8_t* entry_name, uint64_t entry_name_len,
  //                             uint64_t maximum_output_size, uint32_t maximum_compression_ratio);
  csv_zip_reader_create: {
    args: ['cstring', 'buffer', 'buffer_length', 'u64', 'u32'],
    returns: 'ptr',
  },
  // C signature:
  // void csv_zip_reader_destroy(void* reader);
  csv_zip_reader_destroy: {
    args: ['ptr'],
    returns: 'void',
  },
  // C signature:
  // void csv_zip_reader_enable_read_ahead(void* reader, uint32_t chunk_size);
  csv_zip_reader_enable_read_ahead: {
    args: ['ptr', 'u32'],
    returns: 'void',
  },
  // C signature:
  // uint64_t csv_zip_reader_read(void* reader, uint8_t* output, uint64_t output_capacity);
  csv_zip_reader_read: {
    args: ['ptr', 'buffer', 'buffer_length'],
    returns: 'u64',
  },
  // C signature:
  // int csv_zip_reader_status(void* reader);
  csv_zip_reader_status: {
    args: ['ptr'],
    returns: 'int',
  },
  // C signature:
  // const char* csv_zip_reader_last_error(void* reader);
  csv_zip_reader_last_error: {
    args: ['ptr'],
    returns: 'cstring',
  },
  // C signature:
  // const char* csv_parser_last_error(void* parser);
  csv_parser_last_error: {
    args: ['ptr'],
    returns: 'cstring',
  },
  // C signature:
  // bool csv_parser_prepare(void* parser, bool has_projection, const uint32_t* selected_columns,
  //                         uint64_t selected_columns_len, const uint32_t* filter_descriptors,
  //                         uint64_t filter_count, const uint8_t* values_data, uint64_t values_data_len,
  //                         const uint32_t* value_offsets, uint64_t total_value_count);
  csv_parser_prepare: {
    args: ['ptr', 'bool', 'buffer', 'u64', 'buffer', 'u64', 'buffer', 'buffer_length', 'buffer', 'u64'],
    returns: 'bool',
  },
  // C signature:
  // void* csv_parser_write_prepared_batch(void* parser, const uint8_t* data, uint64_t len, bool final);
  csv_parser_write_prepared_batch: {
    args: ['ptr', 'buffer', 'buffer_length', 'bool'],
    returns: 'ptr',
  },
  // C signature:
  // uint64_t csv_parser_write_prepared_count(void* parser, const uint8_t* data, uint64_t len, bool final);
  csv_parser_write_prepared_count: {
    args: ['ptr', 'buffer', 'buffer_length', 'bool'],
    returns: 'u64',
  },
  // C signature:
  // void* csv_parser_create_latin1_rows(uint8_t delimiter);
  csv_parser_create_latin1_rows: {
    args: ['u8'],
    returns: 'ptr',
  },
  // C signature:
  // void* csv_parser_create_latin1_rows_with_quoted_spans(uint8_t delimiter);
  csv_parser_create_latin1_rows_with_quoted_spans: { args: ['u8'], returns: 'ptr' },
  // C signature:
  // const uint8_t* csv_batch_quoted_rows_ptr(void* batch);
  csv_batch_quoted_rows_ptr: { args: ['ptr'], returns: 'ptr' },
  // C signature:
  // void* csv_parser_create_latin1_rows_with_fixed_columns(uint8_t delimiter, uint32_t fixed_columns);
  csv_parser_create_latin1_rows_with_fixed_columns: {
    args: ['u8', 'u32'],
    returns: 'ptr',
  },
} as const;

export const native = dlopen(resolveNativeLibraryPath(), CSV_SYMBOLS);

export function latin1RowsParser(fixedColumns: number | undefined): (delimiter: number) => NativePointer | null {
  if (fixedColumns !== undefined) {
    return (delimiter) => native.symbols.csv_parser_create_latin1_rows_with_fixed_columns(delimiter, fixedColumns);
  }
  return native.symbols.csv_parser_create_latin1_rows_with_quoted_spans;
}

function resolveNativeLibraryPath(): string {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const target = `${process.platform}-${process.arch}`;
  const configuredPath = process.env['CSV_NATIVE_LIBRARY_PATH'];
  const libraryPath = configuredPath === undefined
    ? requireNativeLibraryPath(nativeLibraryCandidates(root, target, suffix))
    : requireConfiguredNativeLibraryPath(configuredPath);

  return resolve(libraryPath);
}

export function requireConfiguredNativeLibraryPath(configuredPath: string): string {
  if (configuredPath.length === 0) {
    throw new Error('CSV_NATIVE_LIBRARY_PATH must not be empty');
  }
  if (!isAbsolute(configuredPath)) {
    throw new Error('CSV_NATIVE_LIBRARY_PATH must be an absolute path');
  }
  let isFile = false;
  try {
    isFile = statSync(configuredPath).isFile();
  } catch {
    // The actionable error below also covers an inaccessible path.
  }
  if (!isFile) {
    throw new Error(`CSV_NATIVE_LIBRARY_PATH is not a file: ${configuredPath}`);
  }
  return configuredPath;
}

export function nativeLibraryCandidates(root: string, target: string, librarySuffix: string): readonly string[] {
  return [
    join(root, 'prebuilds', target, `libcsv_native.${librarySuffix}`),
    join(root, 'build', target, `libcsv_native.${librarySuffix}`),
    join(root, 'build', target, 'Release', `libcsv_native.${librarySuffix}`),
    join(root, 'build', `libcsv_native.${librarySuffix}`),
    join(root, 'build', 'Release', `libcsv_native.${librarySuffix}`),
    join(root, `libcsv_native.${librarySuffix}`),
  ];
}

export function findNativeLibraryPath(candidates: readonly string[]): string | undefined {
  return candidates.find((candidate) => existsSync(candidate));
}

export function requireNativeLibraryPath(candidates: readonly string[]): string {
  const libraryPath = findNativeLibraryPath(candidates);
  if (libraryPath === undefined) {
    throw new Error('native library not found. Run: bun run build:native');
  }
  return libraryPath;
}

export function requirePtr(ptr: NativePointer | null): NativePointer {
  if (ptr === null) {
    throw new Error('native CSV pointer is null');
  }
  return ptr;
}

export function u64ToSafeNumber(value: bigint | number, label: string): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${label} exceeds the JavaScript safe integer range: ${value}`);
    }
    return value;
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${label} exceeds Number.MAX_SAFE_INTEGER: ${value}`);
  }
  return Number(value);
}
