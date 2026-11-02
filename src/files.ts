import { prepareCsvFileInput } from './file-stream.js';
import {
  native,
  u64ToSafeNumber,
} from './native.js';
import {
  requirePtr,
  toArrayBuffer,
} from './native.js';
import {
  normalizeChunk,
  projectionFilterProgram,
} from './normalize.js';
import { snapshotCsvOptions } from './options-snapshot.js';
import {
  createPreparedParser,
  NativeCsvParser,
} from './parser.js';
import {
  rejectStrictSchemaUnsupported,
  strictSchemaValidator,
} from './strict-schema.js';
import type {
  CsvFileOptions,
  CsvNativeProjectionOptions,
  CsvParserOptions,
  CsvRow,
  CsvShard,
} from './types.js';

export function parseCsvBuffer(buffer: NodeJS.TypedArray | DataView, suppliedOptions: CsvParserOptions = {}): CsvRow[] {
  const options = snapshotCsvOptions(suppliedOptions);
  using parser = new NativeCsvParser(options);
  const validator = strictSchemaValidator(options);
  const batch = parser.writeBatch(buffer, true);
  try {
    validator?.validateBatch(batch);
    validator?.finish();
    return batch.rowsInto([], options.selectedColumns);
  } finally {
    batch.close();
  }
}

export function countTrustedNewlineRows(buffer: NodeJS.TypedArray | DataView): number {
  if (buffer.byteLength === 0) {
    return 0;
  }
  const input = normalizeChunk(buffer);
  return u64ToSafeNumber(
    native.symbols.csv_parser_count_trusted_newlines(input, input),
    'CSV newline row count',
  );
}

export function findCsvSafeSplitOffsets(path: string, shardCount: number, delimiter = ','): number[] {
  if (!Number.isInteger(shardCount) || shardCount <= 0) {
    throw new RangeError(`invalid shard count: ${shardCount}`);
  }
  if (delimiter.length !== 1) {
    throw new Error('delimiter must be one character');
  }

  const batch = native.symbols.csv_parser_find_split_offsets(
    Buffer.from(`${path}\0`),
    BigInt(shardCount),
    delimiter.charCodeAt(0),
  );
  if (batch === null) {
    throw new Error(`native CSV split offset scan failed: ${path}`);
  }

  try {
    const count = u64ToSafeNumber(native.symbols.csv_split_offsets_batch_count(batch), 'CSV split offset count');
    const ptr = native.symbols.csv_split_offsets_batch_ptr(batch);
    const offsets = new BigUint64Array(toArrayBuffer(requirePtr(ptr), 0, count * BigUint64Array.BYTES_PER_ELEMENT));
    return Array.from(offsets, (offset) => u64ToSafeNumber(offset, 'CSV split offset'));
  } finally {
    native.symbols.csv_split_offsets_batch_destroy(batch);
  }
}

export function findCsvSafeShards(path: string, shardCount: number, delimiter = ','): CsvShard[] {
  const offsets = findCsvSafeSplitOffsets(path, shardCount, delimiter);
  const shards: CsvShard[] = [];
  for (let index = 0; index < offsets.length - 1; ++index) {
    const start = offsets[index] ?? 0;
    const nextStart = offsets[index + 1] ?? start;
    if (nextStart <= start) {
      continue;
    }
    shards.push({
      start,
      end: nextStart - 1,
    });
  }
  return shards;
}

export function parseCsvFile(path: string, options: CsvFileOptions = {}): AsyncGenerator<CsvRow[], void> {
  return iterateCsvFile(path, snapshotCsvOptions(options));
}

async function* iterateCsvFile(path: string, options: CsvFileOptions): AsyncGenerator<CsvRow[], void> {
  await using input = await prepareCsvFileInput(path, options);
  using parser = new NativeCsvParser({ ...options, delimiter: input.delimiter });
  const validator = strictSchemaValidator(options);
  for await (const chunk of input.chunks()) {
    const batch = parser.writeBatch(chunk);
    try {
      validator?.validateBatch(batch);
      const rows = batch.rowsInto([], options.selectedColumns);
      if (rows.length > 0) {
        yield rows;
      }
    } finally {
      batch.close();
    }
  }

  const batch = parser.endBatch();
  try {
    validator?.validateBatch(batch);
    validator?.finish();
    const rows = batch.rowsInto([], options.selectedColumns);
    if (rows.length > 0) {
      yield rows;
    }
  } finally {
    batch.close();
  }
}

export function parseCsvFileProjected(
  path: string,
  options: CsvFileOptions & CsvNativeProjectionOptions = {},
): AsyncGenerator<CsvRow[], void> {
  return iterateCsvFileProjected(path, snapshotCsvOptions(options));
}

async function* iterateCsvFileProjected(
  path: string,
  options: CsvFileOptions & CsvNativeProjectionOptions,
): AsyncGenerator<CsvRow[], void> {
  rejectStrictSchemaUnsupported(options, 'projected file parsing');
  await using input = await prepareCsvFileInput(path, options);
  using parser = createPreparedParser(
    { ...options, delimiter: input.delimiter },
    options.selectedColumns,
    projectionFilterProgram(options),
    true,
  );
  for await (const chunk of input.chunks()) {
    const batch = parser.writeBatch(chunk);
    try {
      const rows = batch.rows();
      if (rows.length > 0) {
        yield rows;
      }
    } finally {
      batch.close();
    }
  }

  const batch = parser.endBatch();
  try {
    const rows = batch.rows();
    if (rows.length > 0) {
      yield rows;
    }
  } finally {
    batch.close();
  }
}

export async function countCsvFile(path: string, suppliedOptions: CsvFileOptions = {}): Promise<number> {
  const options = snapshotCsvOptions(suppliedOptions);
  rejectStrictSchemaUnsupported(options, 'count');
  await using input = await prepareCsvFileInput(path, options);
  using parser = new NativeCsvParser({ ...options, delimiter: input.delimiter });
  let rows = 0;
  if (options.strict === true) {
    for await (const chunk of input.chunks()) {
      const batch = parser.writeBatch(chunk);
      try {
        rows += batch.rowCount;
      } finally {
        batch.close();
      }
    }
    const batch = parser.endBatch();
    try {
      rows += batch.rowCount;
    } finally {
      batch.close();
    }
    return rows;
  }

  for await (const chunk of input.chunks()) {
    rows += parser.writeCount(chunk);
  }
  rows += parser.endCount();
  return rows;
}
