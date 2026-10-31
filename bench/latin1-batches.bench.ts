import {
  bench,
  summary,
} from 'mitata';
import {
  NativeCsvParser,
  parseCsvBuffer,
} from '../src/index.ts';

// Compare arena-copy candidates on identical in-memory inputs. Setup and I/O are excluded.
// Batch cases consume row counts; materialize cases include Bun string/array creation.
const target = 4 * 1024 * 1024;
const fixtures = [
  ['short', '1;Ana;SP\r\n'],
  ['long', `1;${'abcdefghij'.repeat(50)};SP\r\n`],
  ['quoted', '"1";"João; ação ""especial""\ncontinua";"SP"\r\n'],
] as const;
summary(() => {
  for (const [name, row,] of fixtures) {
    for (const encoding of ['utf8', 'latin1'] as const) {
      const encoded = Buffer.from(row, encoding);
      const rows = Math.ceil(target / encoded.length);
      const input = Buffer.alloc(encoded.length * rows);
      input.fill(encoded);
      for (const fixed of [false, true]) {
        for (const chunkSize of [65536, 1048576]) {
          const label = `${name}/${encoding}/${fixed ? 'fixed' : 'batch'}/${chunkSize}`;
          console.log(JSON.stringify({ fixture: label, bytes: input.length, rows }));
          bench(label, () => {
            using parser = new NativeCsvParser({ delimiter: ';', encoding, fixedColumns: fixed ? 3 : undefined });
            let count = 0;
            for (let offset = 0; offset < input.length; offset += chunkSize) {
              using batch = parser.writeBatch(input.subarray(offset, offset + chunkSize));
              count += batch.rowCount;
            }
            using end = parser.endBatch();
            count += end.rowCount;
            if (count !== rows) {
              throw new Error(`row count ${count} != ${rows}`);
            }
          });
        }
      }
      bench(`${name}/${encoding}/materialize`, () => {
        const result = parseCsvBuffer(input, { delimiter: ';', encoding });
        if (result.length !== rows) {
          throw new Error('bad materialized count');
        }
      });
    }
  }
});
