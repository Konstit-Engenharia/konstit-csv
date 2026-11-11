import { isUtf8 } from 'node:buffer';
import { detectDelimiter } from '../../src/file-stream.ts';
import type { CsvFileProbe } from '../../src/file-stream.ts';
export { probeCsvFileFormat as highwayProbe } from '../../src/file-stream.ts';

// isUtf8 validates a complete buffer. Allow a legal but incomplete final scalar in a prefix.
function looksUtf8(bytes: Uint8Array, eof: boolean): boolean {
  if (isUtf8(bytes)) {
    return true;
  }
  if (eof || (bytes.at(-1) ?? 0) < 0x80) {
    return false;
  }
  let start = bytes.length - 1;
  while (start > 0 && bytes.length - start < 4 && ((bytes[start] ?? 0) & 0xc0) === 0x80) {
    --start;
  }
  const lead = bytes[start] ?? 0;
  if (lead < 0xc2 || lead > 0xf4 || !isUtf8(bytes.subarray(0, start))) {
    return false;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start), { stream: true }) === '';
  } catch (error) {
    if (error instanceof TypeError) {
      return false;
    }
    throw error;
  }
}

export const referenceProbe: CsvFileProbe = (path, prefix, eof, delimiter) => {
  let encoding: ReturnType<CsvFileProbe>['encoding'] = 'utf8';
  let bytes = prefix;
  let skipBytes = 0;
  if (
    (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0 && bytes[3] === 0)
    || (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xfe && bytes[3] === 0xff)
  ) {
    throw new Error('automatic encoding detection does not support UTF-32; transcode the input to UTF-8');
  }
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    encoding = bytes[0] === 0xff ? 'utf-16le' : 'utf-16be';
    if (delimiter === 'auto') {
      bytes = new TextEncoder().encode(new TextDecoder(encoding).decode(bytes, { stream: !eof }));
    }
  } else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    skipBytes = 3;
    bytes = bytes.subarray(skipBytes);
  } else {
    if (bytes.includes(0)) {
      throw new Error('NUL in encoding probe: specify the encoding explicitly');
    }
    if (!looksUtf8(bytes, eof)) {
      encoding = 'latin1';
      for (let i = 0; i < bytes.length; ++i) {
        if (((bytes[i] ?? 0) & 0xe0) === 0x80) {
          encoding = 'windows-1252';
          break;
        }
      }
    }
  }
  return { delimiter: delimiter === 'auto' ? detectDelimiter(path, bytes, eof) : delimiter, encoding, skipBytes };
};
