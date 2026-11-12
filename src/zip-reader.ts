import {
  native,
  type Pointer,
  u64ToSafeNumber,
} from './native.js';
import type { CsvZipCompression } from './types.js';

type ZipReaderPointer = Pointer | bigint;

const DEFAULT_MAXIMUM_DECOMPRESSED_BYTES = 64 * 1024 * 1024 * 1024;
const DEFAULT_MAXIMUM_COMPRESSION_RATIO = 1_000;
const ZIP_READER_DONE = 1;
const ZIP_READER_ERROR = 2;

const nativeZipReaderFinalizer = new FinalizationRegistry<ZipReaderPointer>(destroyNativeZipReader);

function destroyNativeZipReader(handle: ZipReaderPointer): void {
  native.symbols.csv_zip_reader_destroy(handle);
}

export class NativeZipReader {
  #handle: ZipReaderPointer | null;

  constructor(path: string, options: CsvZipCompression) {
    if (path.includes('\0')) {
      throw new Error('ZIP path must not contain a null byte');
    }
    if (options.entry.length === 0) {
      throw new Error('ZIP entry name must not be empty');
    }

    const entry = Buffer.from(options.entry);
    const maximumOutputSize = positiveSafeInteger(
      options.maxDecompressedBytes ?? DEFAULT_MAXIMUM_DECOMPRESSED_BYTES,
      'ZIP maximum decompressed byte count',
    );
    const maximumCompressionRatio = positiveUint32(
      options.maxCompressionRatio ?? DEFAULT_MAXIMUM_COMPRESSION_RATIO,
      'ZIP maximum compression ratio',
    );
    const handle = native.symbols.csv_zip_reader_create(
      Buffer.from(`${path}\0`),
      entry,
      entry,
      BigInt(maximumOutputSize),
      maximumCompressionRatio,
    );
    if (handle === null) {
      throw new Error('failed to create native ZIP reader');
    }

    this.#handle = handle;
    nativeZipReaderFinalizer.register(this, handle, this);
    if (this.status === ZIP_READER_ERROR) {
      const message = this.lastError();
      this.close();
      throw new Error(`native ZIP reader failed: ${message}`);
    }
  }

  get status(): number {
    return native.symbols.csv_zip_reader_status(this.#requireHandle());
  }

  enableReadAhead(chunkSize: number): void {
    native.symbols.csv_zip_reader_enable_read_ahead(this.#requireHandle(), chunkSize);
  }

  read(output: Uint8Array): number {
    return u64ToSafeNumber(
      native.symbols.csv_zip_reader_read(this.#requireHandle(), output, output),
      'ZIP decompressed chunk length',
    );
  }

  lastError(): string {
    return native.symbols.csv_zip_reader_last_error(this.#requireHandle())?.toString() ?? 'ZIP reader error unavailable';
  }

  close(): void {
    const handle = this.#handle;
    if (handle === null) {
      return;
    }
    this.#handle = null;
    nativeZipReaderFinalizer.unregister(this);
    destroyNativeZipReader(handle);
  }

  [Symbol.dispose](): void {
    this.close();
  }

  #requireHandle(): ZipReaderPointer {
    if (this.#handle === null) {
      throw new Error('native ZIP reader is closed');
    }
    return this.#handle;
  }
}

export async function* readZipEntryChunks(
  path: string,
  options: CsvZipCompression,
  chunkSize: number,
  readAhead = false,
): AsyncGenerator<Uint8Array, void> {
  const outputSize = positiveUint32(chunkSize, 'ZIP output chunk size');
  using reader = new NativeZipReader(path, options);
  // File parsers consume the chunk before advancing. Raw byte iterators can retain it.
  const reusableBuffer = readAhead ? new Uint8Array(outputSize) : undefined;
  let startProducer = readAhead;

  while (true) {
    const output = reusableBuffer ?? new Uint8Array(outputSize);
    const written = reader.read(output);
    const status = reader.status;
    if (status === ZIP_READER_ERROR) {
      throw new Error(`native ZIP reader failed: ${reader.lastError()}`);
    }
    if (written > output.byteLength) {
      throw new Error('native ZIP reader returned an invalid output length');
    }
    if (written !== 0) {
      yield output.subarray(0, written);
    }
    if (status === ZIP_READER_DONE) {
      return;
    }
    if (written === 0) {
      throw new Error('native ZIP reader made no progress');
    }
    // A sample or a limited CLI read can finish after the first chunk.
    if (startProducer) {
      reader.enableReadAhead(outputSize);
      startProducer = false;
    }
  }
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function positiveUint32(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0 || value > 0xffff_ffff) {
    throw new RangeError(`${label} must be an integer from 1 through 4294967295`);
  }
  return value;
}
