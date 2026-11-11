import {
  afterAll,
  beforeAll,
  describe,
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
  csv,
  type CsvFilter,
  type CsvRowsOptions,
} from '../src/index.ts';

let directory = '';
let bytesPath = '';
let filtersPath = '';
const allBytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index)).toString('latin1');
const byteRows = [['', allBytes, 'é"\r\nÿ'], ['tail', '\0\x80\x9f', '']];
const filterRows = [
  ['1', 'Érico', 'São', 'quoted "é"'],
  ['2', 'João', 'Rio', 'line\nbreak'],
  ['3', 'Åsa', 'São', '\x80\x9fÿ'],
  ['4', 'Érico'],
];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'csv-latin1-materialization-'));
  bytesPath = join(directory, 'bytes.csv');
  filtersPath = join(directory, 'filters.csv');
  for (const encoding of ['utf8', 'latin1'] as const) {
    await Bun.write(join(directory, `mutation-${encoding}.csv`), Buffer.from('é;ÿ\né;ÿ\né;ÿ\né;ÿ', encoding));
    await Bun.write(join(directory, `reuse-${encoding}.csv`), Buffer.from('é,x,y\nß\nc\nd,e,f\nñ', encoding));
  }
  for (const [path, rows,] of [[bytesPath, byteRows], [filtersPath, filterRows]] as const) {
    const text = rows.map((row) => row.map((field) => `"${field.replaceAll('"', '""')}"`).join(';')).join('\r\n');
    await Bun.write(path, Buffer.from(text, 'latin1'));
  }
});

afterAll(async () => {
  await rm(directory, { force: true, recursive: true });
});

describe('serial csv.rows array ownership', () => {
  test('rejects invalid read-ahead sizes before reading the file', async () => {
    for (const chunkSize of [0, -1, 1.5, NaN, Infinity]) {
      await rejects(csv.rows(bytesPath, { chunkSize }).next(), /chunkSize must be a positive safe integer/);
    }
  });

  for (const encoding of ['utf8', 'latin1'] as const) {
    const chunkSize = Buffer.byteLength('é,x,y\nß\n', encoding);

    test(`${encoding} reuses distinct row slots, resizes rows and batches, and includes the final record`, async () => {
      const options = { chunkSize, encoding, reuseArrays: true };
      const stream = csv.rows(join(directory, `reuse-${encoding}.csv`), options);
      options.reuseArrays = false;
      let previousBatch: string[][] | undefined;
      let previousFirstRow: string[] | undefined;
      const snapshots: string[][][] = [];
      for await (const batch of stream) {
        if (previousBatch !== undefined) {
          expect(batch).toBe(previousBatch);
          expect(batch[0]).toBe(previousFirstRow);
        }
        previousBatch = batch;
        previousFirstRow = batch[0];
        snapshots.push(batch.map((row) => row.slice()));
      }
      expect(snapshots).toEqual([[['é', 'x', 'y'], ['ß']], [['c'], ['d', 'e', 'f']], [['ñ']]]);
    });

    test(`${encoding} retains independent batches and rows by default`, async () => {
      const batches = await Array.fromAsync(csv.rows(join(directory, `reuse-${encoding}.csv`), { chunkSize, encoding }));
      expect(batches).toEqual([[['é', 'x', 'y'], ['ß']], [['c'], ['d', 'e', 'f']], [['ñ']]]);
    });

    test(`${encoding} refills projected rows after chunks with no filter matches`, async () => {
      const options = { chunkSize: 1, columns: [1, 0] as const, encoding, reuseArrays: true, where: csv.column(0).isOneOf(['é', 'ñ']) };
      const snapshots: string[][] = [];
      for await (const batch of csv.rows(join(directory, `reuse-${encoding}.csv`), options)) {
        for (const row of batch) {
          snapshots.push(row.slice());
        }
      }
      expect(snapshots).toEqual([['x', 'é'], ['', 'ñ']]);
    });

    test(`${encoding} projects reusable rows after strict validation`, async () => {
      const snapshots: string[][] = [];
      const options = { chunkSize, columns: [1, 2, 0], delimiter: ';', encoding, reuseArrays: true, strict: true } as const;
      for await (const batch of csv.rows(join(directory, `mutation-${encoding}.csv`), options)) {
        for (const row of batch) {
          snapshots.push(row.slice());
        }
      }
      expect(snapshots).toEqual([['ÿ', '', 'é'], ['ÿ', '', 'é'], ['ÿ', '', 'é'], ['ÿ', '', 'é']]);
      const ragged = csv.rows(join(directory, `reuse-${encoding}.csv`), { ...options, delimiter: ',' });
      await rejects(Array.fromAsync(ragged), /strict CSV row column count mismatch/);
    });
  }
});

