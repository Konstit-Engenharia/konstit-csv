import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import { DEFAULT_CHUNK_SIZE } from './native.js';
import { snapshotCsvOptions } from './options-snapshot.js';
import type {
  CsvCompression,
  CsvDelimiter,
  CsvFileOptions,
  CsvZipCompression,
} from './types.js';
import { readZipEntryChunks } from './zip-reader.js';

const DELIMITER_PROBE_SIZE = 64 * 1024;
const MAX_DELIMITER_PROBE_ROWS = 128;
const DELIMITER_CANDIDATES = [
  { byte: 0x2c, delimiter: ',' },
  { byte: 0x09, delimiter: '\t' },
  { byte: 0x3b, delimiter: ';' },
  { byte: 0x7c, delimiter: '|' },
  { byte: 0x3a, delimiter: ':' },
  { byte: 0x5e, delimiter: '^' },
  { byte: 0x7e, delimiter: '~' },
] as const satisfies readonly { byte: number; delimiter: CsvDelimiter; }[];
const COMPRESSION_EXTENSIONS = [
  '.deflate-raw',
  '.deflate',
  '.gzip',
  '.zstd',
  '.zlib',
  '.zst',
  '.br',
  '.gz',
  '.zz',
] as const;

interface CompressionExtensionHint {
  extension: string;
  format: Bun.CompressionFormat;
  signatureRequired: boolean;
}

interface CsvFileInput extends AsyncDisposable {
  readonly delimiter: CsvDelimiter;
  chunks(): AsyncIterable<Uint8Array>;
}

interface StableDelimiterCandidate {
  delimiter: CsvDelimiter;
  separatorCount: number;
}

export async function prepareCsvFileInput(
  path: string,
  suppliedOptions: Pick<CsvFileOptions, 'chunkSize' | 'compression' | 'delimiter'>,
  readMode: 'stream' | 'read-ahead' = 'stream',
): Promise<CsvFileInput> {
  const options = snapshotCsvOptions(suppliedOptions);
  const readAhead = readMode === 'read-ahead' && options.compression === undefined
    ? readAheadFileChunks(path, options.chunkSize ?? DEFAULT_CHUNK_SIZE)
    : undefined;
  const configuredDelimiter = options.delimiter ?? ',';
  if (configuredDelimiter !== 'auto') {
    let opened = false;
    return {
      delimiter: configuredDelimiter,
      chunks() {
        if (opened) {
          throw new Error('CSV file input can only be read once');
        }
        opened = true;
        return readAhead ?? readCsvFileChunks(path, options);
      },
      [Symbol.asyncDispose](): Promise<void> {
        return Promise.resolve();
      },
    };
  }

  const iterator = (readAhead ?? readCsvFileChunks(path, options))[Symbol.asyncIterator]();
  const bufferedChunks: Uint8Array[] = [];
  let bufferedByteLength = 0;
  let sourceEnded = false;

  try {
    while (bufferedByteLength < DELIMITER_PROBE_SIZE) {
      const result = await iterator.next();
      if (result.done === true) {
        sourceEnded = true;
        break;
      }
      if (result.value.byteLength === 0) {
        continue;
      }
      bufferedByteLength += result.value.byteLength;
      // A later read can overwrite a probe chunk. The last chunk is replayed before reading resumes.
      bufferedChunks.push(
        readAhead !== undefined && bufferedByteLength < DELIMITER_PROBE_SIZE ? new Uint8Array(result.value) : result.value,
      );
    }

    const probe = copyProbePrefix(bufferedChunks, bufferedByteLength);
    const delimiter = detectDelimiter(delimiterHintPath(path, options.compression), probe, sourceEnded);
    let opened = false;
    return {
      delimiter,
      chunks() {
        if (opened) {
          throw new Error('CSV file input can only be read once');
        }
        opened = true;
        return replayCsvFileChunks(bufferedChunks, iterator);
      },
      [Symbol.asyncDispose](): Promise<void> {
        return closeCsvFileIterator(iterator);
      },
    };
  } catch (error) {
    await closeCsvFileIterator(iterator);
    throw error;
  }
}

