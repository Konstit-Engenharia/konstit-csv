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
  type CsvRow,
  parseCsvBuffer,
  parseCsvFile,
  parseCsvFileProjected,
} from '../src/index.ts';

const inputs = [
  {
    encoding: 'windows-1252',
    bytes: Buffer.from('id;name\n1;\x80\n2;\x93quoted\x94', 'latin1'),
    names: ['€', '“quoted”'],
  },
  {
    encoding: 'utf-16le',
    // The BOM, surrogate pair, and quoted newline cross one-byte reads.
    // The low byte of 主 is 0x3b, which would resemble a semicolon in a raw-byte probe.
    bytes: Buffer.from('\uFEFFid;name\n1;"東京;😀\n"\n2;漢主', 'utf16le'),
    names: ['東京;😀\n', '漢主'],
  },
  {
    encoding: 'shift_jis',
    bytes: Buffer.from('id;name\n1;\x82\xa0\n2;\x93\xfa\x96\x7b', 'latin1'),
    names: ['あ', '日本'],
  },
] as const;

let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'csv-encoding-'));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function collectRows(batches: AsyncIterable<CsvRow[]>): Promise<CsvRow[]> {
  return (await Array.fromAsync(batches)).flat();
}

for (const { encoding, bytes, names } of inputs) {
  const rows = [['id', 'name'], ['1', names[0]], ['2', names[1]]];

  test(`${encoding} buffer APIs honor the byte range of a view`, async () => {
    const padded = Buffer.concat([Buffer.from('bad prefix'), bytes, Buffer.from('bad suffix')]);
    const view = new DataView(padded.buffer, padded.byteOffset + 'bad prefix'.length, bytes.length);
    const options = { delimiter: ';', encoding };
    expect(await csv.parse(view, options)).toEqual(rows);
    expect(parseCsvBuffer(view, options)).toEqual(rows);
  });

  test(`${encoding} file APIs parse one-byte reads and filter decoded fields`, async () => {
    const path = join(directory, `${encoding}.csv`);
    await Bun.write(path, bytes);
    const options = { chunkSize: 1, delimiter: 'auto', encoding } as const;
    expect(await collectRows(csv.rows(path, options))).toEqual(rows);
    expect(await collectRows(parseCsvFile(path, options))).toEqual(rows);
    expect(await collectRows(parseCsvFileProjected(path, { ...options, selectedColumns: [1] }))).toEqual([
      ['name'],
      [names[0]],
      [names[1]],
    ]);
    expect(await csv.count(path, { ...options, where: csv.column(1).equals(names[0]) })).toBe(1);
    expect(await countCsvFile(path, options)).toBe(3);

    const gzip = `${path}.gz`;
    await Bun.write(gzip, Bun.gzipSync(bytes));
    expect(await collectRows(csv.rows(gzip, { ...options, compression: 'gzip' }))).toEqual(rows);
  });
}

test('flushes an incomplete UTF-16LE code unit at end of input', async () => {
  const bytes = Uint8Array.of(0x61, 0, 0x2c, 0, 0x62);
  const path = join(directory, 'truncated.csv');
  await Bun.write(path, bytes);
  const options = { encoding: 'utf-16le', chunkSize: 1 } as const;
  expect(await csv.parse(bytes, options)).toEqual([['a', '�']]);
  expect(await collectRows(csv.rows(path, options))).toEqual([['a', '�']]);
});

test('transcoded inputs require an ASCII delimiter and cannot be sharded', async () => {
  const options = { encoding: 'utf-16le', delimiter: 'é' } as const;
  const path = join(directory, 'delimiters.csv');
  const bytes = Buffer.from('aéb', 'utf16le');
  await Bun.write(path, bytes);
  expect(() => parseCsvBuffer(bytes, options)).toThrow('ASCII delimiter');
  await rejects(csv.parse(bytes, options), /ASCII delimiter/);
  await rejects(collectRows(csv.rows(path, options)), /ASCII delimiter/);
  // @ts-expect-error Source byte offsets require a native encoding.
  expect(() => csv.findCsvSafeSplitOffsets(path, 2, options)).toThrow(/encoding/);
  // @ts-expect-error Shards refer to the original file bytes.
  expect(() => csv.findCsvSafeShards(path, 2, options)).toThrow(/encoding/);
});

test('the three native Latin-1 labels preserve the byte 0x80', () => {
  const bytes = Uint8Array.of(0x80);
  for (const encoding of ['latin1', 'iso88591', 'iso-8859-1'] as const) {
    expect(parseCsvBuffer(bytes, { encoding })).toEqual([[String.fromCharCode(0x80)]]);
  }
  expect(parseCsvBuffer(bytes, { encoding: 'windows-1252' })).toEqual([['€']]);
});