async function collect(path: string, options: CsvRowsOptions<readonly number[] | undefined> = {}): Promise<string[][]> {
  const result: string[][] = [];
  for await (const rows of csv.rows(path, { delimiter: ';', encoding: 'latin1', ...options })) {
    result.push(...rows);
  }
  return result;
}

describe('private Latin1 row materialization compatibility', () => {
  test('captures replaced projections before iteration and across split records and final rows', async () => {
    for (const encoding of ['utf8', 'latin1'] as const) {
      for (const alias of ['columns', 'selectedColumns'] as const) {
        // The first chunk ends inside the next record, including a UTF-8 character.
        const chunkSize = Buffer.byteLength('é;ÿ\n', encoding) + 1;
        const options = { chunkSize, [alias]: [0], delimiter: ';' as const, encoding };
        const stream = csv.rows(join(directory, `mutation-${encoding}.csv`), options);
        options[alias] = [1];
        try {
          expect((await stream.next()).value).toEqual([['é']]);
          options[alias] = [];
          expect((await stream.next()).value).toEqual([['é']]);
          options[alias] = [1, 0];
          expect((await stream.next()).value).toEqual([['é']]);
          expect((await stream.next()).value).toEqual([['é']]);
          expect((await stream.next()).done).toBe(true);
        } finally {
          await stream.return();
        }
      }
    }
  });

  test('ignores conflicting projection aliases introduced after the operation starts', async () => {
    const options = { chunkSize: 4, columns: [0], delimiter: ';' as const, encoding: 'latin1' as const };
    const stream = csv.rows(join(directory, 'mutation-latin1.csv'), options);
    try {
      expect((await stream.next()).value).toEqual([['é']]);
      Object.assign(options, { selectedColumns: [1] });
      const remaining: string[][] = [];
      for await (const rows of stream) {
        remaining.push(...rows);
      }
      expect(remaining).toEqual([['é'], ['é'], ['é']]);
    } finally {
      await stream.return();
    }
  });

  test('copies mutable projection arrays without freezing caller arrays', async () => {
    for (const encoding of ['utf8', 'latin1'] as const) {
      const columns = [0];
      const chunkSize = Buffer.byteLength('é;ÿ\n', encoding) + 1;
      const options = { chunkSize, columns, delimiter: ';' as const, encoding };
      const stream = csv.rows(join(directory, `mutation-${encoding}.csv`), options);
      expect(Object.isFrozen(options)).toBe(false);
      expect(Object.isFrozen(columns)).toBe(false);
      expect(options.columns).toBe(columns);
      columns.push(1);
      try {
        expect((await stream.next()).value).toEqual([['é']]);
        columns.length = 0;
        expect((await stream.next()).value).toEqual([['é']]);
        columns.push(1);
        expect((await stream.next()).value).toEqual([['é']]);
        expect((await stream.next()).value).toEqual([['é']]);
        expect((await stream.next()).done).toBe(true);
      } finally {
        await stream.return();
      }
    }
  });

  test('keeps filter values isolated from caller mutation between chunks', async () => {
    const value = Buffer.from('Érico');
    const values = [value];
    const where = csv.column(1).isOneOf(values);
    const rows: string[][] = [];
    for await (const batch of csv.rows(filtersPath, { chunkSize: 1, delimiter: ';', encoding: 'latin1', where })) {
      rows.push(...batch);
      value.fill(0);
      values.push(Buffer.from('João'));
    }
    expect(rows).toEqual([filterRows[0] ?? [], filterRows[3] ?? []]);
  });

  test('retains every Latin1 code point across quoted chunk boundaries and batch destruction', async () => {
    for (const chunkSize of [1, 2, 7, 64, 1024]) {
      expect(await collect(bytesPath, { chunkSize })).toEqual(byteRows);
      expect(await collect(bytesPath, { chunkSize, fixedColumns: 3 })).toEqual(byteRows);
      expect(await collect(bytesPath, { chunkSize, columns: [2, 0, 1, 9] })).toEqual(
        byteRows.map((row) => [row[2] ?? '', row[0] ?? '', row[1] ?? '', '']),
      );
      expect(await collect(bytesPath, { chunkSize, columns: [] })).toEqual([[], []]);
    }
  });

  test('retains short Latin-1 fields with byte pairs in either order', async () => {
    const path = join(directory, 'short-fields.csv');
    const expected = Array.from({ length: 256 }, (_, byte) => {
      const a = String.fromCharCode(byte);
      const b = String.fromCharCode(255 - byte);
      return ['', a, a + b, b + a, a + b + a, b + a + a + b, (a + b).repeat(4)];
    });
    const records = expected.map((row) => row.map((field) => `"${field.replaceAll('"', '""')}"`).join(';'));
    const input = Buffer.from(`${records.join('\n')}\n`, 'latin1');
    await Bun.write(path, input);
    for (const chunkSize of [37, input.length]) {
      const retained: string[][] = [];
      for await (const batch of csv.rows(path, { chunkSize, delimiter: ';', encoding: 'latin1', reuseArrays: true })) {
        for (const row of batch) {
          retained.push(row.slice());
        }
      }
      expect(retained).toEqual(expected);
    }
  });

  test('keeps mixed quoted-span rows correct through rejection, reuse and iterator completion', async () => {
    const binary = '\0\x80\x9fÿ';
    const path = join(directory, 'quoted-span-mixed.csv');
    const input = [
      `"keep";"first";"${binary}";""\n`,
      '"drop";"rejected";"ignored";"ignored"\n',
      '"keep";"";"";""\n',
      '"keep";"escaped ""quote""";"line\nbreak";"tail"\n',
      '"keep";"ragged"\n',
      '"keep";"crlf";"é";"end"\r\n',
      '"keep";"eof";"\0ÿ";"last"',
    ].join('');
    const expected = [
      ['keep', 'first', binary, ''],
      ['keep', '', '', ''],
      ['keep', 'escaped "quote"', 'line\nbreak', 'tail'],
      ['keep', 'ragged'],
      ['keep', 'crlf', 'é', 'end'],
      ['keep', 'eof', '\0ÿ', 'last'],
    ];

    await Bun.write(path, Buffer.from(input, 'latin1'));
    for (const chunkSize of [1, 17, 64, input.length]) {
      const stream = csv.rows(path, {
        chunkSize,
        delimiter: ';',
        encoding: 'latin1',
        reuseArrays: true,
        where: csv.column(0).equals('keep'),
      });
      const snapshots: string[][] = [];
      for await (const batch of stream) {
        for (const row of batch) {
          snapshots.push(row.slice());
        }
      }
      expect(snapshots).toEqual(expected);
    }
  });

  test('validates physical Latin1 rows before projection and filtering', async () => {
    const path = join(directory, 'fixed.csv');
    const where = csv.column(0).equals('café');
    const data = 'drop;"a;""b\r\nc";x\r\ncafé;ÿ;\r\ncafé;"é;à";z';
    await Bun.write(path, Buffer.from(data, 'latin1'));
    for (const chunkSize of [1, 1024]) {
      const options = { chunkSize, fixedColumns: 3, where };
      expect(await collect(path, options)).toEqual([['café', 'ÿ', ''], ['café', 'é;à', 'z']]);
      expect(await collect(path, { ...options, columns: [1] })).toEqual([['ÿ'], ['é;à']]);
      expect(await collect(path, { ...options, columns: [2, 0] })).toEqual([['', 'café'], ['z', 'café']]);
      expect(await collect(path, { ...options, columns: [] })).toEqual([[], []]);
    }

    for (const invalid of ['drop;"too;short"', '"drop";x;y;"z"\r\n', 'café;x', 'café;x;y;z\n']) {
      await Bun.write(path, Buffer.from(`${data}\r\n${invalid}`, 'latin1'));
      for (const chunkSize of [1, 1024]) {
        await rejects(collect(path, { chunkSize, fixedColumns: 3, columns: [0], where }), /fixed row column count mismatch/);
      }
    }
  });

  test('rejects invalid Latin1 fixed column counts before native conversion', async () => {
    for (const fixedColumns of [0, 1.5, 0x1_0000_0001]) {
      await rejects(collect(bytesPath, { fixedColumns }), /fixed column count out of range/);
    }
  });

  test('keeps public native batch fields UTF-8 encoded', async () => {
    const rows: string[][] = [];
    for await (const batch of csv.batches(bytesPath, { delimiter: ';', encoding: 'latin1', chunkSize: 7 })) {
      try {
        for (const row of batch.rows()) {
          rows.push(row);
        }
        if (batch.rowCount > 0 && rows.length === 1) {
          expect(batch.fieldBuffer(0, 1)).toEqual(Buffer.from(allBytes, 'utf8'));
        }
      } finally {
        batch.close();
      }
    }
    expect(rows).toEqual(byteRows);
  });

  test('preserves UTF-8 filter values, Unicode regexes, boolean programs and missing columns', async () => {
    const cases: readonly [CsvFilter, readonly number[]][] = [
      [csv.column(1).equals('Érico'), [0, 3]],
      [csv.column(1).equals(Buffer.from('Érico')), [0, 3]],
      [csv.column(1).doesNotEqual('Érico'), [1, 2]],
      [csv.column(1).isOneOf(['Åsa', 'João', 'x', 'y', 'z', 'a', 'b', 'c', 'd', 'e']), [1, 2]],
      [csv.column(1).isNoneOf(['Åsa', 'João']), [0, 3]],
      [csv.column(2).startsWith('Sã'), [0, 2]],
      [csv.column(1).hasMatch(/^érico$/iu), [0, 3]],
      [csv.column(1).equals('€'), []],
      [csv.column(1).equals(Uint8Array.of(0xc9)), []],
      [csv.all(csv.column(2).equals('São'), csv.not(csv.column(1).equals('Åsa'))), [0]],
      [csv.any(csv.column(2).equals('São'), csv.column(1).equals('João')), [0, 1, 2]],
      [csv.not(csv.column(2).equals('São')), [1]],
    ];
    for (const [where, indexes,] of cases) {
      for (const chunkSize of [1, 7, 1024]) {
        const expected = indexes.map((index) => filterRows[index] ?? []);
        expect(await collect(filtersPath, { chunkSize, where })).toEqual(expected);
        expect(await collect(filtersPath, { chunkSize, columns: [3, 1, 9], where })).toEqual(
          expected.map((row) => [row?.[3] ?? '', row?.[1] ?? '', '']),
        );
      }
    }
  });

  test('retains strict, schema and fixed-column validation', async () => {
    expect.assertions(3);
    for (const options of [{ strict: true }, { fixedColumns: 4 }, { strict: true, expectedHeaders: ['wrong'] }] as const) {
      try {
        await collect(filtersPath, options);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    }
  });
});
