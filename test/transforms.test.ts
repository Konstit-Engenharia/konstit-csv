import {
  afterAll,
  beforeAll,
  expect,
  test,
} from 'bun:test';
import {
  mkdtemp,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  csv,
  NativeCsvParser,
} from '../src/index.ts';

let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'csv-transform-'));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

test.each(['utf8', 'latin1'] as const)('post-filter chains agree across all readers (%s)', async (encoding) => {
  const input = Buffer.from('city;tag;code\r\n"\u00a0São João\u00a0"; Y ;\r\nStraße; Y \r\nignored;Y;bad\r\n', encoding);
  const path = join(directory, `${encoding}.csv`);
  await Bun.write(path, input);
  const entries = new Map([['', '❤️']]);
  const transform = [
    csv.column(0).trim().removeDiacritics().upper().replaceAll(' ', '-'),
    csv.column(1).trim().lower(),
    csv.column(2).lookup(entries),
  ];
  entries.clear();
  const options = { columns: [2, 0, 1] as const, encoding, skipRows: 1, transform, delimiter: ';' as const };
  const rowsOptions = { ...options, where: csv.column(1).equals(' Y ') };
  const expected: [string, string, string][] = [['❤️', 'SAO-JOAO', 'y'], ['', 'STRASSE', 'y']];
  const parsed = csv.parse(input, rowsOptions);
  const streamed = csv.rows(path, { ...rowsOptions, chunkSize: 1 });
  const batches = csv.batches(path, { ...rowsOptions, chunkSize: 1 });
  using parser = new NativeCsvParser({ ...options, equalsFilter: { column: 1, value: ' Y ' } });
  transform.length = 0;
  expect(await parsed).toEqual(expected);
  const rows = [];
  for await (const batch of streamed) {
    rows.push(...batch);
  }
  expect(rows).toEqual(expected);
  const bytes = [];
  for await (using batch of batches) {
    for (let i = 0; i < batch.rowCount; ++i) {
      bytes.push([0, 1, 2].map((col) => new TextDecoder().decode(batch.fieldBytes(i, col) ?? undefined)));
    }
  }
  expect(bytes).toEqual(expected);
  const manual = [];
  for (let i = 0; i < input.length; ++i) {
    manual.push(...parser.write(input.subarray(i, i + 1)));
  }
  manual.push(...parser.end());
  expect(manual).toEqual(expected);
  parser.reset();
  expect(parser.writeCount(input, true)).toBe(2);
  parser.reset();
  expect(parser.write(input, true)).toEqual(expected);
});

test('Unicode transformations distinguish diacritics, other marks and standalone symbols', async () => {
  const cases = [
    ['São João', 'Sao Joao'],
    ['Sa\u0303o Joa\u0303o', 'Sao Joao'],
    ['Αθήνα', 'Αθηνα'],
    ['❤️ 1️⃣ Łø ^', '❤️ 1️⃣ Łø ^'],
    ['か\u3099', 'か'],
    ['한글', '한글'],
    [`a${'\u0301'.repeat(70)}`, 'a'],
    ['a\u034f\u0301', 'a\u034f'],
    ['a\u05a2\u0301', 'a\u05a2'], // U+05A2 lacks the Diacritic property in Unicode 15.1.
  ] as const;
  const stripped = csv.column(0).removeDiacritics();
  expect(await csv.parse(Buffer.from(cases.map(([s,]) => s).join('\n')), { transform: [stripped] }))
    .toEqual(cases.map(([, s,]) => [s]));
  const lower = csv.column(0).trim().lower();
  expect(await csv.parse(Buffer.from('\u202fΟΣ\u0085'), { transform: [lower] })).toEqual([['ος']]);
  const path = join(directory, 'split-marks.csv');
  await Bun.write(path, ' "unused"\n"e\u0301""á\nß"');
  const streamed = [];
  for await (const batch of csv.rows(path, { encoding: 'utf8', chunkSize: 1, skipRows: 1, transform: [stripped.upper()] })) {
    streamed.push(...batch);
  }
  expect(streamed).toEqual([['E"A\nSS']]);
});

test('strict validation reads the original header before projection and transformation', async () => {
  const input = Buffer.from('cité,val\nA,12\nB,23');
  const options = {
    strict: true as const,
    expectedHeaders: ['cité', 'val'],
    columns: [0] as const,
    limit: 2,
    transform: [csv.column(0).removeDiacritics().lower(), csv.column(1).replaceAll('1', 'one')],
  };
  expect(await csv.parse(input, options)).toEqual([['cite'], ['a']]);
  expect(await csv.parse(input, { ...options, skipRows: 1 })).toEqual([['a'], ['b']]);
  expect(csv.parse(input, { ...options, expectedHeaders: ['cite', 'val'] })).rejects.toThrow();
});

test('counts and limits operate on original input and fixed widths apply to rejected rows', async () => {
  const t = csv.column(0).upper();
  const options = { fixedColumns: 2, transform: [t], where: csv.column(0).equals('a'), limit: 1 };
  expect(await csv.parse(Buffer.from('A,0\na,1\na,2'), options)).toEqual([['A', '1']]);
  expect(csv.parse(Buffer.from('rejected\na,1'), options)).rejects.toThrow('column count');
  expect(await csv.parse(Buffer.from('a,1'), { ...options, limit: 0 })).toEqual([]);
});

test('chains are reusable and validate their operands and targets', async () => {
  const column = csv.column(0);
  const prefix = column.replaceAll('aa', 'a');
  const source = Buffer.from('aaa\nÉ\ne\u0301');
  expect(await csv.parse(source, { transform: [prefix.lookup(new Map([['É', 'hit'], ['e\u0301', 'separate']]))] }))
    .toEqual([['aa'], ['hit'], ['separate']]);
  expect(await csv.parse(Buffer.from('aaa'), { transform: [prefix.replaceAll('a', '')] })).toEqual([['']]);
  expect(() => column.replaceAll('', 'x')).toThrow('empty');
  expect(() => csv.rows('unused', { transform: [prefix, column.upper()] })).toThrow('repeated');
  // @ts-expect-error Filters are not transforms.
  expect(() => csv.rows('unused', { transform: [column.equals('x')] })).toThrow('chain');
});
