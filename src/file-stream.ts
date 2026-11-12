import { ptr } from 'bun:ffi';
import { createReadStream } from 'node:fs';
import {
  open,
  stat,
} from 'node:fs/promises';
import { extname } from 'node:path';
import { ReadableStream as WebReadableStream } from 'node:stream/web';
import {
  constants,
  inflateSync,
} from 'node:zlib';
import {
  DEFAULT_CHUNK_SIZE,
  EMPTY_BUFFER,
  native,
} from './native.js';
import { resolveInputEncoding } from './normalize.js';
import { snapshotCsvOptions } from './options-snapshot.js';
import type {
  CsvCompression,
  CsvDelimiter,
  CsvFileOptions,
  CsvZipCompression,
} from './types.js';
import { readZipEntryChunks } from './zip-reader.js';

export const FILE_PROBE_SIZE = 64 * 1024;
const PROBED_BYTE_ENCODINGS = ['utf8', 'latin1', 'windows-1252'] as const;
const MAX_DELIMITER_PROBE_ROWS = 128;
export const DELIMITER_CANDIDATES = [
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
  /** Encoding expected by the native parser after any stream transcoding. */
  readonly parserEncoding: 'utf8' | 'latin1';
  chunks(): AsyncIterable<Uint8Array>;
}

interface StableDelimiterCandidate {
  delimiter: CsvDelimiter;
  separatorCount: number;
}

export type CsvFileProbe = (path: string, prefix: Uint8Array, sourceEnded: boolean, delimiter: CsvDelimiter) => {
  delimiter: CsvDelimiter;
  encoding: 'utf8' | 'latin1' | 'windows-1252' | 'utf-16le' | 'utf-16be';
  skipBytes: number;
};

type FileReadMode = 'stream' | 'read-ahead' | 'count';

