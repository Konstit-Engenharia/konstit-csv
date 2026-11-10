const LATIN1_SINGLE: readonly string[] = Array.from({ length: 256 }, (_, byte) => String.fromCharCode(byte));
// The module owns at most 16,384 immutable two-byte strings. Keys are the bytes,
// not batch offsets, so mutations and batch disposal never invalidate an entry.
// ASCII entries have the same value for both supported encodings.
const ASCII_PAIRS = Array.from<string | undefined>({ length: 128 * 128 });

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
      const key = (first << 7) | second;
      const cached = ASCII_PAIRS[key];
      if (cached !== undefined) {
        return cached;
      }
      const decoded = String.fromCharCode(first, second);
      ASCII_PAIRS[key] = decoded;
      return decoded;
    }
  }
  return data.toString(encoding, start, end);
}
