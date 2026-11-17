import {
  expect,
  test,
} from 'bun:test';
import { rejects } from 'node:assert/strict';
import {
  countCsvFile,
  csv,
  NativeCsvParser,
  parseCsvBuffer,
  parseCsvFile,
  parseCsvFileProjected,
} from '../src/index.ts';
import {
  csvFixturePath,
  readCsvFixture,
} from './fixtures.ts';

const fixture = 'api/quoted-people-sp-filter.csv';
const path = csvFixturePath(fixture);
const source = readCsvFixture(fixture);

async function collect(stream: AsyncIterable<string[][]>): Promise<string[][]> {
  const rows: string[][] = [];
  for await (const batch of stream) {
    expect(batch.length).toBeGreaterThan(0);
    for (const row of batch) {
      rows.push(row.slice());
    }
  }
  return rows;
}

test.each(['utf8', 'latin1'] as const)('skips input before filtering and limits matching rows with %s', async (encoding) => {
  const expected: [string, string][] = [['Ana', '1'], ['Bia', '3']];
  for (const chunkSize of [1, 28, 1024]) {
    const options = { encoding, delimiter: ';', skipRows: 1, limit: 2, columns: [1, 0] as const, chunkSize, fixedColumns: 3 };
    const filtered = { ...options, where: csv.column(2).equals('SP') };
    expect(await csv.parse(source, filtered)).toEqual(expected);
    expect(await collect(csv.rows(path, { ...filtered, reuseArrays: true }))).toEqual(expected);
    expect(await csv.count(path, filtered)).toBe(2);
    const actual: string[][] = [];
    for await (using batch of csv.batches(path, filtered)) {
      expect(batch.rowOffsets()[0]).toBe(0n);
      expect(batch.fieldOffsets()[0]).toBe(0n);
      expect(batch.totalFields).toBe(batch.rowCount * 2);
      batch.forEachRow((row) => actual.push(row.pick([0, 1])));
    }
    expect(actual).toEqual(expected);
    expect(await collect(parseCsvFileProjected(path, { ...options, equalsFilter: { column: 2, value: 'SP' } }))).toEqual(expected);
    expect(await collect(parseCsvFile(path, options))).toEqual([['Ana', '1'], ['Joao', '2']]);
    expect(parseCsvBuffer(source, options)).toEqual([['Ana', '1'], ['Joao', '2']]);
    expect(await countCsvFile(path, options)).toBe(2);
  }
});

test('counts logical records across CRLF, empty rows, quotes, and an unterminated last record', () => {
  const bytes = Buffer.from('"skip\r\n""me"""\r\n\r\n"a\nb",c\r\ntail,end');
  for (let split = 0; split <= bytes.length; ++split) {
    const options = { skipRows: 2, limit: 1 };
    using parser = new NativeCsvParser(options);
    const rows = parser.write(bytes.subarray(0, split));
    rows.push(...parser.write(bytes.subarray(split)), ...parser.end());
    expect(rows).toEqual([['a\nb', 'c']]);
    parser.reset();
    expect(parser.writeCount(bytes.subarray(0, split)) + parser.writeCount(bytes.subarray(split)) + parser.endCount()).toBe(1);
  }
  expect(parseCsvBuffer(bytes, { skipRows: 3, limit: 1 })).toEqual([['tail', 'end']]);
  expect(parseCsvBuffer(bytes, { skipRows: Number.MAX_SAFE_INTEGER })).toEqual([]);
});

test('shares one skip and limit across manual projected batches and count calls', () => {
  using parser = new NativeCsvParser({ skipRows: 1, limit: 2, columns: [1], equalsFilter: { column: 0, value: 'yes' } });
  expect(parser.writeCount(Buffer.from('no\nyes\nno\n'))).toBe(1);
  using batch = parser.writeBatch(Buffer.from('no,0\nyes,1\nyes,2\n'));
  expect(batch.rows()).toEqual([['1']]);
  expect(parser.writeCount(Buffer.from('yes\n'))).toBe(0);
  expect(parser.end()).toEqual([]);
});