export async function prepareCsvFileInput(
  path: string,
  suppliedOptions: Pick<CsvFileOptions, 'chunkSize' | 'compression' | 'delimiter' | 'encoding'>,
  readMode: FileReadMode = 'stream',
  probeFormat: CsvFileProbe = probeCsvFileFormat,
): Promise<CsvFileInput> {
  const options = snapshotCsvOptions(suppliedOptions);
  const autoEncoding = options.encoding === undefined || options.encoding === 'auto';
  // The encoding probe needs the original bytes after decompression.
  const inputEncoding = autoEncoding ? 'utf8' : resolveInputEncoding(options.encoding, options.delimiter);
  const parserEncoding = typeof inputEncoding === 'string' ? inputEncoding : 'utf8';
  const source = (): AsyncIterable<Uint8Array> => {
    const chunks = readCsvFileChunks(path, options, readMode);
    return typeof inputEncoding === 'string' ? chunks : transcodeCsvChunks(chunks, inputEncoding);
  };
  const configuredDelimiter = options.delimiter ?? ',';
  if (!autoEncoding && configuredDelimiter !== 'auto') {
    let opened = false;
    return {
      delimiter: configuredDelimiter,
      parserEncoding,
      chunks() {
        if (opened) {
          throw new Error('CSV file input can only be read once');
        }
        opened = true;
        return source();
      },
      [Symbol.asyncDispose](): Promise<void> {
        return Promise.resolve();
      },
    };
  }

  const iterator = source()[Symbol.asyncIterator]();
  const compression = options.compression ?? 'auto';
  const reusesReadBuffer = typeof inputEncoding === 'string' && (
    (readMode === 'read-ahead' && (compression === 'auto' || compression === 'none'))
    || (readMode === 'count' && (compression === 'auto' || isZipCompression(compression)))
  );
  const bufferedChunks: Uint8Array[] = [];
  let bufferedByteLength = 0;
  let sourceEnded = false;
  let bytesNeeded = FILE_PROBE_SIZE;

  try {
    while (bufferedByteLength < bytesNeeded) {
      const result = await iterator.next();
      if (result.done === true) {
        sourceEnded = true;
        break;
      }
      if (result.value.byteLength === 0) {
        continue;
      }
      bufferedByteLength += result.value.byteLength;
      // At the limit, EOF can complete an unterminated record or distinguish
      // a final Latin-1 accent from the start of a UTF-8 character.
      if (
        bufferedByteLength === FILE_PROBE_SIZE && (configuredDelimiter === 'auto' || (autoEncoding && mayEndInPartialUtf8(result.value)))
      ) {
        ++bytesNeeded;
      }
      // The last probe chunk is replayed before a borrowed buffer can be overwritten.
      bufferedChunks.push(
        reusesReadBuffer && bufferedByteLength < bytesNeeded ? new Uint8Array(result.value) : result.value,
      );
    }

    const probe = copyProbePrefix(bufferedChunks, bufferedByteLength);
    const hint = delimiterHintPath(path, options.compression);
    const format = autoEncoding ? probeFormat(hint, probe, sourceEnded, configuredDelimiter) : undefined;
    const delimiter = format?.delimiter ?? detectDelimiter(hint, probe, sourceEnded);
    const replayEncoding = format === undefined ? parserEncoding : resolveInputEncoding(format.encoding, delimiter);
    // A signature can span multiple reads, including one-byte input chunks.
    let skip = format?.skipBytes ?? 0;
    if (skip > 0) {
      for (const [i, chunk,] of bufferedChunks.entries()) {
        const length = Math.min(skip, chunk.length);
        bufferedChunks[i] = chunk.subarray(length);
        skip -= length;
        if (skip === 0) {
          break;
        }
      }
    }
    let opened = false;
    return {
      delimiter,
      parserEncoding: typeof replayEncoding === 'string' ? replayEncoding : 'utf8',
      chunks() {
        if (opened) {
          throw new Error('CSV file input can only be read once');
        }
        opened = true;
        const replay = replayCsvFileChunks(bufferedChunks, iterator);
        return typeof replayEncoding === 'string' ? replay : transcodeCsvChunks(replay, replayEncoding);
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
async function* readAheadFileChunks(path: string, chunkSize: number): AsyncGenerator<Buffer<ArrayBuffer>, void> {
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
  readMode: FileReadMode = 'stream',
): AsyncIterable<Uint8Array> {
  const options = snapshotCsvOptions(suppliedOptions);
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const compression = options.compression ?? 'auto';
  if (isZipCompression(compression)) {
    return readZipEntryChunks(path, compression, chunkSize, readMode === 'count');
  }
  if (compression === 'auto' || compression === 'none') {
    const readAhead = readMode === 'read-ahead';
    const raw = readAhead ? readAheadFileChunks(path, chunkSize) : createReadStream(path, { highWaterMark: chunkSize });
    return compression === 'none' ? raw : readAutoDetectedCsvFileChunks(path, raw, chunkSize, readMode);
  }
  return decompressedCsvFileChunks(path, compression, chunkSize);
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

async function* replayCsvFileChunks<T extends Uint8Array>(
  bufferedChunks: readonly T[],
  iterator: AsyncIterator<T>,
): AsyncGenerator<T, void> {
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

async function* transcodeCsvChunks(
  source: AsyncIterable<Uint8Array>,
  decoder: TextDecoder,
): AsyncGenerator<Uint8Array, void> {
  const encoder = new TextEncoder();
  for await (const chunk of source) {
    const text = decoder.decode(chunk, { stream: true });
    if (text.length > 0) {
      yield encoder.encode(text);
    }
  }
  const text = decoder.decode();
  if (text.length > 0) {
    yield encoder.encode(text);
  }
}

async function closeCsvFileIterator(iterator: AsyncIterator<Uint8Array>): Promise<void> {
  try {
    await iterator.return?.();
  } catch {
    // Iteration reports read and decompression errors. Cancellation errors are not actionable.
  }
}

function mayEndInPartialUtf8(chunk: Uint8Array): boolean {
  let index = chunk.length - 1;
  while (index >= 0 && chunk.length - index < 4 && ((chunk[index] ?? 0) & 0xc0) === 0x80) {
    --index;
  }
  const length = chunk.length - index;
  if (length >= 4) {
    return false;
  }
  // One or two continuation bytes in a tiny chunk can have a lead in the preceding chunk.
  if (index < 0) {
    return true;
  }
  const lead = chunk[index] ?? 0;
  if (lead < 0xc2 || lead > 0xf4) {
    return false;
  }
  return length < (lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4);
}

function copyProbePrefix(chunks: readonly Uint8Array[], totalByteLength: number): Uint8Array {
  const probe = new Uint8Array(Math.min(totalByteLength, FILE_PROBE_SIZE));
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

export function detectDelimiter(path: string, probe: Uint8Array, sourceEnded: boolean): CsvDelimiter {
  return requireDelimiter(path, scanDelimiterCounts(probe, sourceEnded));
}

/** Detect the encoding and, when requested, score delimiters on the same prefix. */
export const probeCsvFileFormat: CsvFileProbe = (path, prefix, sourceEnded, delimiter) => {
  const { encoding, skipBytes, counts } = scanCsvFileFormat(prefix, sourceEnded, delimiter === 'auto');
  return { encoding, delimiter: delimiter === 'auto' ? requireDelimiter(path, counts) : delimiter, skipBytes };
};

interface CsvFormatSample {
  bytes: Uint8Array;
  encoding: ReturnType<CsvFileProbe>['encoding'];
  skipBytes: number;
  counts: readonly Uint32Array[];
}

/** When scoring delimiters, structural bytes exclude the BOM and use UTF-8 for UTF-16 input. */
export function scanCsvFileFormat(prefix: Uint8Array, sourceEnded: boolean, scoreDelimiters: boolean): CsvFormatSample {
  let bytes = prefix;
  let bomEncoding: 'utf-16le' | 'utf-16be' | 'utf8' | undefined;
  let skipBytes = 0;
  if (
    (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0 && bytes[3] === 0)
    || (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xfe && bytes[3] === 0xff)
  ) {
    throw new Error('automatic encoding detection does not support UTF-32; transcode the input to UTF-8');
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    bomEncoding = 'utf8';
    skipBytes = 3;
    bytes = bytes.subarray(skipBytes);
  } else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    bomEncoding = 'utf-16le';
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    bomEncoding = 'utf-16be';
  }
  if (bomEncoding !== undefined) {
    if (!scoreDelimiters) {
      return { bytes, encoding: bomEncoding, skipBytes, counts: [] };
    }
    if (bomEncoding !== 'utf8') {
      // Score whole UTF-16 characters. The replay decoder consumes the original BOM.
      const text = new TextDecoder(bomEncoding).decode(bytes, { stream: !sourceEnded });
      bytes = new TextEncoder().encode(text);
    }
  }
  const counts = scoreDelimiters ? new Uint32Array(8) : undefined;
  const encodingCode = native.symbols.csv_probe_format(
    bytes.length === 0 ? EMPTY_BUFFER : bytes,
    bytes.length,
    sourceEnded,
    bomEncoding === undefined,
    counts === undefined ? null : ptr(counts),
  );
  const encoding = bomEncoding ?? PROBED_BYTE_ENCODINGS[encodingCode];
  if (encoding === undefined) {
    throw new Error('NUL in encoding probe: specify the encoding explicitly');
  }
  return { bytes, encoding, skipBytes, counts: counts === undefined || counts[7] === 0 ? [] : [counts] };
}

function requireDelimiter(path: string, rows: readonly ArrayLike<number>[]): CsvDelimiter {
  const result = selectDelimiter(path, rows);
  if ('error' in result) {
    throw new Error(result.error);
  }
  return result.delimiter;
}

export function selectDelimiter(path: string, rows: readonly ArrayLike<number>[]): { delimiter: CsvDelimiter; } | { error: string; } {
  if (rows.length === 0) {
    return {
      error: `delimiter auto-detection failed: the ${
        String(FILE_PROBE_SIZE)
      }-byte probe contains no complete non-empty row; specify delimiter explicitly`,
    };
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
    return {
      error:
        'delimiter auto-detection failed: no supported delimiter has a stable positive count across the probe rows; specify delimiter explicitly',
    };
  }

  const extensionHint = delimiterFromExtension(path);
  const confirmedHint = stableCandidates.find((candidate) => candidate.delimiter === extensionHint);
  if (confirmedHint !== undefined) {
    return { delimiter: confirmedHint.delimiter };
  }

  const maximumSeparatorCount = Math.max(...stableCandidates.map((candidate) => candidate.separatorCount));
  const strongestCandidates = stableCandidates.filter(
    (candidate) => candidate.separatorCount === maximumSeparatorCount,
  );
  if (strongestCandidates.length === 1) {
    return { delimiter: strongestCandidates[0]?.delimiter ?? ',' };
  }

  return {
    error: `delimiter auto-detection is ambiguous between ${
      strongestCandidates.map((candidate) => JSON.stringify(candidate.delimiter)).join(', ')
    }; specify delimiter explicitly`,
  };
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

async function* readAutoDetectedCsvFileChunks(
  path: string,
  raw: AsyncIterable<Uint8Array<ArrayBuffer>>,
  chunkSize: number,
  readMode: FileReadMode,
): AsyncGenerator<Uint8Array, void> {
  const reusesBuffer = readMode === 'read-ahead';
  const iterator = raw[Symbol.asyncIterator]();
  // Replay the original chunks on the same descriptor, including for pipes.
  const buffered: Uint8Array<ArrayBuffer>[] = [];
  const prefix = new Uint8Array(64);
  let length = 0;
  let needed = 4;
  try {
    while (length < needed) {
      const next = await iterator.next();
      if (next.done === true) {
        break;
      }
      const chunk = next.value;
      const take = Math.min(prefix.length - length, chunk.length);
      prefix.set(chunk.subarray(0, take), length);
      length += take;
      if (length >= 4 && isZlibHeader(prefix) && isPrintableZlibHeader(prefix)) {
        needed = prefix.length;
      }
      buffered.push(reusesBuffer && length < needed ? new Uint8Array(chunk) : chunk);
    }
    const sample = prefix.subarray(0, length);
    if (isZipSignature(sample)) {
      if (!(await stat(path)).isFile()) {
        throw new Error('ZIP input requires a regular file; save the archive before reading it');
      }
      // The native reader seeks through the ZIP central directory using its own file handle.
      await closeCsvFileIterator(iterator);
      yield* readZipEntryChunks(path, { format: 'zip', entry: '*' }, chunkSize, readMode === 'count');
      return;
    }
    const compression = compressionFromPrefix(path, sample);
    const replay = replayCsvFileChunks(buffered, iterator);
    if (compression === undefined) {
      if (!isPlainCsvFile(path)) {
        throw new Error(
          'compression auto-detection failed: no supported signature or extension and no delimited-text MIME type; specify compression explicitly (none for plain input)',
        );
      }
      yield* replay;
      return;
    }
    // A Web stream can queue chunks after advancing the file iterator.
    yield* WebReadableStream.from<NodeJS.BufferSource>(reusesBuffer ? copyFileChunks(replay) : replay)
      .pipeThrough(new DecompressionStream(compression, { highWaterMark: chunkSize }));
  } finally {
    await closeCsvFileIterator(iterator);
  }
}

async function* copyFileChunks(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array<ArrayBuffer>, void> {
  for await (const chunk of chunks) {
    yield new Uint8Array(chunk);
  }
}

function isPlainCsvFile(path: string): boolean {
  const mime = Bun.file(path).type.split(';', 1)[0];
  return mime === 'text/csv' || mime === 'text/tab-separated-values' || mime === 'text/plain'
    || (mime === 'application/octet-stream' && /\.(?:psv|ssv|tab)$/i.test(path));
}

export function isZipSignature(prefix: Uint8Array): boolean {
  return prefix[0] === 0x50 && prefix[1] === 0x4b
    && ((prefix[2] === 3 && prefix[3] === 4) || (prefix[2] === 5 && prefix[3] === 6));
}

function isPrintableZlibHeader(prefix: Uint8Array): boolean {
  const first = prefix[0] ?? 0;
  const second = prefix[1] ?? 0;
  return first >= 32 && first < 127 && second >= 32 && second < 127;
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

export function compressionFromPrefix(path: string, prefix: Uint8Array): Bun.CompressionFormat | undefined {
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
    // Plain headers such as "H,name" satisfy the two-byte zlib check. For
    // text files with that weak signature, validate a bounded deflate prefix.
    const sample = prefix.subarray(0, 64);
    if (isPrintableZlibHeader(sample) && isPlainCsvFile(path) && !sample.some((b) => b < 32 && b !== 9 && b !== 10 && b !== 13)) {
      try {
        inflateSync(sample, { finishFlush: sample.length < 64 ? constants.Z_FINISH : constants.Z_SYNC_FLUSH });
      } catch (error) {
        if (
          error instanceof Error && 'code' in error
          && (error.code === 'Z_DATA_ERROR' || error.code === 'Z_NEED_DICT' || error.code === 'Z_BUF_ERROR')
        ) {
          return undefined;
        }
        throw error;
      }
    }
    return 'deflate';
  }

  return undefined;
}

export function compressionFromExtension(path: string): CompressionExtensionHint | undefined {
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
