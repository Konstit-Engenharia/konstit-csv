import {
  afterAll,
  beforeAll,
  expect,
  test,
} from 'bun:test';
import { rejects } from 'node:assert/strict';
import {
  mkdtemp,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  countCsvFile,
  csv,
  NativeCsvParser,
  parseCsvBuffer,
  parseCsvFile,
  parseCsvFileProjected,
} from '../src/index.ts';
import { createZip } from './zip-fixture.ts';

let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'csv-auto-encoding-'));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

test('automatic encoding accepts the default or a fixed delimiter without scoring candidates', async () => {
  const path = join(directory, 'single.csv');
  await Bun.write(path, Buffer.from('café\nfrançais', 'latin1'));
  expect((await Array.fromAsync(csv.rows(path))).flat()).toEqual([['café'], ['français']]);
  const options = { encoding: 'auto' } as const;
  expect((await Array.fromAsync(csv.rows(path, options))).flat()).toEqual([['café'], ['français']]);
  expect(await csv.count(path, options)).toBe(2);
  await rejects(csv.count(path, { ...options, delimiter: 'auto' }), /stable positive count/);

  const custom = join(directory, 'fixed.csv');
  await Bun.write(custom, Buffer.from('left@right\n1@\x93hi\x94', 'latin1'));
  expect((await Array.fromAsync(csv.rows(custom, { ...options, delimiter: '@' }))).flat())
    .toEqual([['left', 'right'], ['1', '“hi”']]);
  expect((await Array.fromAsync(csv.rows(custom, options))).flat()).toEqual([['left@right'], ['1@“hi”']]);
  const empty = join(directory, 'empty.csv');
  await Bun.write(empty, '');
  expect(await countCsvFile(empty, options)).toBe(0);
});

test('probes the decompressed ZIP entry and uses its extension to break delimiter ties', async () => {
  const path = join(directory, 'table.zip');
  const bytes = Buffer.from('id|name,unit\r\n1|"\x80|x",y\r\n', 'latin1');
  await Bun.write(path, createZip([{ data: bytes, name: 'table.psv', method: 8 }]));
  const options = { compression: { format: 'zip', entry: 'table.psv' }, delimiter: 'auto', chunkSize: 1 } as const;
  const expected = [['id', 'name,unit'], ['1', '€|x,y']];
  expect((await Array.fromAsync(parseCsvFile(path, options))).flat()).toEqual(expected);
  expect((await Array.fromAsync(parseCsvFileProjected(path, { ...options, selectedColumns: [1] }))).flat())
    .toEqual([['name,unit'], ['€|x,y']]);
  expect(await csv.count(path, { ...options, where: csv.column(1).equals('€|x,y') })).toBe(1);
  const names: (string | null)[] = [];
  await csv.withRowViews(path, options, (row) => {
    names.push(row.fieldString(1));
  });
  expect(names).toEqual(['name,unit', '€|x,y']);
});

test('honors split Unicode signatures and quotes on both automatic and explicit delimiters', async () => {
  const text = '\ufeffid;name\r\n1;"主;😀\n""café"""';
  const utf16 = Buffer.from(text, 'utf16le');
  for (const [name, bytes,] of [['utf8', Buffer.from(text)], ['le', utf16], ['be', Buffer.from(utf16).swap16()]] as const) {
    const path = join(directory, name);
    await Bun.write(path, bytes);
    for (const delimiter of [';', 'auto'] as const) {
      const options = { delimiter, encoding: 'auto', chunkSize: 1, strict: true, expectedHeaders: ['id', 'name'] } as const;
      expect((await Array.fromAsync(csv.rows(path, options))).flat()).toEqual([['id', 'name'], ['1', '主;😀\n"café"']]);
    }
  }
});

test('validates encoding beyond the 128 delimiter rows and allows a split UTF-8 scalar at 64 KiB', async () => {
  const header = 'id,name\n';
  const prefix = `${header}${'1,plain\n'.repeat(128)}2,`;
  const value = 'a'.repeat(65535 - Buffer.byteLength(prefix));
  const path = join(directory, 'boundary.csv');
  await Bun.write(path, Bun.gzipSync(Buffer.from(`${prefix}${value}😀\n`)));
  const options = { encoding: 'auto', delimiter: 'auto', compression: 'gzip', chunkSize: 997 } as const;
  expect((await Array.fromAsync(csv.rows(path, options))).flat().at(-1)).toEqual(['2', `${value}😀`]);
  await Bun.write(path, Bun.gzipSync(Buffer.from(`${prefix}ol\xe9\n`, 'latin1')));
  expect((await Array.fromAsync(csv.rows(path, options))).flat().at(-1)).toEqual(['2', 'olé']);
});

test('distinguishes a final Latin-1 accent at exactly 64 KiB from a UTF-8 scalar spanning two reads', async () => {
  const path = join(directory, 'exact.csv');
  const prefix = Buffer.alloc(65_535, 'a');
  const options = { encoding: 'auto', chunkSize: 65_536 } as const;
  await Bun.write(path, Buffer.concat([prefix, Buffer.of(0xe9)]));
  expect((await Array.fromAsync(csv.rows(path, options))).flat()[0]?.[0]?.at(-1)).toBe('é');
  await Bun.write(path, Buffer.concat([prefix, Buffer.from('香\nnext\n')]));
  const rows = (await Array.fromAsync(csv.rows(path, options))).flat();
  expect(rows[0]?.[0]?.at(-1)).toBe('香');
  expect(rows[1]).toEqual(['next']);
});

test('counts an unterminated first record ending exactly at the sample boundary', async () => {
  const path = join(directory, 'boundary.tsv');
  await Bun.write(path, `x\t${'a'.repeat(65_534)}`);
  expect(await csv.count(path, { delimiter: 'auto', chunkSize: 65_536 })).toBe(1);
  const unfinished = `x\t${'a'.repeat(65_535)}`;
  await Bun.write(path, unfinished);
  await rejects(csv.count(path, { delimiter: 'auto', chunkSize: 65_536 }), /no complete non-empty row/);
});

test('keeps file-only detection and unsupported input errors actionable', async () => {
  const path = join(directory, 'unsupported.csv');
  const options = { encoding: 'auto' } as const;
  for (const signature of [[0xff, 0xfe, 0, 0], [0, 0, 0xfe, 0xff]]) {
    await Bun.write(path, Uint8Array.from(signature));
    await rejects(csv.count(path, options), /UTF-32/);
  }
  await Bun.write(path, Buffer.from('a,b\n1,\0binary'));
  await rejects(csv.count(path, options), /specify the encoding explicitly/);
  const data = Buffer.from('a,b');
  // @ts-expect-error Buffer parsing accepts explicit encodings only.
  await rejects(csv.parse(data, options), /automatic encoding detection.*file/);
  // @ts-expect-error The synchronous buffer API also requires an explicit encoding.
  expect(() => parseCsvBuffer(data, options)).toThrow(/automatic encoding detection.*file/);
  // @ts-expect-error Incremental native parsing requires an explicit encoding.
  expect(() => new NativeCsvParser(options)).toThrow(/automatic encoding detection.*file/);
  // @ts-expect-error Offsets refer to raw file bytes.
  expect(() => csv.findCsvSafeShards(path, 2, options)).toThrow(/encoding/);
});
