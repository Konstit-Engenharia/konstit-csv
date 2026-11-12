import {
  afterAll,
  beforeAll,
  expect,
  spyOn,
  test,
} from 'bun:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import {
  mkdtemp,
  open,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import { csv } from '../src/api.ts';
import {
  compressionFromPrefix,
  FILE_PROBE_SIZE,
  prepareCsvFileInput,
  probeCsvFileFormat,
  readCsvFileChunks,
} from '../src/file-stream.ts';
import { inspectCsvFile } from '../src/inspect-file.ts';
import { native } from '../src/native.ts';
import { CsvStrictSchemaValidator } from '../src/strict-schema.ts';
import {
  NativeZipReader,
  readZipEntryChunks,
} from '../src/zip-reader.ts';
import { createZip } from './zip-fixture.ts';

let directory: string;
let zip: string;
const zipOptions = { format: 'zip', entry: 'rows.csv' } as const;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'csv-input-boundaries-'));
  zip = join(directory, 'rows.zip');
  await Bun.write(zip, createZip([{ name: zipOptions.entry, data: Buffer.from('x,y\n'), method: 0 }]));
});
afterAll(() => rm(directory, { recursive: true, force: true }));

test('a rejected header closes its native batch, including an unterminated final record', async () => {
  const path = join(directory, 'header.csv');
  for (const header of ['x,y\n', 'x,y']) {
    await Bun.write(path, header);
    const iterator = csv.batches(path, { strict: true, expectedHeaders: ['a', 'b'] });
    using validate = spyOn(CsvStrictSchemaValidator.prototype, 'validateBatch');
    await assert.rejects(iterator.next(), /header mismatch at column 0/);
    expect(validate.mock.calls[0]?.[0].closed).toBe(true);
  }
});

test('file input with an explicit format can only be opened once', async () => {
  const path = join(directory, 'fixed.csv');
  await Bun.write(path, 'a,b\n');
  await using input = await prepareCsvFileInput(path, { encoding: 'utf8', delimiter: ',' });
  expect(Buffer.concat(await Array.fromAsync(input.chunks())).toString()).toBe('a,b\n');
  expect(() => input.chunks()).toThrow('can only be read once');
});

test('empty input chunks do not end the probe and a cancellation error does not mask its failure', async () => {
  const path = join(directory, 'probe.csv');
  await Bun.write(path, 'a,b\n');
  await using stream = fs.createReadStream(path);
  using openStream = spyOn(fs, 'createReadStream');
  openStream.mockReturnValueOnce(stream);
  using chunks = spyOn(stream, Symbol.asyncIterator);
  async function* sample(): AsyncGenerator<Buffer, undefined> {
    yield Buffer.alloc(0);
    yield Buffer.alloc(FILE_PROBE_SIZE, 0x61);
  }
  const iterator = sample();
  using cancel = spyOn(iterator, 'return');
  cancel.mockRejectedValueOnce(new Error('cancel failed'));
  chunks.mockReturnValueOnce(iterator);
  await assert.rejects(
    prepareCsvFileInput(path, { compression: 'none' }, 'parse', (_path, prefix) => {
      expect(prefix.length).toBe(FILE_PROBE_SIZE);
      throw new Error('invalid sample');
    }),
    /invalid sample/,
  );
});

test('the UTF-8 probe reads past its limit only for a possibly incomplete sequence', async () => {
  const path = join(directory, 'boundary.csv');
  for (
    const [suffix, chunkSize, needsEof,] of [
      ['x', FILE_PROBE_SIZE, false],
      ['😀', FILE_PROBE_SIZE, false],
      ['é', FILE_PROBE_SIZE - 1, true],
    ] as const
  ) {
    const bytes = Buffer.concat([Buffer.alloc(FILE_PROBE_SIZE - Buffer.byteLength(suffix), 0x61), Buffer.from(suffix)]);
    await Bun.write(path, bytes);
    let eof: boolean | undefined;
    await using input = await prepareCsvFileInput(path, { chunkSize, compression: 'none' }, 'parse', (name, prefix, ended, delimiter) => {
      eof = ended;
      return probeCsvFileFormat(name, prefix, ended, delimiter);
    });
    expect(eof).toBe(needsEof);
    expect(input.parserEncoding).toBe('utf8');
  }
});

