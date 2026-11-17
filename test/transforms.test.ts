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
    csv.column(0).trim().unaccent().upper().replace(/(\S)\s+/, '$1-'),
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

test.each(['utf8', 'latin1'] as const)('complete quoted records and split records emit the same transformed bytes (%s)', (encoding) => {
  const clean = csv.transform().trim().upper().unaccent();
  const options = {
    encoding,
    delimiter: ';' as const,
    fixedColumns: 4,
    transform: [clean.on(0, 2), csv.column(1).upper().trim().lower()],
    equalsFilter: { column: 2, value: ' ok ' },
  };
  const input = Buffer.from(
    '" abc ";"\tXyZ\v";" ok ";"KEEP"\n'
      + '"\u0000x\u001c";"\f\r";" ok ";""\n'
      + '"\u0085Éß\u00a0";"ÉTÉ";" ok ";"café"\n'
      + '"skip";"ignored";"OK";"row"\n'
      + '" a""b ";" Ab\nCd ";" ok ";"tail"\r\n'
      + 'unquoted; Last ; ok ;end',
    encoding,
  );
  const expected = [
    ['ABC', 'xyz', 'OK', 'KEEP'],
    ['\u0000X\u001c', '', 'OK', ''],
    ['ESS', 'été', 'OK', 'café'],
    ['A"B', 'ab\ncd', 'OK', 'tail'],
    ['UNQUOTED', 'last', 'OK', 'end'],
  ];
  using parser = new NativeCsvParser(options);
  using batch = parser.writeBatch(input, true);
  expect(batch.rows()).toEqual(expected);
  for (const [i, row,] of expected.entries()) {
    for (const [column, field,] of row.entries()) {
      expect(batch.fieldBuffer(i, column)).toEqual(Buffer.from(field));
    }
  }
  parser.reset();
  const split = [];
  for (let start = 0; start < input.length; start += 3) {
    split.push(...parser.write(input.subarray(start, start + 3)));
  }
  expect([...split, ...parser.end()]).toEqual(expected);
  parser.reset();
  expect(() => parser.write(Buffer.from('"bad";"width";"rejected"\n'), true)).toThrow('column count');
});

test('ordered mappings interrupt ASCII case folding, including on empty fields', async () => {
  const chain = csv.column(0).upper().map({ 'ABC': ' São ', '': ' Ç ' }).trim().lower().unaccent();
  const rows = await csv.parse(Buffer.from('"abc";"keep"\n"";"keep"\n'), { delimiter: ';', transform: [chain] });
  expect(rows).toEqual([['sao', 'keep'], ['c', 'keep']]);
});

test.each(['utf8', 'latin1'] as const)('materialized cleanup rows mix quoted spans and UTF-8 fallback (%s)', async (encoding) => {
  const path = join(directory, `cleanup-spans-${encoding}.csv`);
  const clean = csv.transform().upper().trim().unaccent().lower().upper();
  const transform = [clean.on(0, 1, 2)];
  const text = '"abc";"xYz";""\n'
    + '" \t\n\v\f\rabc \t\n\v\f\r";"\t\r";"kept"\n'
    + '"\u001cabc\u001c";"\u0000";"tail"\n'
    + '"\u0085Éß\u00a0";"ÉTÉ";"µcafé"\n'
    + '" a""b ";" Ab\nCd ";"tail"\r\n'
    + 'unquoted; Last ;end\n'
    + '"ascii";"after-fallback";"row"\n'
    + '"final";"mixed";"case"';
  const input = Buffer.from(text, encoding);
  await Bun.write(path, input);
  const expected = [
    ['ABC', 'XYZ', ''],
    ['ABC', '', 'KEPT'],
    ['\u001cABC\u001c', '\u0000', 'TAIL'],
    ['ESS', 'ETE', 'ΜCAFE'],
    ['A"B', 'AB\nCD', 'TAIL'],
    ['UNQUOTED', 'LAST', 'END'],
    ['ASCII', 'AFTER-FALLBACK', 'ROW'],
    ['FINAL', 'MIXED', 'CASE'],
  ];
  const options = { encoding, delimiter: ';' as const, fixedColumns: 3, transform };
  expect(await csv.parse(input, options)).toEqual(expected);
  for (const chunkSize of [1, 67, 4096]) {
    const rows = [];
    for await (const batch of csv.rows(path, { ...options, chunkSize, reuseArrays: true })) {
      rows.push(...batch.map((row) => [...row]));
    }
    expect(rows).toEqual(expected);
  }
  const selected = [];
  for await (const batch of csv.rows(path, { ...options, skipRows: 1, limit: 3 })) {
    selected.push(...batch);
  }
  expect(selected).toEqual(expected.slice(1, 4));
  const packed = [];
  for await (using batch of csv.batches(path, options)) {
    const rows = expected.slice(packed.length, packed.length + batch.rowCount);
    expect(batch.data()).toEqual(Buffer.from(rows.flat().join('')));
    packed.push(...batch.rows());
  }
  expect(packed).toEqual(expected);
});

