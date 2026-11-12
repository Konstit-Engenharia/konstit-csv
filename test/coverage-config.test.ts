import {
  describe,
  expect,
  test,
} from 'bun:test';
import {
  defineCountOptions,
  defineRowsOptions,
} from '../src/options.ts';
import {
  CsvStrictSchemaValidator,
  rejectStrictSchemaUnsupported,
  strictSchemaValidator,
} from '../src/strict-schema.ts';

describe('option identity helpers', () => {
  test('preserve each options object', () => {
    const rows = defineRowsOptions({ delimiter: ';' });
    const count = defineCountOptions({ strict: true });
    expect(rows.delimiter).toBe(';');
    expect(count.strict).toBe(true);
  });
});

describe('strict schema validation', () => {
  test('validates rows, headers, minimum rows, and disabled mode', () => {
    const validator = new CsvStrictSchemaValidator({ expectedHeaders: ['a', 'b'], minDataRows: 1 });
    expect(validator.enabled).toBe(true);
    validator.validateRows([['a', 'b'], ['1', '2']]);
    expect(() => validator.finish()).not.toThrow();
    expect(strictSchemaValidator({ strict: false })).toBeUndefined();
    expect(strictSchemaValidator({ strict: true })).toBeUndefined();
    expect(() => rejectStrictSchemaUnsupported({ strict: true, requireHeader: true }, 'count')).toThrow('not supported');
  });

  test('rejects missing, malformed, and mismatched schemas', () => {
    expect(() => new CsvStrictSchemaValidator({ requireHeader: true }).finish()).toThrow('missing header');
    expect(() => new CsvStrictSchemaValidator({ expectedHeaders: ['a'] }).validateRows([['a', 'b']])).toThrow('header field');
    expect(() => new CsvStrictSchemaValidator({ expectedHeaders: ['a'] }).validateRows([['b']])).toThrow('header mismatch');
    const tooFew = new CsvStrictSchemaValidator({ minDataRows: 2 });
    tooFew.validateRows([['a'], ['1']]);
    expect(() => tooFew.finish()).toThrow('at least');
    expect(() => new CsvStrictSchemaValidator({ minDataRows: -1 })).toThrow('non-negative integer');
  });

  test('validates native batch headers and data rows', () => {
    const batchData = {
      rowCount: 2,
      rowFieldCount: (row: number) => row === 0 ? 2 : 1,
      fieldString: (row: number, column: number) => row === 0 ? (column === 0 ? 'a' : 'b') : '1',
    };
    const batch = batchData as unknown as import('../src/batches.ts').NativeCsvBatch;
    const validator = new CsvStrictSchemaValidator({ expectedHeaders: ['a', 'b'] });
    validator.validateBatch(batch);
    expect(() => validator.finish()).not.toThrow();
    const wrongLength = { ...batchData, rowCount: 1, rowFieldCount: () => 1 } as unknown as import('../src/batches.ts').NativeCsvBatch;
    expect(() => new CsvStrictSchemaValidator({ expectedHeaders: ['a', 'b'] }).validateBatch(wrongLength)).toThrow('header field');
    const wrongValue = { ...batchData, rowCount: 1, fieldString: () => 'x' } as unknown as import('../src/batches.ts').NativeCsvBatch;
    expect(() => new CsvStrictSchemaValidator({ expectedHeaders: ['a', 'b'] }).validateBatch(wrongValue)).toThrow('header mismatch');
  });
});