test('read-ahead streams a FIFO to EOF and rejects non-seekable ZIP input', async () => {
  const pipe = join(directory, 'rows.csv');
  const mkfifo = Bun.spawnSync(['mkfifo', pipe]);
  assert.equal(mkfifo.exitCode, 0, mkfifo.stderr.toString());
  async function send(data: Buffer) {
    await using writer = await open(pipe, 'w');
    await writer.writeFile(data);
  }
  const raw = readCsvFileChunks(pipe, { compression: 'none', chunkSize: 2 }, 'read-ahead');
  const [chunks,] = await Promise.all([Array.fromAsync(raw, (chunk) => Buffer.from(chunk)), send(Buffer.from('a,b\n'))]);
  expect(Buffer.concat(chunks).toString()).toBe('a,b\n');
  const auto = readCsvFileChunks(pipe, { compression: 'auto', chunkSize: 4 }, 'read-ahead');
  await Promise.all([assert.rejects(Array.fromAsync(auto), /ZIP input requires a regular file/), send(Buffer.from([0x50, 0x4b, 3, 4]))]);
});

test('a read-ahead failure is delivered after the preceding chunk', async () => {
  const path = join(directory, 'prefetch.csv');
  await Bun.write(path, 'a,b\n');
  await using file = await open(path, 'r');
  using openFile = spyOn(fsPromises, 'open');
  openFile.mockResolvedValueOnce(file);
  const readFile = file.read.bind(file);
  const failure = new Error('read failed');
  using read = spyOn(file, 'read');
  read.mockImplementationOnce(readFile).mockRejectedValueOnce(failure);
  const iterator = readCsvFileChunks(path, { compression: 'none', chunkSize: 2 }, 'read-ahead')[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toEqual(Buffer.from('a,'));
  await assert.rejects(iterator.next(), (error) => error === failure);
});

test('the .tab extension breaks a delimiter tie and unexpected inflation errors propagate', async () => {
  const path = join(directory, 'mixed.tab');
  await Bun.write(path, 'a,b\tc\n1,2\t3\n');
  await using input = await prepareCsvFileInput(path, { delimiter: 'auto' });
  expect(input.delimiter).toBe('\t');
  const failure = new Error('out of memory');
  using inflate = spyOn(zlib, 'inflateSync');
  inflate.mockImplementationOnce(() => {
    throw failure;
  });
  expect(() => compressionFromPrefix('header.csv', Buffer.from('H,name\n'))).toThrow(failure);
});

test('file inspection distinguishes false deflate signatures from corrupt binary data', async () => {
  const path = join(directory, 'unmarked');
  await Bun.write(path, 'H,name\n1,Ada\n');
  expect((await inspectCsvFile(path)).compression).toBe('none');
  await assert.rejects(inspectCsvFile(path, 'data.csv'), /requires a ZIP archive/);
  await assert.rejects(inspectCsvFile(directory), /requires a regular file/);
  await Bun.write(path, Buffer.from([0x48, 0x2c, 0xff, 0x01]));
  await assert.rejects(inspectCsvFile(path), TypeError);
});

test('compressed probe stops at its sample limit without counting a partial CRLF', async () => {
  const path = join(directory, 'long.csv.gz');
  const text = `${'a'.repeat(FILE_PROBE_SIZE - 1)}\r\nb\n`;
  await Bun.write(path, Bun.gzipSync(Buffer.from(text)));
  const format = await inspectCsvFile(path);
  expect(format.lineEnding).toBe('unknown');
  expect(format.compression).toBe('gzip');
});

test('ZIP reader rejects invalid paths and limits before opening an archive', async () => {
  await assert.rejects(readZipEntryChunks('bad\0path', zipOptions, 8).next(), /null byte/);
  await assert.rejects(readZipEntryChunks(zip, { ...zipOptions, maxDecompressedBytes: 0 }, 8).next(), /positive safe integer/);
  await assert.rejects(readZipEntryChunks(zip, { ...zipOptions, maxCompressionRatio: 2 ** 32 }, 8).next(), /4294967295/);
  using create = spyOn(native.symbols, 'csv_zip_reader_create');
  create.mockReturnValueOnce(null);
  await assert.rejects(readZipEntryChunks(zip, zipOptions, 8).next(), /failed to create native ZIP reader/);
});

test('closing a ZIP reader is idempotent and prevents further reads', () => {
  using reader = new NativeZipReader(zip, zipOptions);
  using destroy = spyOn(native.symbols, 'csv_zip_reader_destroy');
  reader.close();
  reader.close();
  expect(() => reader.read(new Uint8Array(4))).toThrow('native ZIP reader is closed');
  expect(destroy).toHaveBeenCalledTimes(1);
});

test('ZIP streaming rejects impossible byte counts and a stalled native reader', async () => {
  using read = spyOn(native.symbols, 'csv_zip_reader_read');
  read.mockReturnValueOnce(5n);
  await assert.rejects(readZipEntryChunks(zip, zipOptions, 4).next(), /invalid output length/);
  read.mockReturnValueOnce(0n);
  await assert.rejects(readZipEntryChunks(zip, zipOptions, 4).next(), /made no progress/);
});
