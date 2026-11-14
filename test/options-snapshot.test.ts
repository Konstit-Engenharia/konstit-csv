import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
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
  parseCsvFile,
  parseCsvFileProjected,
} from '../src/index.ts';

let directory = '';
let path = '';
const source = 'id;name;state\n1;"Ana\nMaria";SP\n2;Bia;RJ\n3;Caio;SP';
const expectedRows = [
  ['id', 'name', 'state'],
  ['1', 'Ana\nMaria', 'SP'],
  ['2', 'Bia', 'RJ'],
  ['3', 'Caio', 'SP'],
];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'csv-options-snapshot-'));
  path = join(directory, 'input.csv');
  await Bun.write(path, source);
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('operation options snapshots', () => {
  test('rejects an unsupported projection before reading or returning fields', () => {
    const options = { delimiter: ';', selectedColumns: [1] };
    const message = 'selectedColumns is unsupported; use columns';
    expect(() => csv.rows(path, options)).toThrow(message);
    expect(() => parseCsvFileProjected(path, options)).toThrow(message);
    expect(() => new NativeCsvParser(options)).toThrow(message);
  });

  test('rejects oversized configuration lists before reading their entries', () => {
    const columns = Array<number>(2025);
    const filters = Array<{ column: number; value: string; }>(2025);
    for (const values of [columns, filters]) {
      Object.defineProperty(values, 0, {
        get() {
          throw new Error('oversized configuration entries must not be read');
        },
      });
    }
    expect(() => csv.rows(path, { columns })).toThrow('selected column count out of range: 2025');
    expect(() => parseCsvFileProjected(path, { filters })).toThrow('filter count out of range: 2025');
    expect(() => new NativeCsvParser({ columns })).toThrow('selected column count out of range: 2025');
    expect(() => new NativeCsvParser({ filters })).toThrow('filter count out of range: 2025');
  });

  test('captures file parser options before the first next call', async () => {
    const columns = [1];
    const options = { chunkSize: 2, delimiter: ';', columns };
    const stream = parseCsvFile(path, options);
    columns[0] = 2;
    options.delimiter = ',';
    expect(await collect(stream)).toEqual([['name'], ['Ana\nMaria'], ['Bia'], ['Caio']]);
    expect(options.columns).toBe(columns);
    expect(options.delimiter).toBe(',');
  });

  test('captures batch projection and opaque filters before the first next call', async () => {
    const columns = [1];
    const where = csv.all(csv.column(2).equals('SP'), csv.column(1).hasMatch(/^(Ana\nMaria|Caio)$/));
    const options = { chunkSize: 1, columns, delimiter: ';', where };
    const stream = csv.batches(path, options);
    expect(options.where).toBe(where);
    columns[0] = 0;
    options.where = csv.column(2).equals('RJ');
    const rows: string[][] = [];
    for await (using batch of stream) {
      rows.push(...batch.rows());
      options.columns = [];
    }
    expect(rows).toEqual([['Ana\nMaria'], ['Caio']]);
    expect(await csv.parse(Buffer.from(source), { columns: [0], delimiter: ';', where })).toEqual([['1'], ['3']]);
  });

  test('captures expected headers for delayed rows and pending counts', async () => {
    const expectedHeaders = ['id', 'name', 'state'];
    const options = { chunkSize: 1, delimiter: ';', expectedHeaders, minDataRows: 3, strict: true as const };
    const stream = csv.rows(path, options);
    const count = csv.count(path, options);
    expectedHeaders[0] = 'changed';
    options.expectedHeaders = [];
    options.minDataRows = 100;
    expect(Object.isFrozen(options)).toBe(false);
    expect(Object.isFrozen(expectedHeaders)).toBe(false);
    expect(await count).toBe(4);
    expect(await collect(stream)).toEqual(expectedRows);
  });

  test('captures file count parser options before asynchronous input preparation', async () => {
    const options = { chunkSize: 1, delimiter: ';', fixedColumns: 3, strict: false };
    const count = countCsvFile(path, options);
    options.fixedColumns = 1;
    options.strict = true;
    expect(await count).toBe(4);
  });

  test('projected file parsing only uses declared options', async () => {
    const predicate = { column: 2, value: 'SP' };
    const options = { delimiter: ';', columns: [0], skipRows: 1, filterProgram: [predicate] };
    const stream = parseCsvFileProjected(path, options);
    predicate.value = 'RJ';
    expect(await collect(stream)).toEqual([['1'], ['2'], ['3']]);

    const filtered = {
      ...options,
      equalsFilter: { column: 2, value: 'SP' },
      get filterProgram(): never {
        throw new Error('undeclared option was read');
      },
    };
    expect(await collect(parseCsvFileProjected(path, filtered))).toEqual([['1'], ['3']]);
  });

  test('copies raw projected filter objects and byte values at invocation', async () => {
    const value = Buffer.from('SP');
    const equalsFilter = { column: 2, value };
    const columns = [1];
    const options = { chunkSize: 1, delimiter: ';', equalsFilter, columns };
    const stream = parseCsvFileProjected(path, options);
    value.fill(0);
    equalsFilter.column = 0;
    columns[0] = 2;
    expect(await collect(stream)).toEqual([['Ana\nMaria'], ['Caio']]);
    expect(options.equalsFilter).toBe(equalsFilter);
    expect(equalsFilter.value).toBe(value);
    expect(Object.isFrozen(equalsFilter)).toBe(false);
  });

  test('copies raw membership lists and retains regex handles across split fields', async () => {
    const value = Uint8Array.from(Buffer.from('SP'));
    const values = [value];
    const membership = { column: 2, values };
    const filters = [membership, { column: 1, regex: csv.re(/^(Ana\nMaria|Caio)$/) }];
    const options = { chunkSize: 1, delimiter: ';', filters, columns: [0] };
    const stream = parseCsvFileProjected(path, options);
    value.fill(0);
    values.length = 0;
    membership.column = 0;
    filters.length = 0;
    expect(await collect(stream)).toEqual([['1'], ['3']]);
    expect(options.filters).toBe(filters);
    expect(Object.isFrozen(values)).toBe(false);
  });

  test('isolates unfiltered batch projection from caller mutations', async () => {
    const columns = [0];
    const options = { chunkSize: 1, columns, delimiter: ';' };
    const rows: string[][] = [];
    const stream = csv.batches(path, options);
    columns[0] = 1;
    for await (using batch of stream) {
      rows.push(...batch.rows());
      options.columns = [];
    }
    expect(rows).toEqual([['id'], ['1'], ['2'], ['3']]);
  });

  test('copies exclusions before reading and rejects invalid byte operands at invocation', async () => {
    const state = Buffer.from('RJ');
    const ids = [Buffer.from('id'), Buffer.from('3')];
    const stream = parseCsvFileProjected(path, {
      delimiter: ';',
      columns: [0],
      filters: [{ column: 2, notEquals: state }, { column: 0, notIn: ids }],
    });
    state.fill(0);
    ids[0]?.fill(0);
    ids.length = 0;
    expect(await collect(stream)).toEqual([['1']]);
    expect(() => parseCsvFileProjected(path, { equalsFilter: { column: 0, value: 1 as never } })).toThrow(
      'filter value must be a string, Buffer, or Uint8Array',
    );
  });

  test('owns its constructor projection and filters across writes, finish and reset', () => {
    const columns = [1];
    const value = Buffer.from('SP');
    const filters = [{ column: 0, value }];
    using parser = new NativeCsvParser({ delimiter: ';', columns, filters, skipRows: 1, limit: 2 });
    expect(parser.write(Buffer.from('header\nSP;"a'))).toEqual([]);
    columns[0] = 0;
    filters.length = 0;
    value.fill(0);
    expect(parser.write(Buffer.from('\nb"\nRJ;drop\nSP;tail'))).toEqual([['a\nb']]);
    expect(parser.end()).toEqual([['tail']]);
    parser.reset();
    expect(parser.write(Buffer.from('header\nSP;unfinished'))).toEqual([]);
    parser.reset();
    expect(parser.writeCount(Buffer.from('header\nRJ;drop\nSP;keep'))).toBe(0);
    expect(parser.endCount()).toBe(1);
    parser.reset();
    expect(parser.write(Buffer.from('header\nSP;again'), true)).toEqual([['again']]);
  });
});

async function collect(stream: AsyncIterable<string[][]>): Promise<string[][]> {
  const rows: string[][] = [];
  for await (const batch of stream) {
    rows.push(...batch);
  }
  return rows;
}
