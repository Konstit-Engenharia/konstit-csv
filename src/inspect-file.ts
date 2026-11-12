import { stat } from 'node:fs/promises';
import {
  compressionFromExtension,
  compressionFromPrefix,
  DELIMITER_CANDIDATES,
  FILE_PROBE_SIZE,
  isZipSignature,
  readCsvFileChunks,
  scanCsvFileFormat,
  selectDelimiter,
} from './file-stream.js';
import type { CsvFileProbe } from './file-stream.js';
import type { CsvCompression } from './types.js';

interface FileInspection {
  size: number;
  compression: Bun.CompressionFormat | 'zip' | 'none';
  encoding: ReturnType<CsvFileProbe>['encoding'];
  delimiter: string | undefined;
  lineEnding: string;
  firstRecordColumns: number | undefined;
}

/** Inspect a bounded sample of the CSV payload; size always refers to the file on disk. */
export async function inspectCsvFile(path: string, zipEntry?: string): Promise<FileInspection> {
  const info = await stat(path);
  if (!info.isFile()) {
    throw new Error('probe requires a regular file');
  }
  const raw = await Bun.file(path).slice(0, FILE_PROBE_SIZE + 1).bytes();
  const zip = isZipSignature(raw);
  if (zipEntry !== undefined && !zip) {
    throw new Error('--zip-entry requires a ZIP archive');
  }
  let compression = zip ? { format: 'zip', entry: zipEntry ?? '*' } as const : compressionFromPrefix(path, raw);
  let sample = raw;
  if (compression !== undefined) {
    try {
      sample = await readCompressedSample(path, compression);
    } catch (error) {
      // Two printable bytes (e.g. "H,") can satisfy the zlib header check.
      // Without a compression extension, accept plain text if inflation rejects it.
      if (
        compression !== 'deflate' || compressionFromExtension(path) !== undefined || !(error instanceof TypeError)
        || raw.some((b) => b < 32 && b !== 9 && b !== 10 && b !== 13)
      ) {
        throw error;
      }
      compression = undefined;
    }
  }
  const eof = sample.length <= FILE_PROBE_SIZE;
  const { bytes, counts, encoding } = scanCsvFileFormat(sample.subarray(0, FILE_PROBE_SIZE), eof, true);
  const choice = selectDelimiter(zip ? zipEntry ?? '*' : path, counts);
  const delimiter = 'delimiter' in choice ? choice.delimiter : undefined;
  return {
    size: info.size,
    compression: typeof compression === 'object' ? 'zip' : compression ?? 'none',
    encoding,
    delimiter,
    ...inspectRecords(bytes, eof, delimiter),
  };
}

async function readCompressedSample(path: string, compression: CsvCompression): Promise<Uint8Array<ArrayBuffer>> {
  const sample = new Uint8Array(FILE_PROBE_SIZE + 1);
  let length = 0;
  for await (const chunk of readCsvFileChunks(path, { compression, chunkSize: sample.length })) {
    const take = Math.min(chunk.length, sample.length - length);
    sample.set(chunk.subarray(0, take), length);
    length += take;
    if (length === sample.length) {
      break;
    }
  }
  return sample.subarray(0, length);
}

// A newline inside a quoted field is data. Two escaped quotes toggle the state
// twice without exposing any intervening bytes as structural characters.
function inspectRecords(bytes: Uint8Array, eof: boolean, delimiter: string | undefined) {
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
    firstRecordColumns: firstComplete && !unknownWidth ? (bytes.length === 0 ? 0 : columns) : undefined,
    lineEnding: endings.size > 1 ? 'mixed' : endings.values().next().value ?? (eof ? 'none' : 'unknown'),
  };
}
