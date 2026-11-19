import {
  native,
  type NativePointer,
} from './native.js';

const gzipReaderFinalizer = new FinalizationRegistry<NativePointer>(native.symbols.csv_gzip_reader_destroy);

/** Read a regular file from offset zero. The native reader owns a duplicate descriptor. */
export function* readGzipFileChunks(
  fd: number,
  chunkSize: number,
  reuseBuffer: boolean,
  readAhead = true,
): Generator<Uint8Array, void> {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0 || chunkSize > 0xffff_ffff) {
    throw new RangeError('gzip chunkSize must be a positive integer no larger than 4294967295');
  }
  const handle = native.symbols.csv_gzip_reader_create(fd);
  if (handle === null) {
    throw new Error('failed to create native gzip reader');
  }
  const lifetime = {};
  gzipReaderFinalizer.register(lifetime, handle, lifetime);
  try {
    const reusableBuffer = reuseBuffer ? new Uint8Array(chunkSize) : undefined;
    let startProducer = readAhead;
    while (true) {
      const buffer = reusableBuffer ?? new Uint8Array(chunkSize);
      const size = Number(native.symbols.csv_gzip_reader_read(handle, buffer, buffer));
      if (size < 0) {
        const message = native.symbols.csv_gzip_reader_last_error(handle)?.toString() ?? 'gzip read failed';
        throw new TypeError(message);
      }
      if (size === 0) {
        return;
      }
      if (size > buffer.length) {
        throw new Error('native gzip reader returned an invalid output length');
      }
      yield size === buffer.length ? buffer : buffer.subarray(0, size);
      // A limited read can stop after its first chunk without starting a thread.
      if (startProducer) {
        native.symbols.csv_gzip_reader_enable_read_ahead(handle, chunkSize);
        startProducer = false;
      }
    }
  } finally {
    gzipReaderFinalizer.unregister(lifetime);
    native.symbols.csv_gzip_reader_destroy(handle);
  }
}
