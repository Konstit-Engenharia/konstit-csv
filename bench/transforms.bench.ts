import {
  bench,
  summary,
} from 'mitata';
import { csv } from '../src/index.ts';

// Compare complete parse, filter, projection and cleanup. The plain parser measures
// the cost floor for emitting the same rows without cleaning their fields.
const cases = [
  ['ASCII', 'utf8', '  Sao Joao  '],
  ['multilingual', 'utf8', '\u00a0Αθήνα Straße São João ❤️\u202f'],
  ['Latin-1', 'latin1', '\u00a0São João Straße\u00a0'],
] as const;
const transform = [csv.column(1).trim().unaccent().upper()];
const diacritic = /\p{Diacritic}/u;
const whitespace = /^\p{White_Space}+|\p{White_Space}+$/gu;

function cleanup(value: string): string {
  return value.replace(whitespace, '').normalize('NFD')
    .replace(/\p{M}/gu, (c) => diacritic.test(c) ? '' : c).normalize('NFC').toUpperCase();
}

for (const [label, encoding, name,] of cases) {
  const input = Buffer.from(Array.from({ length: 4096 }, (_, i) => `${i % 4},${name},${i}\n`).join(''), encoding);
  const options = { columns: [1] as const, encoding, where: csv.column(0).equals('0') };
  const transformed = { ...options, transform };
  const expected = cleanup(name);
  summary(() => {
    for (const mode of ['plain', 'native', 'JS'] as const) {
      bench(`${label} / ${mode}`, async () => {
        const rows = await csv.parse(input, mode === 'native' ? transformed : options);
        let total = 0;
        for (const [value,] of rows) {
          total += (mode === 'JS' ? cleanup(value) : value).length;
        }
        if (rows.length !== 1024 || total !== 1024 * (mode === 'plain' ? name : expected).length) {
          throw new Error('unexpected transform benchmark output');
        }
        return total;
      });
    }
  });
}
