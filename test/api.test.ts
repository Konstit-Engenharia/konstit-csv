import {
  describe,
  expect,
  test,
} from 'bun:test';
import {
  csv,
  type CsvApiFileOptions,
  type CsvBatchesOptions,
  type CsvCountOptions,
  type CsvFilter,
  type CsvRowsOptions,
  type NativeCsvBatch,
  type NativeCsvRowView,
  parseCsvFileProjected,
} from '../src/index.ts';
import {
  csvFixturePath,
  readCsvFixture,
} from './fixtures.ts';

describe('csv high-level API', () => {
  test('streams selected rows with equals filter', async () => {
    const path = csvFixturePath('api/quoted-people-sp-filter.csv');
    const batches: string[][][] = [];

    for await (
      const rows of csv.rows(path, {
        delimiter: ';',
        columns: [0, 1] as const,
        where: csv.column(2).equals('SP'),
      })
    ) {
      batches.push(rows);
    }

    expect(batches.flat()).toEqual([
      ['1', 'Ana'],
      ['3', 'Bia'],
    ]);
  });

  test('streams rows with mixed AND filters', async () => {
    const path = csvFixturePath('api/quoted-people-sp-filter.csv');
    const rows: string[][] = [];

    for await (
      const batch of csv.rows(path, {
        columns: [0, 1] as const,
        delimiter: ';',
        where: csv.all(
          csv.column(2).isOneOf(['SP', 'RJ']),
          csv.column(2).doesNotEqual('RJ'),
          csv.column(2).isNoneOf(['MG']),
          csv.column(1).startsWith('B'),
          csv.column(0).equals('3'),
        ),
      })
    ) {
      rows.push(...batch);
    }

    expect(rows).toEqual([['3', 'Bia']]);
  });

  test('applies mixed AND filters across serial batch surfaces', async () => {
    const path = csvFixturePath('api/quoted-people-sp-filter.csv');
    const where = csv.all(
      csv.column(2).equals('SP'),
      csv.column(1).startsWith('B'),
    );

    expect(
      await csv.parse(readCsvFixture('api/quoted-people-sp-filter.csv'), {
        columns: [0, 1] as const,
        delimiter: ';',
        where,
      }),
    ).toEqual([['3', 'Bia']]);

    const batchRows: string[][] = [];
    const rowViewRows: string[][] = [];
    const columnarRows: string[][] = [];
    for await (using batch of csv.batches(path, { columns: [0, 1], delimiter: ';', where })) {
      batchRows.push(...batch.rows());
      batch.forEachRow((row) => {
        rowViewRows.push([row.get(0) ?? '', row.get(1) ?? '']);
      });
      for (let rowIndex = 0; rowIndex < batch.rowCount; ++rowIndex) {
        columnarRows.push([
          batch.fieldBuffer(rowIndex, 0)?.toString() ?? '',
          batch.fieldBuffer(rowIndex, 1)?.toString() ?? '',
        ]);
      }
    }
    expect(batchRows).toEqual([['3', 'Bia']]);
    expect(rowViewRows).toEqual(batchRows);
    expect(columnarRows).toEqual(batchRows);

    const projectedRows: string[][] = [];
    for await (
      const rows of parseCsvFileProjected(path, {
        delimiter: ';',
        filters: [
          { column: 2, value: 'SP' },
          { column: 1, prefix: 'B' },
        ],
        columns: [0, 1],
      })
    ) {
      projectedRows.push(...rows);
    }
    expect(projectedRows).toEqual([['3', 'Bia']]);
  });

  test('streams selected rows without materializing skipped columns', async () => {
    const path = csvFixturePath('api/quoted-people-two-rows.csv');
    const rows: string[][] = [];

    for await (
      const batch of csv.rows(path, {
        delimiter: ';',
        columns: [0, 2] as const,
      })
    ) {
      rows.push(...batch);
    }

    expect(rows).toEqual([
      ['id', 'uf'],
      ['1', 'SP'],
      ['2', 'RJ'],
    ]);
  });

  test('reuses base options across operations', async () => {
    const path = csvFixturePath('api/quoted-people-base-options.csv');
    const base = { delimiter: ';' } as const;
    const baseRows: string[][] = [];
    const selectedRows: string[][] = [];

    for await (const batch of csv.rows(path, base)) {
      baseRows.push(...batch);
    }

    for await (const batch of csv.rows(path, { ...base, columns: [0, 2] as const })) {
      selectedRows.push(...batch);
    }

    expect(baseRows).toEqual([
      ['id', 'name', 'uf'],
      ['1', 'Ana', 'SP'],
      ['2', 'Bia', 'RJ'],
    ]);
    expect(selectedRows).toEqual([
      ['id', 'uf'],
      ['1', 'SP'],
      ['2', 'RJ'],
    ]);
  });

  test('rejects invalid projections before parsing', async () => {
    const duplicateError = await rejectedError(csv.parse(readCsvFixture('api/duplicate-projection.csv'), { columns: [2, 2] }));
    expect(duplicateError.message).toContain('selected column repeated: 2');

    const path = csvFixturePath('empty.csv');
    let projectionError: unknown;
    try {
      for await (const _rows of csv.rows(path, { columns: [2025] })) {
        throw new Error('unreachable');
      }
    } catch (error) {
      projectionError = error;
    }
    expect(projectionError).toBeInstanceOf(RangeError);
    expect((projectionError as Error).message).toContain('selected column out of range: 2025');

    expect(() => csv.column(2025)).toThrow('filter column out of range: 2025');
  });

  test('reuses one filter across serial APIs', async () => {
    const path = csvFixturePath('api/quoted-people-sp-filter.csv');
    const where = csv.column(2).equals('SP');

    expect(await csv.count(path, { delimiter: ';', where })).toBe(2);
    const rows: string[][] = [];
    for await (const batch of csv.rows(path, { delimiter: ';', where })) {
      rows.push(...batch);
    }
    expect(rows).toEqual([
      ['1', 'Ana', 'SP'],
      ['3', 'Bia', 'SP'],
    ]);
  });

  test('evaluates nested any and not groups across serial APIs', async () => {
    const input = Buffer.from('1;Ana;SP\n2;Joao;RJ\n3;Bia;SP\n4;Caio;MG\n5\n');
    const state = csv.column(2);
    const name = csv.column(1);
    const nested = csv.all(
      csv.any(state.equals('SP'), state.equals('RJ')),
      csv.not(name.startsWith('B')),
    );

    expect(await csv.parse(input, { delimiter: ';', where: nested })).toEqual([
      ['1', 'Ana', 'SP'],
      ['2', 'Joao', 'RJ'],
    ]);
    expect(await csv.parse(input, { delimiter: ';', where: csv.not(state.equals('SP')) })).toEqual([
      ['2', 'Joao', 'RJ'],
      ['4', 'Caio', 'MG'],
    ]);
    expect(
      await csv.parse(input, {
        delimiter: ';',
        where: csv.any(csv.column(0).equals('5'), state.equals('SP')),
      }),
    ).toEqual([
      ['1', 'Ana', 'SP'],
      ['3', 'Bia', 'SP'],
      ['5'],
    ]);
    expect(await csv.parse(input, { delimiter: ';', where: csv.not(csv.column(20).equals('x')) })).toEqual([]);
  });

  test('counts rows with filters', async () => {
    const path = csvFixturePath('api/unquoted-people-sp-filter.csv');

    expect(await csv.count(path, { delimiter: ';' })).toBe(4);
    expect(await csv.count(path, { delimiter: ';', where: csv.column(2).equals('SP') })).toBe(2);
    expect(await csv.count(path, { delimiter: ';', where: csv.column(2).isOneOf(['SP', 'RJ']) })).toBe(3);
    expect(await csv.count(path, { delimiter: ';', where: csv.column(2).doesNotEqual('SP') })).toBe(2);
    expect(await csv.count(path, { delimiter: ';', where: csv.column(2).isNoneOf(['SP', 'RJ']) })).toBe(1);
    expect(await csv.count(path, { delimiter: ';', where: csv.column(1).startsWith('A') })).toBe(1);
    expect(
      await csv.count(path, {
        chunkSize: 1,
        delimiter: ';',
        where: csv.all(
          csv.column(2).isOneOf(['SP', 'RJ']),
          csv.column(1).startsWith('B'),
          csv.column(0).equals('3'),
        ),
      }),
    ).toBe(1);
    expect(
      await csv.count(path, {
        delimiter: ';',
        where: csv.all(
          csv.column(1).isOneOf(['Ana', 'Bia']),
          csv.column(1).startsWith('B'),
        ),
      }),
    ).toBe(1);
    expect(
      await csv.count(path, {
        delimiter: ';',
        where: csv.all(csv.column(2).equals('SP'), csv.column(20).startsWith('')),
      }),
    ).toBe(0);
    expect(await csv.count(path, { delimiter: ';', where: csv.column(20).doesNotEqual('') })).toBe(0);
    expect(await csv.count(path, { delimiter: ';', where: csv.column(20).isNoneOf(['']) })).toBe(0);
  });

  test('projects row views in the same order with and without a filter', async () => {
    const path = csvFixturePath('api/quoted-people-two-rows.csv');
    for (const where of [undefined, csv.column(1).startsWith('')]) {
      const seen: string[][] = [];
      for await (using batch of csv.batches(path, { columns: [2, 0], delimiter: ';', where })) {
        batch.forEachRow((row) => {
          expect(row.fieldCount).toBe(2);
          expect(row.get(2)).toBeNull();
          seen.push(row.pick([0, 1]));
        });
      }
      expect(seen).toEqual([['uf', 'id'], ['SP', '1'], ['RJ', '2']]);
    }
  });

  test('an empty projection keeps every record with zero stored fields', async () => {
    const path = csvFixturePath('api/quoted-people-two-rows.csv');
    const rows: string[][] = [];
    for await (using batch of csv.batches(path, { columns: [], delimiter: ';', chunkSize: 1 })) {
      expect(batch.totalFields).toBe(0);
      rows.push(...batch.rows());
    }
    expect(rows).toEqual([[], [], []]);
  });

  test('rejects strict native batch projection, including an empty selection', async () => {
    const path = csvFixturePath('api/strict-selected-columns.csv');
    for (const columns of [[0], []]) {
      const options = { columns, strict: true } as unknown as CsvBatchesOptions;
      const error = await rejectedError(csv.batches(path, options).next());
      expect(error.message).toContain('use csv.rows() for strict projection');
    }
  });

  test('streams columnar batches without per-field strings', async () => {
    const path = csvFixturePath('api/quoted-people-two-rows.csv');
    const seen: string[] = [];
    const ranged: string[] = [];
    const scanned: string[] = [];
    const partial: string[] = [];
    let retained: NativeCsvBatch | undefined;

    for await (using batch of csv.batches(path, { columns: [0, 2], delimiter: ';' })) {
      retained = batch;
      expect(batch.rowCount).toBeGreaterThan(0);
      const data = batch.data();
      for (let rowIndex = 0; rowIndex < batch.rowCount; ++rowIndex) {
        const left = batch.fieldBuffer(rowIndex, 0)?.toString() ?? '';
        const right = batch.fieldBuffer(rowIndex, 1)?.toString() ?? '';
        seen.push(`${left}|${right}`);
      }
      batch.forEachColumnRange(1, (rowIndex, start, end) => {
        ranged.push(`${rowIndex}:${data.toString('utf8', start, end)}`);
      });
      batch.scanColumns([0, 1], (rowIndex, offsets, buffer) => {
        const left = offsets[0] === -1 ? '' : buffer.toString('utf8', offsets[0] ?? 0, offsets[1] ?? 0);
        const right = offsets[2] === -1 ? '' : buffer.toString('utf8', offsets[2] ?? 0, offsets[3] ?? 0);
        scanned.push(`${rowIndex}:${left}|${right}`);
      });
      batch.forEachColumnRange(
        0,
        (_rowIndex, start, end) => {
          partial.push(data.toString('utf8', start, end));
        },
        1,
        3,
      );
    }

    expect(seen).toEqual([
      'id|uf',
      '1|SP',
      '2|RJ',
    ]);
    expect(ranged).toEqual([
      '0:uf',
      '1:SP',
      '2:RJ',
    ]);
    expect(scanned).toEqual([
      '0:id|uf',
      '1:1|SP',
      '2:2|RJ',
    ]);
    expect(partial).toEqual([
      '1',
      '2',
    ]);
    expect(() => retained?.rowOffsets()).toThrow('native CSV batch is closed');
    expect(() => retained?.forEachColumnRange(0, () => {})).toThrow('native CSV batch is closed');
  });

  test('validates filters when they are constructed', () => {
    const selectedColumn = csv.column(0);
    const combine = csv.all as unknown as (...filters: CsvFilter[]) => CsvFilter;
    const combineAny = csv.any as unknown as (...filters: CsvFilter[]) => CsvFilter;

    for (const column of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2025]) {
      expect(() => csv.column(column)).toThrow('filter column out of range');
    }
    expect(() => selectedColumn.isOneOf([])).toThrow('isOneOf values must not be empty');
    expect(() => selectedColumn.isNoneOf([])).toThrow('isNoneOf values must not be empty');
    expect(() => selectedColumn.isOneOf('x' as never)).toThrow('isOneOf values must be an array');
    expect(() => selectedColumn.isOneOf(['x', 1 as never])).toThrow(
      'isOneOf values[1] must be a string, Buffer, or Uint8Array',
    );
    expect(() => selectedColumn.equals(1 as never)).toThrow('equals value must be a string, Buffer, or Uint8Array');
    expect(() => selectedColumn.hasMatch('x' as never)).toThrow('csv.re() requires a RegExp');
    expect(() => combine()).toThrow();
    expect(() => combineAny()).toThrow();
    expect(() => combine(...Array.from({ length: 2025 }, () => selectedColumn.equals('x')))).toThrow(
      'filter count out of range: 2025',
    );
  });

  test('returns immutable filters that defensively copy binary operands', async () => {
    const path = csvFixturePath('api/unquoted-people-sp-filter.csv');
    const selectedColumn = csv.column(2);
    const equalsValue = Buffer.from('SP');
    const values = [Buffer.from('SP'), Uint8Array.from(Buffer.from('RJ'))];
    const prefix = Buffer.from('A');
    const equals = selectedColumn.equals(equalsValue);
    const isOneOf = selectedColumn.isOneOf(values);
    const startsWith = csv.column(1).startsWith(prefix);
    const combined = csv.all(isOneOf, startsWith);
    const alternative = csv.any(equals, startsWith);
    const negated = csv.not(equals);

    expect(Object.isFrozen(selectedColumn)).toBeTrue();
    expect(Object.isFrozen(equals)).toBeTrue();
    expect(Object.isFrozen(combined)).toBeTrue();
    expect(Object.isFrozen(alternative)).toBeTrue();
    expect(Object.isFrozen(negated)).toBeTrue();

    equalsValue.fill(0);
    values[0]?.fill(0);
    values[1]?.fill(0);
    values.splice(0);
    prefix.fill(0);

    expect(await csv.count(path, { delimiter: ';', where: equals })).toBe(2);
    expect(await csv.count(path, { delimiter: ';', where: isOneOf })).toBe(3);
    expect(await csv.count(path, { delimiter: ';', where: startsWith })).toBe(1);
    expect(await csv.count(path, { delimiter: ';', where: combined })).toBe(1);
  });

  test('rejects filters that were not constructed by the filter API', async () => {
    const forged = Object.freeze({}) as CsvFilter;
    expect(() => csv.all(forged)).toThrow('must be created with csv.column(), csv.all(), csv.any(), or csv.not()');
    expect(() => csv.any(forged)).toThrow('must be created with csv.column(), csv.all(), csv.any(), or csv.not()');
    expect(() => csv.not(forged)).toThrow('must be created with csv.column(), csv.all(), csv.any(), or csv.not()');

    const path = csvFixturePath('empty.csv');
    expect((await rejectedError(csv.count(path, { where: forged }))).message).toContain(
      'where must be created with csv.column(), csv.all(), csv.any(), or csv.not()',
    );
  });

  test('invalidates row views on callback errors and rejects asynchronous callbacks', async () => {
    const path = csvFixturePath('api/unquoted-one-person-no-header.csv');
    for await (using batch of csv.batches(path, { delimiter: ';' })) {
      let retained: NativeCsvRowView | undefined;
      const failure = new Error('callback failed');
      expect(() =>
        batch.forEachRow((row) => {
          retained = row;
          throw failure;
        })
      ).toThrow(failure);
      expect(() => retained?.moveTo(0)).toThrow('row view is only valid during row view callback');

      let afterAwait: Promise<string | null> | undefined;
      expect(() =>
        batch.forEachRow((row) => {
          afterAwait = Promise.resolve().then(() => row.get(0));
          return afterAwait;
        })
      ).toThrow('row view callback must be synchronous');
      expect(afterAwait).toBeDefined();
      if (afterAwait !== undefined) {
        expect((await rejectedError(afterAwait)).message).toContain('row view is only valid during row view callback');
      }
    }
  });

  test('propagates strict mode to high-level row parsing', async () => {
    let error: unknown;
    try {
      await csv.parse(readCsvFixture('api/strict-unterminated-quote.csv'), { strict: true });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('unterminated quoted field');
  });

  test('validates strict schema metadata in high-level rows', async () => {
    const path = csvFixturePath('api/strict-schema-valid.csv');
    const rows: string[][] = [];

    for await (
      const batch of csv.rows(path, {
        delimiter: ';',
        expectedHeaders: ['id', 'name', 'uf'],
        minDataRows: 1,
        strict: true,
      })
    ) {
      rows.push(...batch);
    }

    expect(rows).toEqual([
      ['id', 'name', 'uf'],
      ['1', 'Ana', 'SP'],
    ]);
  });

  test('rejects strict schema metadata mismatch in high-level rows', async () => {
    const path = csvFixturePath('api/strict-schema-header-mismatch.csv');

    let error: unknown;
    try {
      for await (
        const _rows of csv.rows(path, {
          delimiter: ';',
          expectedHeaders: ['id', 'name', 'uf'],
          strict: true,
        })
      ) {
        throw new Error('unreachable');
      }
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('strict CSV schema error: header mismatch at column 1');
  });

  test('counts strict rows without materializing strings', async () => {
    const path = csvFixturePath('api/comma-name.csv');

    expect(await csv.count(path, { strict: true })).toBe(2);
  });

  test('validates strict schema metadata while counting', async () => {
    const path = csvFixturePath('api/strict-schema-valid.csv');

    expect(
      await csv.count(path, {
        chunkSize: 1,
        delimiter: ';',
        expectedHeaders: ['id', 'name', 'uf'],
        minDataRows: 1,
        requireHeader: true,
        strict: true,
      }),
    ).toBe(2);

    const error = await rejectedError(
      csv.count(path, {
        delimiter: ';',
        expectedHeaders: ['id', 'full_name', 'uf'],
        strict: true,
      }),
    );
    expect(error.message).toContain('strict CSV schema error: header mismatch at column 1');

    const missingHeaderError = await rejectedError(
      csv.count(csvFixturePath('empty.csv'), {
        requireHeader: true,
        strict: true,
      }),
    );
    expect(missingHeaderError.message).toContain('strict CSV schema error: missing header row');

    const minimumRowsError = await rejectedError(
      csv.count(path, {
        delimiter: ';',
        minDataRows: 2,
        strict: true,
      }),
    );
    expect(minimumRowsError.message).toContain('strict CSV schema error: expected at least 2 data row(s), got 1');
  });

  test('keeps strict selected rows supported', async () => {
    const path = csvFixturePath('api/strict-selected-columns.csv');
    const rows: string[][] = [];

    for await (
      const batch of csv.rows(path, {
        columns: [0, 2] as const,
        delimiter: ',',
        strict: true,
      })
    ) {
      rows.push(...batch);
    }

    expect(rows).toEqual([
      ['id', 'uf'],
      ['1', 'SP'],
      ['2', 'RJ'],
    ]);
  });

  test('keeps strict unsupported filtered paths explicit', async () => {
    const path = csvFixturePath('api/comma-name.csv');

    let countError: unknown;
    try {
      const invalidOptions = { strict: true, where: csv.column(1).equals('Ada') } as CsvApiFileOptions;
      await csv.count(path, invalidOptions as unknown as CsvCountOptions);
    } catch (caught) {
      countError = caught;
    }
    expect(countError).toBeInstanceOf(Error);
    expect((countError as Error).message).toContain('strict CSV validation is not supported for count filters');

    let projectedError: unknown;
    try {
      const invalidOptions = { strict: true, columns: [0], where: csv.column(1).equals('Ada') } as CsvApiFileOptions;
      for await (const _rows of csv.rows(path, invalidOptions as CsvRowsOptions<number[]>)) {
        throw new Error('unreachable');
      }
    } catch (caught) {
      projectedError = caught;
    }
    expect(projectedError).toBeInstanceOf(Error);
    expect((projectedError as Error).message).toContain('strict CSV validation is not supported for projected batches');
  });
});

async function rejectedError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('expected promise to reject');
}