test.each(['utf8', 'latin1'] as const)('strict %s validation includes the skipped prefix and stops at the limit', async (encoding) => {
  const bytes = Buffer.from('id,name\r\n1,one\r\n2,two\r\ninvalid"suffix', encoding);
  const options = { encoding, strict: true, skipRows: 2, limit: 1, expectedHeaders: ['id', 'name'], minDataRows: 2 } as const;
  expect(await csv.parse(bytes, options)).toEqual([['2', 'two']]);
  expect(parseCsvBuffer(bytes, options)).toEqual([['2', 'two']]);
  await rejects(csv.parse(bytes, { ...options, expectedHeaders: ['wrong'] }), /header/);
  await rejects(csv.parse(bytes, { ...options, minDataRows: 3 }), /got 2/);
  await rejects(csv.parse(Buffer.from('id,name\nshort\nx,y\n'), options), /column count mismatch/);
  await rejects(csv.parse(Buffer.from('bad"header,x\nx,y\nx,y\n'), options), /quote syntax/);
  expect(await csv.parse(Buffer.from('id,name\n1,last'), { ...options, skipRows: 10, minDataRows: 1 })).toEqual([]);
  const fileOptions = { ...options, delimiter: ';', expectedHeaders: ['id', 'name', 'uf'], chunkSize: 1 };
  expect(await collect(csv.rows(path, fileOptions))).toEqual([['2', 'Joao', 'RJ']]);
  expect(await csv.count(path, fileOptions)).toBe(1);
  await rejects(collect(csv.rows(path, { ...fileOptions, minDataRows: 3 })), /got 2/);
});

test.each(['utf8', 'latin1'] as const)('strict %s quoted batches capture the skipped header and validate widths', async (encoding) => {
  const options = { encoding, strict: true, expectedHeaders: ['id', 'région'], skipRows: 1, limit: 1 } as const;
  const input = Buffer.from('"id","région"\n"1","São Paulo"\n"wrong width"\n', encoding);
  for (const schema of [options, { ...options, fixedColumns: 2 }]) {
    expect(await csv.parse(input, schema)).toEqual([['1', 'São Paulo']]);
    await rejects(csv.parse(input, { ...schema, skipRows: 2 }), /column count mismatch/);
    await rejects(csv.parse(input, { ...schema, expectedHeaders: ['wrong', 'header'] }), /header/);
  }
});

test('a large filtered write preserves long quoted fields, row limits, and width errors', () => {
  const payload = 'x,'.repeat(192 * 1024);
  const first = `keep,"a""b\n${payload}"\r\n`;
  const options = { fixedColumns: 2, columns: [1], equalsFilter: { column: 0, value: 'keep' } };
  using limited = new NativeCsvParser({ ...options, limit: 1 });
  using batch = limited.writeBatch(Buffer.from(`${first}wrong-width\n`), true);
  expect(batch.rows()).toEqual([[`a"b\n${payload}`]]);
  limited.reset();
  using early = limited.writeBatch(Buffer.from(`keep,first\nwrong-width\n${first}`), true);
  expect(early.rows()).toEqual([['first']]);

  using invalid = new NativeCsvParser(options);
  expect(() => invalid.writeBatch(Buffer.from(`wrong-width\n${first}`), true)).toThrow('column count mismatch');
});

test('zero limits emit no rows and skip past EOF finishes normally', async () => {
  for (const options of [{ limit: 0 }, { skipRows: 99 }]) {
    expect(await csv.parse(source, options)).toEqual([]);
    expect(await collect(csv.rows(path, options))).toEqual([]);
    expect(await collect(csv.rows(path, { ...options, encoding: 'latin1' }))).toEqual([]);
    expect(await Array.fromAsync(csv.batches(path, options))).toEqual([]);
    expect(await csv.count(path, options)).toBe(0);
  }
  expect(await csv.parse(Buffer.alloc(0), { skipRows: 0, limit: 1 })).toEqual([]);
  await rejects(csv.parse(source, { strict: true, limit: 0, requireHeader: true }), /missing header/);
});

test('validates both options and captures them before iteration', async () => {
  for (const key of ['skipRows', 'limit'] as const) {
    for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
      const options = { [key]: value };
      expect(() => new NativeCsvParser(options)).toThrow(key);
      await rejects(csv.parse(source, options), RangeError);
    }
  }
  const options = { skipRows: 1, limit: 1, delimiter: ';' };
  const stream = csv.rows(path, options);
  options.skipRows = 3;
  options.limit = 0;
  expect(await collect(stream)).toEqual([['1', 'Ana', 'SP']]);
});