test('materialized quoted cleanup handles alphabetic delimiters and nonuniform chains', async () => {
  const path = join(directory, 'cleanup-spans-delimiter.csv');
  const input = Buffer.from('"bc"a"De"a"fg"\n"hi"a"jk"a"lm"\n');
  await Bun.write(path, input);
  const clean = csv.transform().trim().upper().unaccent();
  const uniform = { delimiter: 'a' as const, transform: [clean.on(0, 1, 2)] };
  const rows = [];
  for await (const batch of csv.rows(path, uniform)) {
    rows.push(...batch);
  }
  expect(rows).toEqual([['BC', 'DE', 'FG'], ['HI', 'JK', 'LM']]);
  for (const chain of [csv.transform().lower(), csv.transform().unaccent()]) {
    const options = { delimiter: 'a' as const, transform: [chain.on(0, 1, 2)] };
    const result = [];
    for await (const batch of csv.rows(path, options)) {
      result.push(...batch);
    }
    expect(result).toEqual(await csv.parse(input, options));
  }
  const nonuniform = { delimiter: 'a' as const, transform: [clean.on(0), csv.column(1).lower(), csv.column(2).map({ fg: '🙂' })] };
  const fallback = [];
  for await (const batch of csv.rows(path, nonuniform)) {
    fallback.push(...batch);
  }
  expect(fallback).toEqual(await csv.parse(input, nonuniform));
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
    transform: [csv.column(0).unaccent().lower(), csv.column(1).replace('1', 'one')],
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
  const prefix = column.replace('aa', 'a');
  const source = Buffer.from('aaa\nÉ\ne\u0301');
  expect(await csv.parse(source, { transform: [prefix.map(new Map([['É', 'hit'], ['e\u0301', 'separate']]))] }))
    .toEqual([['aa'], ['hit'], ['separate']]);
  expect(await csv.parse(Buffer.from('aaa'), { transform: [prefix.replace('a', '')] })).toEqual([['']]);
  expect(() => column.replace('', 'x')).toThrow('empty');
  expect(() => csv.rows('unused', { transform: [prefix, column.upper()] })).toThrow('repeated');
  // @ts-expect-error Filters are not transforms.
  expect(() => csv.rows('unused', { transform: [column.equals('x')] })).toThrow('chain');
});

test('replace treats string operands literally and expands JavaScript captures for regex searches', async () => {
  const pattern = /(\u00E9)\/(\d+)/giu;
  pattern.lastIndex = 10;
  const reorder = csv.transform().replace(pattern, '$2-$1').on(1, 2);
  const input = Buffer.from('a.*b.*c,é/12 É/34,no match\nx,É/0,é/9');
  const options = {
    strict: true as const,
    columns: [2, 0, 1] as const,
    transform: [csv.column(0).replace('.*', '\\1$&$$$1$<x>'), reorder],
  };
  expect(await csv.parse(input, options)).toEqual([
    ['no match', 'a\\1$&$$$1$<x>b\\1$&$$$1$<x>c', '12-é 34-É'],
    ['9-é', 'x', '0-É'],
  ]);
  expect(pattern.lastIndex).toBe(10);
});

test('regex capture templates agree with JavaScript for each match', () => {
  const cases = [
    [/(a)(b)?/g, 'ab a', '$&|$2|$1|$0|$01|$02|$00|$10|$20|$30|$99|$$|$$$1|\\1\\'],
    [/(a)/g, 'a a', '$<missing> $<$1> $< $$ $'],
    [/(?<letter>a)(?<digit>\d)?/g, 'a1 a', '$<digit>:$<letter>:$<missing>:$<>:$<unterminated-$1'],
    [/(?<part>a)|(?<part>b)/g, 'ba', '$<part>/$1/$2'],
    [new RegExp(`${'(a)'.repeat(99)}(?<last>z)`, 'g'), `${'a'.repeat(99)}z`, '$99/$100/$10/$09/$<last>'],
    [/(🙂)/gu, 'a🙂🙂', '\0$$$1$&'],
    [/x/g, 'xxx', ''],
  ] as const;
  for (const [pattern, field, template,] of cases) {
    const expected = field.replace(pattern, template);
    using parser = new NativeCsvParser({ transform: [csv.transform().replace(pattern, template).on(0, 1)] });
    const input = Buffer.from(`${field},${field}`);
    expect(parser.write(input, true)).toEqual([[expected, expected]]);
    parser.reset();
    expect(parser.write(input, true)).toEqual([[expected, expected]]);
  }
});

