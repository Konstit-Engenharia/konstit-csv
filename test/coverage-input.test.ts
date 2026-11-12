import {
  describe,
  expect,
  test,
} from 'bun:test';
import {
  mkdtemp,
  rm,
} from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import {
  prepareCsvFileInput,
  readCsvFileChunks,
  rejectAutoDelimiterSharding,
  rejectCompressedSharding,
  scanDelimiterCounts,
} from '../src/file-stream.ts';
import {
  countCsvFile,
  findCsvSafeSplitOffsets,
  parseCsvBuffer,
  parseCsvFile,
  parseCsvFileProjected,
} from '../src/files.ts';
import {
  findNativeLibraryPath,
  nativeLibraryCandidates,
  requireConfiguredNativeLibraryPath,
  requireNativeLibraryPath,
  requirePtr,
  u64ToSafeNumber,
} from '../src/native.ts';
import {
  encodingCode,
  normalizeChunk,
  normalizeColumns,
  normalizeEqualsFilter,
  normalizeFixedColumnsCount,
  normalizeInFilter,
  normalizeNativeFilters,
  normalizeRegex,
  normalizeStartsWithFilter,
  validateRegex,
} from '../src/normalize.ts';
import { requireBunRuntime } from '../src/runtime.ts';
import { readZipEntryChunks } from '../src/zip-reader.ts';
import { createZip } from './zip-fixture.ts';

async function consume(chunks: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of chunks) {
  }
}

async function rejectedError(operation: Promise<unknown>): Promise<Error> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof Error)) {
    throw new Error('expected operation to reject');
  }
  return caught;
}