// The row parser consumes each chunk before advancing this iterator.
async function* readAheadFileChunks(path: string, chunkSize: number): AsyncGenerator<Buffer, void> {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new RangeError('chunkSize must be a positive safe integer');
  }
  await using file = await open(path, 'r');
  if (!(await file.stat()).isFile()) {
    // Pipes and devices can block indefinitely on a speculative read.
    const buffer = Buffer.allocUnsafe(chunkSize);
    while (true) {
      const { bytesRead } = await file.read(buffer);
      if (bytesRead === 0) {
        return;
      }
      yield buffer.subarray(0, bytesRead);
    }
  }

  let current = Buffer.allocUnsafe(chunkSize);
  let spare = Buffer.allocUnsafe(chunkSize);
  let { bytesRead } = await file.read(current);
  while (bytesRead > 0) {
    const pending = file.read(spare);
    // Advancing reports the read error even if it arrives while the consumer is suspended.
    // FileHandle disposal waits for the pending read on early return.
    void pending.catch(() => {});
    yield bytesRead === current.length ? current : current.subarray(0, bytesRead);
    bytesRead = (await pending).bytesRead;
    [current, spare,] = [spare, current];
  }
}

export function readCsvFileChunks(
  path: string,
  suppliedOptions: Pick<CsvFileOptions, 'chunkSize' | 'compression'>,
): AsyncIterable<Uint8Array> {
  const options = snapshotCsvOptions(suppliedOptions);
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  if (options.compression === undefined) {
    return createReadStream(path, { highWaterMark: chunkSize });
  }
  if (isZipCompression(options.compression)) {
    return readZipEntryChunks(path, options.compression, chunkSize);
  }
  if (options.compression === 'auto') {
    return readAutoDetectedCsvFileChunks(path, chunkSize);
  }
  return decompressedCsvFileChunks(path, options.compression, chunkSize);
}

function isZipCompression(compression: CsvCompression): compression is CsvZipCompression {
  return typeof compression === 'object' && compression.format === 'zip';
}

function delimiterHintPath(path: string, compression: CsvCompression | undefined): string {
  return compression !== undefined && isZipCompression(compression) ? compression.entry : path;
}

export function rejectCompressedSharding(
  options: Pick<CsvFileOptions, 'compression'>,
  operation: string,
): void {
  if (options.compression !== undefined) {
    throw new Error(`${operation} does not support compressed input because compressed byte offsets cannot be sharded`);
  }
}

export function rejectAutoDelimiterSharding(
  options: Pick<CsvFileOptions, 'delimiter'>,
  operation: string,
): void {
  if (options.delimiter === 'auto') {
    throw new Error(`${operation} does not support automatic delimiter detection because byte offsets are resolved first`);
  }
}

async function* replayCsvFileChunks(
  bufferedChunks: readonly Uint8Array[],
  iterator: AsyncIterator<Uint8Array>,
): AsyncGenerator<Uint8Array, void> {
  try {
    yield* bufferedChunks;
    while (true) {
      const result = await iterator.next();
      if (result.done === true) {
        return;
      }
      yield result.value;
    }
  } finally {
    await closeCsvFileIterator(iterator);
  }
}

async function closeCsvFileIterator(iterator: AsyncIterator<Uint8Array>): Promise<void> {
  try {
    await iterator.return?.();
  } catch {
    // Iteration reports read and decompression errors. Cancellation errors are not actionable.
  }
}

function copyProbePrefix(chunks: readonly Uint8Array[], totalByteLength: number): Uint8Array {
  const probe = new Uint8Array(Math.min(totalByteLength, DELIMITER_PROBE_SIZE));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset === probe.byteLength) {
      break;
    }
    const remaining = probe.byteLength - offset;
    const length = Math.min(chunk.byteLength, remaining);
    probe.set(chunk.subarray(0, length), offset);
    offset += length;
  }
  return probe;
}

