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

// Measure the cost of calendar validation and formatting over the same projected rows.
const dates = ['20000229', '30-04-2026', '00000000', '2026-04-31', '2026-12-01', '17/11/2026'];
const formatted = ['2000-02-29', '2026-04-30', '', '', '2026-12-01', '2026-11-17'];
const dateInput = Buffer.from(Array.from({ length: 4096 }, (_, i) => `${i},${dates[i % dates.length]}\n`).join(''));
const projection = { columns: [1] as const };
const dateOptions = { ...projection, transform: [csv.column(1).date('YYYY-MM-DD')] };
summary(() => {
  for (const [label, options, expected,] of [['plain', projection, dates], ['native', dateOptions, formatted]] as const) {
    bench(`dates / ${label}`, async () => {
      const rows = await csv.parse(dateInput, options);
      if (rows.length !== 4096 || !rows.every(([value,], i) => value === expected[i % expected.length])) {
        throw new Error('unexpected date benchmark output');
      }
      return rows.length;
    });
  }
});

// Compare the same global edit with literal search and RE2. Small inputs include
// a larger share of parser setup; larger inputs reuse the regex over more fields.
for (const size of [16, 4096]) {
  const input = Buffer.from('id,BR/São/Paulo\nid,Brasília\n'.repeat(size / 2));
  summary(() => {
    for (const [label, search,] of [['literal', '/'], ['RE2', /\//u]] as const) {
      const options = { ...projection, transform: [csv.column(1).replace(search, '-')] };
      bench(`replace / ${size} rows / ${label}`, async () => {
        const rows = await csv.parse(input, options);
        if (rows.length !== size || !rows.every(([value,], i) => value === (i % 2 === 0 ? 'BR-São-Paulo' : 'Brasília'))) {
          throw new Error('unexpected replacement benchmark output');
        }
        return rows.length;
      });
    }
  });
}