describe('coverage input boundaries', () => {
  test('normalizes values, columns, filters, regexes and guards', () => {
    expect(encodingCode('utf8')).toBe(0);
    expect(encodingCode('iso-8859-1')).toBe(1);
    expect(() => encodingCode('nope' as never)).toThrow();
    expect(normalizeChunk(new Uint8Array(0)).byteLength).toBe(0);
    expect(normalizeFixedColumnsCount(undefined, 'x')).toBeUndefined();
    expect(normalizeColumns(undefined)).toBe(normalizeColumns([]));
    expect(() => normalizeFixedColumnsCount(0, 'x')).toThrow();
    expect(() => normalizeColumns([1, 1])).toThrow();
    expect(() => normalizeColumns(Array.from({ length: 2025 }, () => 1))).toThrow();
    expect(() => normalizeColumns([2025])).toThrow();
    expect(normalizeEqualsFilter(undefined).enabled).toBe(false);
    expect(normalizeEqualsFilter({ column: 1, value: '' }).valueLength).toBe(0);
    expect(normalizeInFilter({ column: 0, values: ['', 'a'] }).offsets).toEqual(new Uint32Array([0, 0, 1]));
    expect(normalizeStartsWithFilter({ column: 0, prefix: '' }).valueLength).toBe(0);
    expect(new TextDecoder().decode(normalizeRegex({ source: '\\u{1f600}', flags: 'u' }))).toContain('x{1f600}');
    validateRegex({ source: '', flags: '' });
    validateRegex({ source: 'a+', flags: '' });
    expect(() => normalizeRegex({ source: 'a', flags: 'g' })).toThrow();
    expect(() => normalizeRegex({ source: 'a', flags: 'uu' })).toThrow();
    expect(() => normalizeRegex(null as never)).toThrow();
    normalizeRegex({ source: '\\', flags: '' });
    normalizeRegex({ source: '\\\\', flags: '' });
    normalizeRegex({ source: '\\/', flags: '' });
    normalizeRegex({ source: '\\q', flags: '' });
    normalizeRegex({ source: '\\u{41}', flags: '' });
    normalizeRegex({ source: '\\u12', flags: '' });
    normalizeRegex({ source: '\\uD834\\uDD1E', flags: 'u' });
    expect(() => normalizeRegex({ source: '\\u{d800}', flags: 'u' })).toThrow();
    expect(() => normalizeRegex({ source: '\\u{}', flags: 'u' })).toThrow();
    expect(() => normalizeRegex({ source: '\\uD834x', flags: 'u' })).toThrow();
    expect(() => normalizeRegex({ source: '\\uD834\\u0041', flags: 'u' })).toThrow();
    expect(() => normalizeRegex({ source: '\\uDD1E', flags: 'u' })).toThrow();
    expect(() => normalizeInFilter({ column: 0, values: [] })).toThrow();
    const hugeValue = { byteLength: 0x1_0000_0000 } as never;
    const mappedHuge = { length: 1, map: () => [hugeValue] } as never;
    expect(() => normalizeInFilter({ column: 0, values: mappedHuge })).toThrow();
    expect(() => normalizeNativeFilters([{ column: 0, value: hugeValue }])).toThrow();
    const hugeValues = { length: 0x1_0000_0000, [Symbol.iterator]: function*() {} } as never;
    expect(() => normalizeNativeFilters([{ column: 0, values: hugeValues }])).toThrow();
    expect(scanDelimiterCounts(Buffer.from('a,b'), true)).toEqual([[1, 0, 0, 0, 0, 0, 0]]);
    const regex = { source: 'f', flags: '' } as never;
    const all = normalizeNativeFilters([
      { column: 0, value: 'a' },
      { column: 1, values: ['b'] },
      { column: 2, notEquals: 'c' },
      { column: 3, notIn: ['d'] },
      { column: 4, prefix: 'e' },
      { column: 5, regex },
    ]);
    expect(all.filterCount).toBe(6);
    expect(() => normalizeNativeFilters([undefined as never])).toThrow();
    expect(() => normalizeNativeFilters([{ column: 0, regex }])).not.toThrow();
  });

  test('file input lifecycle, parsing, compression and zip errors', async () => {
    const dir = await mkdtemp('/tmp/csv-coverage-');
    try {
      const path = join(dir, 'x.csv');
      await Bun.write(path, 'a,b\n1,2\n');
      const noNewline = join(dir, 'no-newline.csv');
      await Bun.write(noNewline, 'a,b\n1,2');
      const empty = join(dir, 'empty.csv');
      await Bun.write(empty, '');
      await Bun.write(join(dir, 'quoted.psv'), '"a""b"|c\r\n1|2\r\n');
      const psvInput = await prepareCsvFileInput(join(dir, 'quoted.psv'), { chunkSize: 64, delimiter: 'auto' });
      expect(psvInput.delimiter).toBe('|');
      for await (const _ of psvInput.chunks()) {
      }
      const zipPath = join(dir, 'input.zip');
      await Bun.write(zipPath, createZip([{ name: 'data.csv', data: Buffer.from('x,y\n3,4\n'), method: 0 }]));
      expect(parseCsvBuffer(Buffer.from('a,b\n1,2\n'))).toHaveLength(2);
      expect(() => requireBunRuntime()).not.toThrow();
      expect(() => requireBunRuntime({ bunVersion: undefined })).toThrow('requires Bun');
      expect(() =>
        requireBunRuntime({
          architecture: 'x64',
          avx2Supported: false,
          bunVersion: process.versions.bun,
        })
      ).toThrow('requires AVX2');
      expect(() =>
        requireBunRuntime({
          architecture: 'x64',
          avx2Supported: true,
          bunVersion: process.versions.bun,
        })
      ).not.toThrow();
      expect(() =>
        requireBunRuntime({
          architecture: 'arm64',
          avx2Supported: false,
          bunVersion: process.versions.bun,
        })
      ).not.toThrow();
      expect(await countCsvFile(path)).toBe(2);
      expect(await countCsvFile(noNewline, { strict: true })).toBe(2);
      const serial: unknown[] = [];
      for await (const batch of parseCsvFile(noNewline)) {
        serial.push(...batch);
      }
      expect(serial).toHaveLength(2);
      const autoNoNewline = await prepareCsvFileInput(noNewline, { chunkSize: 64, delimiter: 'auto' });
      expect(autoNoNewline.delimiter).toBe(',');
      for await (const _ of autoNoNewline.chunks()) {
      }
      expect(await Array.fromAsync(readCsvFileChunks(empty, { chunkSize: 64, compression: 'auto' }))).toEqual([]);
      const projectedSerial: unknown[] = [];
      for await (const batch of parseCsvFileProjected(noNewline, { selectedColumns: [0] })) {
        projectedSerial.push(...batch);
      }
      expect(projectedSerial).toEqual([['a'], ['1']]);
      const input = await prepareCsvFileInput(path, { chunkSize: 2, delimiter: ',' });
      for await (const _ of input.chunks()) {
      }
      await input[Symbol.asyncDispose]();
      expect(() => input.chunks()).toThrow();
      const autoInput = await prepareCsvFileInput(path, { chunkSize: 2, delimiter: 'auto' });
      for await (const _ of autoInput.chunks()) {
      }
      expect(() => autoInput.chunks()).toThrow();
      expect(readCsvFileChunks(path, { chunkSize: 2 })).toBeDefined();
      const zlibPath = join(dir, 'input.data');
      await Bun.write(zlibPath, deflateSync(Buffer.from('a,b\n1,2\n')));
      const autoCompressed: number[] = [];
      for await (const chunk of readCsvFileChunks(zlibPath, { chunkSize: 2, compression: 'auto' })) {
        autoCompressed.push(...chunk);
      }
      expect(autoCompressed.length).toBeGreaterThan(0);
      await Bun.write(join(dir, 'bad.deflate'), Buffer.from('not-zlib'));
      expect(
        (await rejectedError(consume(readCsvFileChunks(join(dir, 'bad.deflate'), { chunkSize: 2, compression: 'auto' })))).message,
      ).not.toBe('');
      const zstdMagic = join(dir, 'magic.bin');
      await Bun.write(zstdMagic, Buffer.from([0x50, 0x2a, 0x4d, 0x18, 0, 0, 0, 0]));
      for await (const _ of readCsvFileChunks(zstdMagic, { chunkSize: 2, compression: 'auto' })) {
      }
      const zipChunks: number[] = [];
      for await (const chunk of readZipEntryChunks(zipPath, { format: 'zip', entry: 'data.csv' }, 2)) {
        zipChunks.push(...chunk);
      }
      expect(Buffer.from(zipChunks).toString()).toBe('x,y\n3,4\n');
      expect(() => rejectCompressedSharding({ compression: 'gzip' }, 'x')).toThrow();
      expect(() => rejectAutoDelimiterSharding({ delimiter: 'auto' }, 'x')).toThrow();
      expect(() => findCsvSafeSplitOffsets(join(dir, 'missing.csv'), 0)).toThrow();
      expect(() => findCsvSafeSplitOffsets(path, 2, ',,')).toThrow();
      expect(() => findCsvSafeSplitOffsets(path, 2, '"')).toThrow();
      expect(findCsvSafeSplitOffsets(empty, 2)).toEqual([0]);
      const rows: unknown[] = [];
      for await (const batch of parseCsvFile(path)) {
        rows.push(...batch);
      }
      expect(rows).toHaveLength(2);
      const projected: unknown[] = [];
      for await (const batch of parseCsvFileProjected(path, { selectedColumns: [1] })) {
        projected.push(...batch);
      }
      expect(projected).toEqual([['b'], ['2']]);
      expect((await rejectedError(readZipEntryChunks(path, { format: 'zip', entry: '' }, 1).next())).message).not.toBe('');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('native numeric guards', () => {
    expect(requirePtr(1n)).toBe(1n);
    expect(() => requirePtr(null)).toThrow();
    expect(nativeLibraryCandidates('/repo', 'linux-x64', 'so')[0]).toBe('/repo/prebuilds/linux-x64/libcsv_native.so');
    expect(findNativeLibraryPath(['/definitely/missing/native'])).toBeUndefined();
    expect(() => requireNativeLibraryPath(['/definitely/missing/native'])).toThrow('native library not found');
    expect(requireConfiguredNativeLibraryPath(join(process.cwd(), 'package.json'))).toBe(join(process.cwd(), 'package.json'));
    expect(() => requireConfiguredNativeLibraryPath('relative/library.so')).toThrow('must be an absolute path');
    expect(() => requireConfiguredNativeLibraryPath('/definitely/missing/native')).toThrow('is not a file');
    expect(u64ToSafeNumber(3n, 'x')).toBe(3);
    expect(u64ToSafeNumber(3, 'x')).toBe(3);
    expect(() => u64ToSafeNumber(1n << 54n, 'x')).toThrow();
    expect(() => u64ToSafeNumber(-1, 'x')).toThrow();
  });
});