function detectDelimiter(path: string, probe: Uint8Array, sourceEnded: boolean): CsvDelimiter {
  const rows = scanDelimiterCounts(probe, sourceEnded);
  if (rows.length === 0) {
    throw new Error(
      `delimiter auto-detection failed: the ${
        String(DELIMITER_PROBE_SIZE)
      }-byte probe contains no complete non-empty row; specify delimiter explicitly`,
    );
  }

  const stableCandidates: StableDelimiterCandidate[] = [];
  for (let candidateIndex = 0; candidateIndex < DELIMITER_CANDIDATES.length; ++candidateIndex) {
    const separatorCount = rows[0]?.[candidateIndex] ?? 0;
    if (separatorCount === 0) {
      continue;
    }
    if (rows.every((row) => row[candidateIndex] === separatorCount)) {
      const candidate = DELIMITER_CANDIDATES[candidateIndex];
      if (candidate !== undefined) {
        stableCandidates.push({ delimiter: candidate.delimiter, separatorCount });
      }
    }
  }

  if (stableCandidates.length === 0) {
    throw new Error(
      'delimiter auto-detection failed: no supported delimiter has a stable positive count across the probe rows; specify delimiter explicitly',
    );
  }

  const extensionHint = delimiterFromExtension(path);
  const confirmedHint = stableCandidates.find((candidate) => candidate.delimiter === extensionHint);
  if (confirmedHint !== undefined) {
    return confirmedHint.delimiter;
  }

  const maximumSeparatorCount = Math.max(...stableCandidates.map((candidate) => candidate.separatorCount));
  const strongestCandidates = stableCandidates.filter(
    (candidate) => candidate.separatorCount === maximumSeparatorCount,
  );
  if (strongestCandidates.length === 1) {
    return strongestCandidates[0]?.delimiter ?? ',';
  }

  throw new Error(
    `delimiter auto-detection is ambiguous between ${
      strongestCandidates.map((candidate) => JSON.stringify(candidate.delimiter)).join(', ')
    }; specify delimiter explicitly`,
  );
}

