import { stat } from 'node:fs/promises';
import {
  compressionFromExtension,
  compressionFromPrefix,
  DELIMITER_CANDIDATES,
  FILE_PROBE_SIZE,
  isZipSignature,
  readCsvFileChunks,
  scanCsvFileFormat,
  scanDelimiterCounts,
  selectDelimiter,
} from './file-stream.js';
import { resolveInputEncoding } from './normalize.js';
import { NativeZipReader } from './zip-reader.js';

interface InspectionOptions {
  readonly zipEntry?: string;
  readonly delimiter?: string;
  readonly encoding?: string;
}

interface FileInspection {
  fileSizeBytes: number;
  sampleBytes: number;
  sampleReachedEof: boolean;
  compression: Bun.CompressionFormat | 'zip' | 'none';
  zipEntry: string | null;
  encoding: string;
  encodingSource: 'explicit' | 'inferred';
  delimiter: string | null;
  delimiterSource: 'explicit' | 'inferred' | null;
  delimiterReason: string | null;
  lineEnding: string;
  firstRecordColumns: number | null;
}

/** Inspect a bounded sample of the CSV payload; size always refers to the file on disk. */
export async function inspectCsvFile(path: string, options: InspectionOptions = {}): Promise<FileInspection> {
  const info = await stat(path);
  if (!info.isFile()) {
    throw new Error('probe requires a regular file');
  }
  const raw = await Bun.file(path).slice(0, FILE_PROBE_SIZE + 1).bytes();
  const zip = isZipSignature(raw);
  if (options.zipEntry !== undefined && !zip) {
    throw new Error('--zip-entry requires a ZIP archive');
  }
  let compression: FileInspection['compression'] = zip ? 'zip' : compressionFromPrefix(path, raw) ?? 'none';
  let zipEntry: string | null = null;
  let sample = raw;
  if (compression === 'zip') {
    using reader = new NativeZipReader(path, { format: 'zip', entry: options.zipEntry ?? '*' });
    zipEntry = reader.entryName;
    sample = await readCompressedSample(reader.chunks(FILE_PROBE_SIZE + 1));
  } else if (compression !== 'none') {
    try {
      sample = await readCompressedSample(readCsvFileChunks(path, { compression, chunkSize: FILE_PROBE_SIZE + 1 }));
    } catch (error) {
      // Two printable bytes (e.g. "H,") can satisfy the zlib header check.
      // Without a compression extension, accept plain text if inflation rejects it.
      if (
        compression !== 'deflate' || compressionFromExtension(path) !== undefined || !(error instanceof TypeError)
        || raw.some((b) => b < 32 && b !== 9 && b !== 10 && b !== 13)
      ) {
        throw error;
      }
      compression = 'none';
    }
  }
  const eof = sample.length <= FILE_PROBE_SIZE;
  const prefix = sample.subarray(0, FILE_PROBE_SIZE);
  const format = inspectFormat(zipEntry ?? path, prefix, eof, options.encoding ?? 'auto', options.delimiter ?? 'auto');
  return {
    fileSizeBytes: info.size,
    sampleBytes: prefix.byteLength,
    sampleReachedEof: eof,
    compression,
    zipEntry,
    ...format,
  };
}

async function readCompressedSample(chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  const sample = new Uint8Array(FILE_PROBE_SIZE + 1);
  let length = 0;
  for await (const chunk of chunks) {
    const take = Math.min(chunk.length, sample.length - length);
    sample.set(chunk.subarray(0, take), length);
    length += take;
    if (length === sample.length) {
      break;
    }
  }
  return sample.subarray(0, length);
}

function inspectFormat(path: string, prefix: Uint8Array, eof: boolean, encoding: string, delimiter: string) {
  let bytes = prefix;
  let counts: readonly Uint32Array[] | undefined;
  const encodingSource = encoding === 'auto' ? 'inferred' : 'explicit';
  if (encoding === 'auto') {
    const sample = scanCsvFileFormat(prefix, eof, true);
    bytes = sample.bytes;
    counts = sample.counts;
    encoding = sample.encoding;
  } else {
    const decoder = resolveInputEncoding(encoding, delimiter);
    if (typeof decoder === 'string') {
      encoding = decoder;
    } else {
      bytes = new TextEncoder().encode(decoder.decode(prefix, { stream: !eof }));
      encoding = decoder.encoding;
    }
  }
  const choice = delimiter === 'auto'
    ? inspectDelimiter(path, bytes, eof, counts, prefix.length)
    : { delimiter, delimiterSource: 'explicit', delimiterReason: null } as const;
  return { encoding, encodingSource, ...choice, ...inspectRecords(bytes, eof, choice.delimiter) } as const;
}

function inspectDelimiter(path: string, bytes: Uint8Array, eof: boolean, counts: readonly Uint32Array[] | undefined, sampleBytes: number) {
  // The native probe summarizes stable counts. Per-record counts distinguish an absent separator from an inconsistent one.
  const rows = counts ?? scanDelimiterCounts(bytes, eof);
  const choice = selectDelimiter(path, rows);
  if ('delimiter' in choice) {
    return { delimiter: choice.delimiter, delimiterSource: 'inferred', delimiterReason: null } as const;
  }
  let reason: string;
  switch (choice.reason) {
    case 'no-records':
      reason = sampleBytes === 0
        ? 'Empty payload'
        : eof
        ? 'No complete non-empty record in the payload'
        : 'No complete non-empty record in the 64 KiB sample';
      break;
    case 'no-stable-separator': {
      const perRecord = counts === undefined ? rows : scanDelimiterCounts(bytes, eof);
      reason = perRecord.some((row) => row.some((count) => count > 0))
        ? 'Separator counts vary across sampled records'
        : 'No supported separator found in sampled records';
      break;
    }
    case 'ambiguous':
      reason = `Ambiguous between ${choice.candidates.map((c) => JSON.stringify(c)).join(' and ')}`;
      break;
  }
  return { delimiter: null, delimiterSource: null, delimiterReason: reason } as const;
}

// A newline inside a quoted field is data. Two escaped quotes toggle the state
// twice without exposing any intervening bytes as structural characters.
function inspectRecords(bytes: Uint8Array, eof: boolean, delimiter: string | null) {
  const separator = delimiter?.charCodeAt(0);
  const endings = new Set<string>();
  let quoted = false;
  let firstRecord = true;
  let columns = 1;
  let unknownWidth = false;
  for (let i = 0; i < bytes.length; ++i) {
    const byte = bytes[i];
    if (byte === 0x22) {
      quoted = !quoted;
    } else if (!quoted) {
      if (byte === 13 || byte === 10) {
        firstRecord = false;
        if (byte === 13 && bytes[i + 1] === 10) {
          endings.add('CRLF');
          ++i;
        } else if (byte === 13 && i + 1 === bytes.length && !eof) {
          // The LF of a CRLF pair might be outside the sample.
          break;
        } else {
          endings.add(byte === 10 ? 'LF' : 'CR');
        }
      } else if (firstRecord) {
        if (byte === separator) {
          ++columns;
        } else if (separator === undefined && DELIMITER_CANDIDATES.some((candidate) => candidate.byte === byte)) {
          unknownWidth = true;
        }
      }
    }
  }
  const firstComplete = !firstRecord || (eof && !quoted);
  return {
    firstRecordColumns: firstComplete && !unknownWidth ? (bytes.length === 0 ? 0 : columns) : null,
    lineEnding: endings.size > 1 ? 'mixed' : endings.values().next().value ?? (eof ? 'none' : 'unknown'),
  };
}
