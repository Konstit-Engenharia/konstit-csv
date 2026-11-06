import {
  bench,
  summary,
} from 'mitata';
import { NativeCsvParser } from '../src/index.ts';

// Control sparse, dense and reordered projections while optimizing Latin-1 batches.
// Inputs are generated before timing; each pair has exactly one accepted row.
const target = 1024 * 1024;
const selections = [
  ['sparse', [0, 4, 19]],
  ['dense', Array.from({ length: 20 }, (_, index) => index)],
  ['reordered', [19, 4, 0]],
] as const;
summary(() => {
  for (const shape of ['short', 'long', 'quoted'] as const) {
    for (const encoding of ['utf8', 'latin1'] as const) {
      const payload = shape === 'long' ? 'abcdefghij'.repeat(50) : shape === 'quoted' ? 'João; "olá"\ncontinua' : 'Ana';
      const lines = ['SP', 'RJ'].map((state) => {
        const fields = ['1', payload, ...Array.from({ length: 17 }, () => 'ação'), state];
        return `${fields.map((field) => /[;"\r\n]/u.test(field) ? `"${field.replaceAll('"', '""')}"` : field).join(';')}\r\n`;
      }).join('');
      const pair = Buffer.from(lines, encoding);
      const expected = Math.ceil(target / pair.length);
      const input = Buffer.alloc(pair.length * expected);
      input.fill(pair);
      for (const [selection, selectedColumns,] of selections) {
        const label = `${shape}/${encoding}/${selection}`;
        console.log(JSON.stringify({ fixture: label, bytes: input.length, rows: expected }));
        const options = { selectedColumns, equalsFilter: { column: 19, value: 'SP' } };
        bench(label, () => {
          using parser = new NativeCsvParser({ delimiter: ';', encoding });
          let count = 0;
          for (let offset = 0; offset < input.length; offset += 65536) {
            using batch = parser.writeProjectedBatch(input.subarray(offset, offset + 65536), options);
            count += batch.rowCount;
          }
          using end = parser.endProjectedBatch(options);
          count += end.rowCount;
          if (count !== expected) {
            throw new Error(`bad projected row count ${count} != ${expected}`);
          }
        });
      }
    }
  }
});
