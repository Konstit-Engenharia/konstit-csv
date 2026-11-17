const LATIN1_SINGLE: readonly string[] = Array.from({ length: 256 }, (_, byte) => String.fromCharCode(byte));
// Bun's encoding-specific Buffer method copies just the requested byte range.
type BufferSlice = (this: Buffer, start: number, end: number) => string;
const bufferPrototype: Buffer & { latin1Slice?: BufferSlice; utf8Slice?: BufferSlice; } = Buffer.prototype;
const latin1Slice = bufferPrototype.latin1Slice;
const utf8Slice = bufferPrototype.utf8Slice;
// Each 16-bit key identifies an immutable two-byte string. ASCII pairs can also be reused for UTF-8.
const LATIN1_PAIRS = Array.from<string | undefined>({ length: 256 * 256 });

export function latin1Pair(key: number): string {
  const cached = LATIN1_PAIRS[key];
  if (cached !== undefined) {
    return cached;
  }
  const value = String.fromCharCode(key & 255, key >>> 8);
  LATIN1_PAIRS[key] = value;
  return value;
}

export function copyLatin1Range(data: Buffer, start: number, end: number): string {
  return typeof latin1Slice === 'function' ? latin1Slice.call(data, start, end) : data.toString('latin1', start, end);
}

// Callers validate offsets against the backing storage before decoding.
export function decodeMaterializedField(data: Buffer, start: number, end: number, encoding: 'utf8' | 'latin1'): string {
  const length = end - start;
  if (length === 0) {
    return '';
  }
  if (length === 1) {
    const first = data[start] as number;
    // A non-ASCII byte alone is invalid UTF-8. Latin-1 maps every byte directly.
    return first < 128 || encoding === 'latin1' ? (LATIN1_SINGLE[first] as string) : '\uFFFD';
  }
  if (length === 2) {
    const first = data[start] ?? 128;
    const second = data[start + 1] ?? 128;
    if (first < 128 && second < 128) {
      return latin1Pair(first | (second << 8));
    }
  }
  if (encoding === 'latin1') {
    return copyLatin1Range(data, start, end);
  }
  return typeof utf8Slice === 'function' ? utf8Slice.call(data, start, end) : data.toString('utf8', start, end);
}