test('zero-width replacement visits Unicode boundaries and present empty fields', async () => {
  const transform = [csv.transform().replace(/(?:)/, '-').on(0, 1)];
  expect(await csv.parse(Buffer.from('🙂,\né'), { columns: [0, 1], transform })).toEqual([
    ['-🙂-', '-'],
    ['-é-', ''],
  ]);
  expect(await csv.parse(Buffer.from('aaé'), { transform: [csv.column(0).replace(/(a*)/, '[$1]')] })).toEqual([['[aa]é[]']]);
});

test('replace rejects unsupported flags and RE2 patterns before reading rows', () => {
  const column = csv.column(0);
  expect(() => column.replace(/x/y, '')).toThrow('unsupported regular expression flags');
  expect(() => column.replace(new RegExp('a'.repeat(4097)), '')).toThrow('4096');
  for (const pattern of [/x(?=y)/, /(x)\1/]) {
    expect(() => new NativeCsvParser({ transform: [column.replace(pattern, 'z')] })).toThrow(SyntaxError);
  }
});

test('date formats all supported layouts and validates Gregorian dates', async () => {
  const cases = [
    ['20000229', '2000-02-29', '29-02-2000'],
    ['2024-02-29', '2024-02-29', '29-02-2024'],
    ['31-12-9999', '9999-12-31', '31-12-9999'],
    ['01-02-0001', '0001-02-01', '01-02-0001'],
    ['20260430', '2026-04-30', '30-04-2026'],
    ['20261117', '2026-11-17', '17-11-2026'],
    ['29/02/2024', '2024-02-29', '29-02-2024'],
    ['01/02/0001', '0001-02-01', '01-02-0001'],
  ] as const;
  const invalid = [
    '',
    '0',
    '00000000',
    '0000-01-01',
    '19000229',
    '2026-02-29',
    '31-04-2026',
    '20260001',
    '20261301',
    '2026-01-00',
    '32-01-2026',
    '2026111',
    '202611170',
    ' 20261117 ',
    '2026/11/17',
    '31/04/2026',
    '29/02/1900',
    '17/11-2026',
    '17-11/2026',
    '17-1-2026',
    '202A-11-17',
    '2026-1x-17',
    '2026-11-1x',
    '２０２６１１１７',
  ];
  const values = [...cases.map(([input,]) => input), ...invalid];
  const input = Buffer.from(values.map((value) => `${value},${value},${value}`).join('\n'));
  expect(
    await csv.parse(input, {
      transform: [
        csv.column(0).date('YYYY-MM-DD'),
        csv.column(1).date('DD-MM-YYYY', 'inválida'),
        csv.column(2).date('DD/MM/YYYY'),
      ],
    }),
  ).toEqual([
    ...cases.map(([, iso, local,]) => [iso, local, local.replaceAll('-', '/')]),
    ...invalid.map(() => ['', 'inválida', '']),
  ]);
});

test('date chains work in streamed rows, batch bytes and the strict parser', async () => {
  const input = Buffer.from(' 20261117 ;bad\n29/02/2024;\n2026-04-01');
  const path = join(directory, 'dates.csv');
  await Bun.write(path, input);
  const transform = [csv.transform().trim().date('DD/MM/YYYY', 'indéfini').upper().on(0, 1)];
  const options = { delimiter: ';' as const, columns: [1, 0] as const, transform };
  const expected: [string, string][] = [['INDÉFINI', '17/11/2026'], ['INDÉFINI', '29/02/2024'], ['', '01/04/2026']];
  const streamed = [];
  for await (const rows of csv.rows(path, { ...options, chunkSize: 2 })) {
    streamed.push(...rows);
  }
  expect(streamed).toEqual(expected);
  const fromBytes = [];
  for await (using batch of csv.batches(path, { ...options, chunkSize: 2 })) {
    for (let i = 0; i < batch.rowCount; ++i) {
      fromBytes.push([0, 1].map((column) => batch.fieldBuffer(i, column)?.toString('utf8')));
    }
  }
  expect(fromBytes).toEqual(expected);
  using parser = new NativeCsvParser({ strict: true, delimiter: ';', transform });
  expect(parser.write(Buffer.from(' bad ;2024-02-29'), true)).toEqual([['INDÉFINI', '29/02/2024']]);
});

test('date validates the output format and fallback at chain construction', () => {
  // @ts-expect-error Compact dates are an input-only format.
  expect(() => csv.transform().date('YYYYMMDD')).toThrow('YYYY-MM-DD, DD-MM-YYYY or DD/MM/YYYY');
  expect(() => csv.transform().date('DD-MM-YYYY', '\ud800')).toThrow('well-formed');
  // @ts-expect-error A date fallback must be a string.
  expect(() => csv.column(0).date('YYYY-MM-DD', null)).toThrow('well-formed');
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
