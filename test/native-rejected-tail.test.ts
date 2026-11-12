import {
  expect,
  test,
} from 'bun:test';
import { NativeCsvParser } from '../src/index.ts';
import type { CsvNativeFilterProgramEntry } from '../src/normalize.ts';

test('rejected row tails preserve tolerant quotes, CRLF, and chunk boundaries', () => {
  const text = [
    'drop,"embedded\r\nline","escaped ""quote""",tail\r\n',
    'keep,João,first\r\n',
    `"drop",${'x'.repeat(63)},"${'y'.repeat(65)}\nline",tail\r`,
    'keep,Bia,second\n',
    'drop,unquoted"quote,"closed"suffix,tail\n',
    'keep,Ana,third\r\n',
  ].join('');
  const filters = [{ column: 0, value: 'keep' }] as const;
  const projections = [undefined, [0, 2, 5], [2, 0, 5]] as const;

  for (const ending of ['keep,Érico,last', 'drop,"unterminated\nquoted tail', 'drop,']) {
    const expected = [['keep', 'João', 'first'], ['keep', 'Bia', 'second'], ['keep', 'Ana', 'third']];
    if (ending.startsWith('keep')) {
      expected.push(['keep', 'Érico', 'last']);
    }
    for (const encoding of ['utf8', 'iso88591'] as const) {
      const input = Buffer.from(text + ending, encoding === 'utf8' ? 'utf8' : 'latin1');
      for (const chunkSize of [1, 2, 3, 15, 16, 17, 31, 32, 33, 64, input.length]) {
        using counter = new NativeCsvParser({ encoding });
        let count = 0;
        for (let offset = 0; offset < input.length; offset += chunkSize) {
          count += counter.writeCountWhereAll(input.subarray(offset, offset + chunkSize), filters);
        }
        count += counter.endCountWhereAll(filters);
        expect(count).toBe(expected.length);

        for (const columns of projections) {
          using parser = new NativeCsvParser({ encoding });
          const rows: string[][] = [];
          const options = columns === undefined ? { filters } : { filters, columns };
          for (let offset = 0; offset < input.length; offset += chunkSize) {
            using batch = parser.writeProjectedBatch(input.subarray(offset, offset + chunkSize), options);
            rows.push(...batch.rows());
          }
          using finalBatch = parser.endProjectedBatch(options);
          rows.push(...finalBatch.rows());
          expect(rows).toEqual(
            columns === undefined ? expected : expected.map((row) => columns.map((column) => row[column] ?? '')),
          );
        }
      }
    }
  }
});

test('only definitive Boolean rejection skips a row tail', () => {
  const input = Buffer.from('drop,"embedded\nline",ok\r\nkeep,plain,no\ndrop,plain,no\ndrop\nkeep,plain,ok');
  const cases = [
    {
      program: [{ column: 0, value: 'keep' }, { column: 2, value: 'ok' }, { operator: 'any', operandCount: 2 }],
      expected: [['drop', 'embedded\nline', 'ok'], ['keep', 'plain', 'no'], ['keep', 'plain', 'ok']],
    },
    {
      program: [
        { column: 0, value: 'drop' },
        { operator: 'not', operandCount: 1 },
        { column: 2, value: 'ok' },
        { operator: 'all', operandCount: 2 },
      ],
      expected: [['keep', 'plain', 'ok']],
    },
  ] satisfies readonly { program: readonly CsvNativeFilterProgramEntry[]; expected: string[][]; }[];
  for (const { program, expected } of cases) {
    for (let split = 0; split <= input.length; ++split) {
      using parser = new NativeCsvParser();
      using counter = new NativeCsvParser();
      const rows: string[][] = [];
      let count = 0;
      for (const chunk of [input.subarray(0, split), input.subarray(split)]) {
        using batch = parser.writeProjectedBatchWhere(chunk, undefined, program);
        rows.push(...batch.rows());
        count += counter.writeCountWhere(chunk, program);
      }
      using finalBatch = parser.endProjectedBatchWhere(undefined, program);
      rows.push(...finalBatch.rows());
      count += counter.endCountWhere(program);
      expect(rows).toEqual(expected);
      expect(count).toBe(expected.length);
    }
  }
});

test('strict parsing continues to reject invalid quote syntax', () => {
  for (const suffix of ['unquoted"quote', '"closed"suffix', '"unterminated\nfield']) {
    using parser = new NativeCsvParser({ strict: true });
    expect(() => parser.writeBatch(Buffer.from(`drop,${suffix}`), true)).toThrow('strict CSV quote syntax error');
  }
});
