import {
  bench,
  summary,
} from 'mitata';
import { NativeCsvParser } from '../src/index.ts';

// Compare the same cases on the unchanged revision and the short-field variant.
// Mixed rows approximate the measured empty/one-byte/two-byte field distribution;
// long-only rows detect the cost of extra branches when none of them succeeds.
// Parsing and fixture construction stay outside the timed materialization loop.
for (const rowCount of [1, 1_024, 16_384]) {
  summary(() => {
    for (const shortFields of [true, false]) {
      const rows: string[][] = [];
      let expectedCharacters = 0;
      for (let rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
        const row = Array.from({ length: 30 }, (_, column) => {
          if (shortFields && column < 9) {
            return '';
          }
          if (shortFields && column === 9) {
            return String(rowIndex % 10);
          }
          if (shortFields && column < 15) {
            return column === 14 ? 'é' : String((rowIndex + column) % 100).padStart(2, '0');
          }
          return column % 2 === 0 ? `field-${rowIndex}-${column}` : 'ação multibyte';
        });
        rows.push(row);
        for (const field of row) {
          expectedCharacters += field.length;
        }
      }
      const input = Buffer.from(`${rows.map((row) => row.join(';')).join('\n')}\n`);
      const name = `${shortFields ? 'mixed short' : 'long-only'} fields, ${rowCount} rows`;
      bench(name, function*() {
        using parser = new NativeCsvParser({ delimiter: ';' });
        using batch = parser.writeBatch(input, true);
        const target: string[][] = [];
        yield () => {
          const materialized = batch.rowsInto(target);
          let characters = 0;
          let fields = 0;
          for (const row of materialized) {
            fields += row.length;
            for (const field of row) {
              characters += field.length;
            }
          }
          if (materialized.length !== rowCount || fields !== rowCount * 30 || characters !== expectedCharacters) {
            throw new Error(`incorrect materialized output: ${name}`);
          }
        };
      });
    }
  });
}
