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
    csv.column(0).trim().unaccent().upper().replaceAll(' ', '-'),
    csv.column(1).trim().lower(),
    csv.column(2).map(entries),
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
  const stripped = csv.column(0).unaccent();
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
    transform: [csv.column(0).unaccent().lower(), csv.column(1).replaceAll('1', 'one')],
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
  expect(await csv.parse(source, { transform: [prefix.map(new Map([['É', 'hit'], ['e\u0301', 'separate']]))] }))
    .toEqual([['aa'], ['hit'], ['separate']]);
  expect(await csv.parse(Buffer.from('aaa'), { transform: [prefix.replaceAll('a', '')] })).toEqual([['']]);
  expect(() => column.replaceAll('', 'x')).toThrow('empty');
  expect(() => csv.rows('unused', { transform: [prefix, column.upper()] })).toThrow('repeated');
  // @ts-expect-error Filters are not transforms.
  expect(() => csv.rows('unused', { transform: [column.equals('x')] })).toThrow('chain');
});

test('map uses the default only for present fields missing from the map', async () => {
  const values = new Map([['A', ''], ['', 'blank']]);
  const mapped = csv.transform().map(values, 'indéfini').upper();
  const rows = await csv.parse(Buffer.from('A,,?\n?,A'), {
    columns: [0, 1, 2] as const,
    transform: [mapped.on(0, 1, 2)],
  });
  expect(rows).toEqual([['', 'BLANK', 'INDÉFINI'], ['INDÉFINI', '', '']]);

  using parser = new NativeCsvParser({
    strict: true,
    transform: [csv.column(0).map(values, ''), csv.column(1).map(values, undefined)],
  });
  expect(parser.write(Buffer.from('?,?'), true)).toEqual([['', '?']]);
  expect(() => csv.transform().map(values, '\ud800')).toThrow('well-formed');
});

test('map snapshots own enumerable entries from plain objects', async () => {
  const states = { SP: 'São Paulo', ['__proto__']: 'literal key', get: 'read', entries: '' };
  Object.defineProperty(states, 'hidden', { value: 'hidden entry' });
  const chain = csv.transform().map(states, 'Unknown');
  states.SP = 'changed';
  const input = Buffer.from('SP,__proto__,get,entries,constructor,hidden');
  expect(await csv.parse(input, { transform: [chain.on(0, 1, 2, 3, 4, 5)] }))
    .toEqual([['São Paulo', 'literal key', 'read', '', 'Unknown', 'Unknown']]);

  const codes: Record<string, string> = Object.create(null);
  codes['toString'] = 'explicit key';
  expect(await csv.parse(Buffer.from('toString\nmissing'), { transform: [csv.column(0).map(codes)] }))
    .toEqual([['explicit key'], ['missing']]);
});

test('map validates plain object entries at chain construction', () => {
  expect(() => csv.transform().map({ ['\ud800']: 'bad key' })).toThrow('well-formed');
  // @ts-expect-error Mapping values must be strings.
  expect(() => csv.transform().map({ SP: 1 })).toThrow('well-formed');
  // @ts-expect-error Arrays are not mapping objects.
  expect(() => csv.transform().map(['SP'])).toThrow('map or plain object');
});

test('reusable chains bind to multiple physical columns and can be extended or rebound independently', async () => {
  const entries = new Map([['SAO', 'São Paulo']]);
  const clean = csv.transform().trim().unaccent().upper();
  const city = clean.map(entries);
  entries.clear();
  const both = city.on(0, 2);
  const source = Buffer.from(' São , Bia , sao \nrecife,Ana,Recife');
  expect(
    await csv.parse(source, {
      where: csv.column(0).equals(' São '),
      columns: [2, 1, 0] as const,
      transform: [both, clean.on(1)],
    }),
  ).toEqual([['São Paulo', 'BIA', 'São Paulo']]);
  using parser = new NativeCsvParser({ transform: [both.on(1).lower()] });
  expect(parser.write(Buffer.from(' São , sao , são '), true)).toEqual([[' São ', 'são paulo', ' são ']]);
  expect(await csv.parse(source, { strict: true, columns: [2, 1], transform: [both] }))
    .toEqual([['São Paulo', ' Bia '], ['RECIFE', 'Ana']]);
  expect(await csv.parse(Buffer.from(' São ,são'), { transform: [csv.column(0).upper().on(1)] }))
    .toEqual([[' São ', 'SÃO']]);
});

test('bindings require valid, distinct columns, including across chains', () => {
  const clean = csv.transform().trim();
  // @ts-expect-error Bind a reusable chain before passing it to a reader.
  expect(() => csv.rows('unused', { transform: [clean] })).toThrow('chain.on(column)');
  // @ts-expect-error At least one physical column is required.
  expect(() => clean.on()).toThrow('at least one');
  expect(() => clean.on(2025)).toThrow('out of range');
  expect(() => clean.on(0, 0)).toThrow('repeated: 0');
  expect(() => new NativeCsvParser({ transform: [clean.on(2, 3), csv.column(3).upper()] })).toThrow('repeated: 3');
});
