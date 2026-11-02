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
    expect(() => csv.rows(path, { selectedColumns: columns })).toThrow('selected column count out of range: 2025');
    expect(() => parseCsvFileProjected(path, { filters })).toThrow('filter count out of range: 2025');
  });

  test('captures file parser options before the first next call', async () => {
    const selectedColumns = [1];
    const options = { chunkSize: 2, delimiter: ';', selectedColumns };
    const stream = parseCsvFile(path, options);
    selectedColumns[0] = 2;
    options.delimiter = ',';
    expect(await collect(stream)).toEqual([['name'], ['Ana\nMaria'], ['Bia'], ['Caio']]);
    expect(options.selectedColumns).toBe(selectedColumns);
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

  test('copies raw projected filter objects and byte values at invocation', async () => {
    const value = Buffer.from('SP');
    const equalsFilter = { column: 2, value };
    const selectedColumns = [1];
    const options = { chunkSize: 1, delimiter: ';', equalsFilter, selectedColumns };
    const stream = parseCsvFileProjected(path, options);
    value.fill(0);
    equalsFilter.column = 0;
    selectedColumns[0] = 2;
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
    const options = { chunkSize: 1, delimiter: ';', filters, selectedColumns: [0] };
    const stream = parseCsvFileProjected(path, options);
    value.fill(0);
    values.length = 0;
    membership.column = 0;
    filters.length = 0;
    expect(await collect(stream)).toEqual([['1'], ['3']]);
    expect(options.filters).toBe(filters);
    expect(Object.isFrozen(values)).toBe(false);
  });

  test('isolates row view projection metadata from caller mutations', async () => {
    const columns = [0];
    const options = { chunkSize: 1, columns, delimiter: ';' };
    const rows: string[][] = [];
    const operation = csv.withRowViews(path, options, (row) => {
      expect(row.selectedColumns).toEqual([0]);
      expect(row.selectedColumns).not.toBe(columns);
      rows.push([row.get(0) ?? '']);
      columns.length = 0;
      options.columns = [2];
    });
    columns[0] = 1;
    await operation;
    expect(rows).toEqual([['id'], ['1'], ['2'], ['3']]);
  });

  test('isolates columnar projection metadata from caller mutations', async () => {
    const columns = [0];
    const options = { chunkSize: 1, columns, delimiter: ';' };
    const rows: string[][] = [];
    const operation = csv.withColumnarBatches(path, options, (batch) => {
      expect(batch.selectedColumns).toEqual([0]);
      expect(batch.selectedColumns).not.toBe(columns);
      for (let index = 0; index < batch.rowCount; ++index) {
        rows.push([batch.fieldBuffer(index, 0)?.toString() ?? '']);
      }
      columns.length = 0;
      options.columns = [2];
    });
    columns[0] = 1;
    await operation;
    expect(rows).toEqual([['id'], ['1'], ['2'], ['3']]);
  });

  test('captures parallel row options before the first next call', async () => {
    const columns = [0];
    const options = { chunkSize: 2, columns, delimiter: ';', where: csv.column(2).equals('SP'), workerCount: 2 };
    const stream = csv.parallelRows(path, options);
    columns[0] = 1;
    options.where = csv.column(2).equals('RJ');
    options.delimiter = ',';
    expect((await collect(stream)).sort(compareRowsByFirstColumn)).toEqual([['1'], ['3']]);
  });

  test('isolates worker pool projections for repeated operations', async () => {
    const columns = [0];
    const where = csv.column(2).equals('SP');
    const options = { chunkSize: 2, columns, delimiter: ';', where, workerCount: 2 };
    using pool = csv.workerPool(path, options);
    expect(options.columns).toBe(columns);
    expect(options.where).toBe(where);
    expect(Object.isFrozen(columns)).toBe(false);
    columns[0] = 1;
    options.where = csv.column(2).equals('RJ');
    expect((await collect(pool.rows())).sort(compareRowsByFirstColumn)).toEqual([['1'], ['3']]);
    columns.length = 0;
    options.columns = [2];
    expect((await collect(pool.rows())).sort(compareRowsByFirstColumn)).toEqual([['1'], ['3']]);
    expect(await pool.count()).toBe(2);
  });

  test('keeps explicit per-write parser reconfiguration between complete records', () => {
    using parser = new NativeCsvParser({ delimiter: ';' });
    const selectedColumns = [0];
    const equalsFilter = { column: 1, value: 'SP' };
    const options = { equalsFilter, selectedColumns };
    using first = parser.writeProjectedBatch(Buffer.from('1;SP\n'), options);
    expect(first.rows()).toEqual([['1']]);
    selectedColumns[0] = 1;
    equalsFilter.value = 'RJ';
    using second = parser.writeProjectedBatch(Buffer.from('2;RJ\n'), options);
    expect(second.rows()).toEqual([['RJ']]);
    using tail = parser.endProjectedBatch(options);
    expect(tail.rows()).toEqual([]);
  });
});

async function collect(stream: AsyncIterable<string[][]>): Promise<string[][]> {
  const rows: string[][] = [];
  for await (const batch of stream) {
    rows.push(...batch);
  }
  return rows;
}

function compareRowsByFirstColumn(left: readonly string[], right: readonly string[]): number {
  return (left[0] ?? '').localeCompare(right[0] ?? '');
}
