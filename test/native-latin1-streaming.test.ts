import {
  expect,
  test,
} from 'bun:test';
import { NativeCsvParser } from '../src/index.ts';

// Exercise every two-chunk split, including escaped quotes, CRLF, non-ASCII and EOF.
for (const encoding of ['utf8', 'latin1'] as const) {
  for (const fixed of [false, true]) {
    for (const strict of [false, true]) {
      test(`quoted batch fields survive every split: ${encoding} fixed=${fixed} strict=${strict}`, () => {
        const text = '"1";"João ""olá""\r\nx";SP\r\n2;;RJ\r\n3;ação;MG';
        const input = Buffer.from(text, encoding);
        const expected = [['1', 'João "olá"\r\nx', 'SP'], ['2', '', 'RJ'], ['3', 'ação', 'MG']];
        for (let split = 0; split <= input.length; split++) {
          using parser = new NativeCsvParser({ delimiter: ';', encoding, strict, fixedColumns: fixed ? 3 : undefined });
          const rows: string[][] = [];
          {
            using batch = parser.writeBatch(input.subarray(0, split));
            rows.push(...batch.rows());
          }
          {
            using batch = parser.writeBatch(input.subarray(split));
            rows.push(...batch.rows());
          }
          {
            using batch = parser.endBatch();
            rows.push(...batch.rows());
          }
          expect(rows).toEqual(expected);
        }
      });
    }
  }
}