export function scanDelimiterCounts(probe: Uint8Array, sourceEnded: boolean): number[][] {
  const rows: number[][] = [];
  let counts = Array.from({ length: DELIMITER_CANDIDATES.length }, () => 0);
  let inQuotes = false;
  let rowHasContent = false;

  for (let index = 0; index < probe.byteLength; ++index) {
    const byte = probe[index];
    if (byte === 0x22) {
      rowHasContent = true;
      if (inQuotes && probe[index + 1] === 0x22) {
        ++index;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }

    if (!inQuotes && (byte === 0x0a || byte === 0x0d)) {
      if (rowHasContent) {
        rows.push(counts);
        if (rows.length === MAX_DELIMITER_PROBE_ROWS) {
          return rows;
        }
      }
      counts = Array.from({ length: DELIMITER_CANDIDATES.length }, () => 0);
      rowHasContent = false;
      if (byte === 0x0d && probe[index + 1] === 0x0a) {
        ++index;
      }
      continue;
    }

    rowHasContent = true;
    if (!inQuotes) {
      for (let candidateIndex = 0; candidateIndex < DELIMITER_CANDIDATES.length; ++candidateIndex) {
        if (byte === DELIMITER_CANDIDATES[candidateIndex]?.byte) {
          counts[candidateIndex] = (counts[candidateIndex] ?? 0) + 1;
        }
      }
    }
  }

  if (sourceEnded && !inQuotes && rowHasContent && rows.length < MAX_DELIMITER_PROBE_ROWS) {
    rows.push(counts);
  }
  return rows;
}

function delimiterFromExtension(path: string): CsvDelimiter | undefined {
  const extension = extname(stripCompressionExtension(path.toLowerCase()));
  switch (extension) {
    case '.csv':
      return ',';
    case '.psv':
      return '|';
    case '.tab':
    case '.tsv':
      return '\t';
    default:
      return undefined;
  }
}

function stripCompressionExtension(path: string): string {
  for (const extension of COMPRESSION_EXTENSIONS) {
    if (path.endsWith(extension)) {
      return path.slice(0, -extension.length);
    }
  }
  return path;
}

async function* readAutoDetectedCsvFileChunks(path: string, chunkSize: number): AsyncGenerator<Uint8Array, void> {
  const compression = await detectCompression(path);
  for await (const chunk of decompressedCsvFileChunks(path, compression, chunkSize)) {
    yield chunk;
  }
}

function decompressedCsvFileChunks(
  path: string,
  compression: Bun.CompressionFormat,
  chunkSize: number,
): ReadableStream<Uint8Array> {
  return Bun.file(path).stream().pipeThrough(
    new DecompressionStream(compression, { highWaterMark: chunkSize }),
  );
}

async function detectCompression(path: string): Promise<Bun.CompressionFormat> {
  const prefix = await Bun.file(path).slice(0, 4).bytes();
  const extensionHint = compressionFromExtension(path);
  const strongSignature = compressionFromStrongSignature(prefix);

  if (strongSignature !== undefined) {
    if (extensionHint !== undefined && extensionHint.format !== strongSignature) {
      throw new Error(
        `compression auto-detection mismatch: extension ${extensionHint.extension} indicates ${extensionHint.format}, but the file signature indicates ${strongSignature}`,
      );
    }
    return strongSignature;
  }

  const hasZlibHeader = isZlibHeader(prefix);
  if (extensionHint !== undefined) {
    if (extensionHint.signatureRequired) {
      if (extensionHint.format === 'deflate' && hasZlibHeader) {
        return 'deflate';
      }
      if (extensionHint.extension === '.deflate') {
        throw new Error(
          'compression auto-detection is ambiguous for .deflate input; specify compression: \'deflate-raw\' when the stream has no zlib wrapper',
        );
      }
      throw new Error(
        `compression auto-detection failed: extension ${extensionHint.extension} does not match the file signature`,
      );
    }
    return extensionHint.format;
  }

  if (hasZlibHeader) {
    return 'deflate';
  }

  throw new Error(
    'compression auto-detection failed: no supported signature or extension; specify compression as \'brotli\' or \'deflate-raw\' when applicable',
  );
}

function compressionFromExtension(path: string): CompressionExtensionHint | undefined {
  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith('.deflate-raw')) {
    return { extension: '.deflate-raw', format: 'deflate-raw', signatureRequired: false };
  }

  const extension = extname(lowerPath);
  switch (extension) {
    case '.br':
      return { extension, format: 'brotli', signatureRequired: false };
    case '.deflate':
    case '.zlib':
    case '.zz':
      return { extension, format: 'deflate', signatureRequired: true };
    case '.gz':
    case '.gzip':
      return { extension, format: 'gzip', signatureRequired: true };
    case '.zst':
    case '.zstd':
      return { extension, format: 'zstd', signatureRequired: true };
    default:
      return undefined;
  }
}

function compressionFromStrongSignature(prefix: Uint8Array): Bun.CompressionFormat | undefined {
  if (prefix[0] === 0x1f && prefix[1] === 0x8b) {
    return 'gzip';
  }
  if (prefix[0] === 0x28 && prefix[1] === 0xb5 && prefix[2] === 0x2f && prefix[3] === 0xfd) {
    return 'zstd';
  }
  if (
    prefix[0] !== undefined && prefix[0] >= 0x50 && prefix[0] <= 0x5f && prefix[1] === 0x2a
    && prefix[2] === 0x4d && prefix[3] === 0x18
  ) {
    return 'zstd';
  }
  return undefined;
}

function isZlibHeader(prefix: Uint8Array): boolean {
  const compressionMethodAndFlags = prefix[0];
  const flags = prefix[1];
  if (compressionMethodAndFlags === undefined || flags === undefined) {
    return false;
  }
  return (compressionMethodAndFlags & 0x0f) === 8
    && (compressionMethodAndFlags >> 4) <= 7
    && ((compressionMethodAndFlags << 8) | flags) % 31 === 0;
}
