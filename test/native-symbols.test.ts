import {
  describe,
  expect,
  test,
} from 'bun:test';

const requiredSymbols = [
  'csv_parser_prepare',
  'csv_parser_write_prepared_batch',
  'csv_parser_write_prepared_count',
  'csv_parser_create_latin1_rows',
  'csv_parser_create_latin1_rows_with_quoted_spans',
  'csv_batch_quoted_rows_ptr',
  'csv_parser_create_latin1_rows_with_fixed_columns',
] as const;

describe('native library contract', () => {
  test.each(requiredSymbols)('rejects imports when %s is unavailable', async (symbol) => {
    // Isolate the FFI mock so other tests keep using the real native library.
    const script = `
      import { mock } from 'bun:test';
      import * as ffi from 'bun:ffi';
      const original = { ...ffi };
      mock.module('bun:ffi', () => ({
        ...original,
        dlopen(path, symbols) {
          if (Object.hasOwn(symbols, ${JSON.stringify(symbol)})) {
            throw new Error(${JSON.stringify(`Missing native symbol: ${symbol}`)});
          }
          return original.dlopen(path, symbols);
        },
      }));
      await import(${JSON.stringify(new URL('../src/native.ts', import.meta.url).href)});
    `;
    const child = Bun.spawn([process.execPath, '--eval', script], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr,] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).not.toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toContain(`Missing native symbol: ${symbol}`);
  });
});
