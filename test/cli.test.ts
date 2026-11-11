import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import iconv from 'iconv-lite';
import {
  mkdtemp,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { csvFixturePath } from './fixtures.ts';
import { createZip } from './zip-fixture.ts';

const cliPath = join(import.meta.dir, '..', 'src', 'cli.ts');
let temporaryDirectory: string;

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'csv-cli-'));
  await Bun.write(
    join(temporaryDirectory, 'input.csv.gz'),
    Bun.gzipSync(Buffer.from('id;name\n1;Ada\n2;Bob\n')),
  );
  await Bun.write(
    join(temporaryDirectory, 'input.zip'),
    createZip([{ data: Buffer.from('id;name\n1;Ada\n2;Bob\n'), method: 8, name: 'nested/input.csv' }]),
  );
  await Bun.write(
    join(temporaryDirectory, 'high-ratio.zip'),
    createZip([{ data: Buffer.from('a;b\n'.repeat(4_096)), method: 8, name: 'input.csv' }]),
  );
  await Bun.write(join(temporaryDirectory, 'equals.csv'), 'id,value\n1,a=b\n2,other\n');
  await Bun.write(
    join(temporaryDirectory, 'windows-1252.csv'),
    Uint8Array.from(iconv.encode('id;name\n1;€\n2;“quoted”\n', 'windows-1252')),
  );
  await Bun.write(join(temporaryDirectory, 'empty.csv'), '');
  await Bun.write(
    join(temporaryDirectory, 'quoted.csv'),
    'id;text;note\n1;"a,b";"say ""hi"""\n2;"multi\nline";\n3;plain;done\n',
  );
  await Bun.write(
    join(temporaryDirectory, 'strict-prefix.csv'),
    'id,name\n1,A"da\n',
  );
  await Bun.write(
    join(temporaryDirectory, 'large.csv'),
    `id,value\n${Array.from({ length: 10_000 }, (_, index) => `${String(index)},value-${String(index)}\n`).join('')}`,
  );
});

afterAll(async () => {
  await rm(temporaryDirectory, { force: true, recursive: true });
});

describe('csv CLI', () => {
  test('counts every record in a CSV file', () => {
    const result = runCli('count', csvFixturePath('rfc4180/simple-lf.csv'));

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('2\n');
    expect(result.stderr.toString()).toBe('');
  });

  test('supports delimiter and chunk size options', () => {
    const result = runCli(
      'count',
      csvFixturePath('api/unquoted-people-sp-filter.csv'),
      '--delimiter',
      ';',
      '--chunk-size',
      '1',
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('4\n');
    expect(result.stderr.toString()).toBe('');
  });

  test('supports automatic delimiter detection', () => {
    const result = runCli('count', csvFixturePath('api/unquoted-people-sp-filter.csv'), '--delimiter', 'auto');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('4\n');
    expect(result.stderr.toString()).toBe('');
  });

  test('detects the encoding with a fixed delimiter and detects both for filtered counts', () => {
    const path = join(temporaryDirectory, 'windows-1252.csv');
    const lines = runCli('lines', path, '--encoding', 'auto', '--delimiter', ';', '--json');
    expect(lines.exitCode).toBe(0);
    expect(lines.stdout.toString()).toBe('["id","name"]\n["1","€"]\n["2","“quoted”"]\n');
    const count = runCli('count', path, '--where-eq', '1=€');
    expect(count.exitCode).toBe(0);
    expect(count.stdout.toString()).toBe('1\n');
    expect(runCli('lines', path, '--json').stdout.toString()).toBe(lines.stdout.toString());
  });

  test('probe reports the compressed size and the format of quoted UTF-16 records', async () => {
    const path = join(temporaryDirectory, 'compressed-without-extension');
    const compressed = Bun.gzipSync(Buffer.from('\ufeff"first\nfield"\t"say ""hi""\there"\t\r\n1\t2\t3\r\n', 'utf16le'));
    await Bun.write(path, compressed);
    const result = runCli('probe', path);
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe('');
    expect(result.stdout.toString()).toBe(
      `File size: ${
        String(compressed.length)
      } B\nEncoding: utf-16le\nDelimiter: "\\t"\nLine endings: CRLF\nCompression: gzip\nFirst record columns: 3\n`,
    );
  });

  test('probe reports mixed record endings and plain CSV with a zlib-like prefix', async () => {
    const path = join(temporaryDirectory, 'plain.csv');
    await Bun.write(path, Buffer.from('H,name\r1,\x80\n2,João\r\n', 'latin1'));
    const result = runCli('probe', path);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain(
      'Encoding: windows-1252\nDelimiter: ","\nLine endings: mixed\nCompression: none\nFirst record columns: 2',
    );
  });

  test('probe uses the only ZIP entry or the named entry in a multi-file archive', async () => {
    const single = runCli('probe', join(temporaryDirectory, 'input.zip'));
    expect(single.exitCode).toBe(0);
    expect(single.stdout.toString()).toContain('Delimiter: ";"\nLine endings: LF\nCompression: zip\nFirst record columns: 2');
    const path = join(temporaryDirectory, 'tables.zip');
    await Bun.write(
      path,
      createZip([
        { data: Buffer.from('a,b\n'), method: 8, name: 'data.csv' },
        { data: Buffer.from('a|b,c\r1|2,3'), method: 0, name: 'data.psv' },
      ]),
    );
    expectCommandError(runCli('probe', path), 'exactly one file');
    const chosen = runCli('probe', path, '--zip-entry', 'data.psv');
    expect(chosen.exitCode).toBe(0);
    expect(chosen.stdout.toString()).toContain('Delimiter: "|"\nLine endings: CR\nCompression: zip\nFirst record columns: 2');
  });

  test('probe distinguishes missing, incomplete, single-column, and ambiguous first records', async () => {
    const path = join(temporaryDirectory, 'unknown.data');
    for (
      const [input, ending, width,] of [
        ['', 'none', '0'],
        ['one field', 'none', '1'],
        ['a,b;c\n1,2;3', 'LF', 'unknown'],
        [`${'a'.repeat(65536)},b\n`, 'unknown', 'unknown'],
      ] as const
    ) {
      await Bun.write(path, input);
      const result = runCli('probe', path);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain(
        `Delimiter: undetermined\nLine endings: ${ending}\nCompression: none\nFirst record columns: ${width}`,
      );
      if (input.length > 65536) {
        expect(result.stdout.toString()).toStartWith('File size: 64 KiB\n');
      }
    }
  });

  test('probe accepts one file path and provides command help', () => {
    expectUsageError(runCli('probe'), 'probe requires one file path', 'probe');
    expectUsageError(runCli('probe', 'one', 'two'), 'probe requires one file path', 'probe');
    expectUsageError(runCli('probe', 'one', '--strict'), 'Unknown option \'--strict\'', 'probe');
    const help = runCli('probe', '--help');
    expect(help.exitCode).toBe(0);
    expect(help.stdout.toString()).toContain('Usage: csv probe <path>');
    expectCommandError(runCli('probe', join(temporaryDirectory, 'missing')), 'missing');
  });

  test('rejects an encoding probe when strict line limits forbid read-ahead', () => {
    const result = runCli('lines', join(temporaryDirectory, 'strict-prefix.csv'), '--encoding', 'auto', '--strict', '--limit', '1');
    expectUsageError(result, '--strict with --limit requires a fixed input encoding', 'lines');
  });

  test('supports compression options', () => {
    const result = runCli(
      'count',
      join(temporaryDirectory, 'input.csv.gz'),
      '--chunk-size',
      '2',
      '--compression',
      'auto',
      '--delimiter',
      ';',
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('3\n');
    expect(result.stderr.toString()).toBe('');
  });

  test('supports ZIP entry and safety options', () => {
    const result = runCli(
      'count',
      join(temporaryDirectory, 'input.zip'),
      '--compression',
      'zip',
      '--zip-entry',
      'nested/input.csv',
      '--max-compression-ratio',
      '100',
      '--max-decompressed-bytes',
      '1024',
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('3\n');
    expect(result.stderr.toString()).toBe('');
  });

  test('forwards the ZIP decompressed byte limit', () => {
    const result = runCli(
      'count',
      join(temporaryDirectory, 'input.zip'),
      '--compression',
      'zip',
      '--zip-entry',
      'nested/input.csv',
      '--max-decompressed-bytes',
      '1',
    );

    expectCommandError(result, 'maximum decompressed byte count');
  });

  test('forwards the ZIP compression ratio limit', () => {
    const result = runCli(
      'count',
      join(temporaryDirectory, 'high-ratio.zip'),
      '--compression',
      'zip',
      '--zip-entry',
      'input.csv',
      '--max-compression-ratio',
      '1',
    );

    expectCommandError(result, 'maximum compression ratio');
  });

  test('supports latin1 encoding', () => {
    const result = runCli(
      'count',
      csvFixturePath('native/latin1-names.csv'),
      '--delimiter',
      ';',
      '--encoding',
      'latin1',
      '--where',
      JSON.stringify({ column: 1, equals: 'João' }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('1\n');
    expect(result.stderr.toString()).toBe('');
  });

  test('decodes a Bun encoding for lines output', () => {
    const result = runCli(
      'lines',
      join(temporaryDirectory, 'windows-1252.csv'),
      '--delimiter',
      ';',
      '--encoding',
      'windows-1252',
      '--chunk-size',
      '1',
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('id,name\n1,€\n2,“quoted”\n');
    expect(result.stderr.toString()).toBe('');
  });

  test('supports strict validation and a fixed column count', () => {
    const result = runCli(
      'count',
      csvFixturePath('api/strict-schema-valid.csv'),
      '--delimiter',
      ';',
      '--strict',
      '--fixed-columns',
      '3',
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('2\n');
    expect(result.stderr.toString()).toBe('');
  });

  test('supports strict schema count options', () => {
    const result = runCli(
      'count',
      csvFixturePath('api/strict-schema-valid.csv'),
      '--delimiter',
      ';',
      '--strict',
      '--chunk-size',
      '1',
      '--expected-header',
      'id',
      '--expected-header',
      'name',
      '--expected-header',
      'uf',
      '--require-header',
      '--min-data-rows',
      '1',
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('2\n');
    expect(result.stderr.toString()).toBe('');
  });

  test('reports an expected header mismatch', () => {
    const result = runCli(
      'count',
      csvFixturePath('api/strict-schema-valid.csv'),
      '--delimiter',
      ';',
      '--strict',
      '--expected-header',
      'wrong',
      '--expected-header',
      'name',
      '--expected-header',
      'uf',
    );

    expectCommandError(result, 'strict CSV schema error: header mismatch at column 0');
  });

  test('reports a missing required header', () => {
    const result = runCli('count', join(temporaryDirectory, 'empty.csv'), '--strict', '--require-header', '--delimiter', ',');

    expectCommandError(result, 'strict CSV schema error: missing header row');
  });

  test('reports an insufficient data row count', () => {
    const result = runCli(
      'count',
      csvFixturePath('api/strict-schema-valid.csv'),
      '--delimiter',
      ';',
      '--strict',
      '--min-data-rows',
      '2',
    );

    expectCommandError(result, 'strict CSV schema error: expected at least 2 data row(s), got 1');
  });

  for (const option of ['--columns', '--selected-columns']) {
    test(`accepts ${option} for Count API parity`, () => {
      const result = runCli('count', csvFixturePath('rfc4180/simple-lf.csv'), option, '0');

      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe('2\n');
      expect(result.stderr.toString()).toBe('');
    });
  }

  test('reports strict syntax errors', () => {
    const result = runCli(
      'count',
      csvFixturePath('rfc4180-invalid/unescaped-quote-in-unquoted-field.csv'),
      '--strict',
    );

    expectCommandError(result, 'strict CSV quote syntax error: unescaped quote in unquoted field');
  });

  test('reports fixed column count mismatches', () => {
    const result = runCli(
      'count',
      csvFixturePath('native/fixed-column-mismatch.csv'),
      '--strict',
      '--fixed-columns',
      '3',
    );

    expectCommandError(result, 'fixed row column count mismatch');
  });

  const filterCases = [
    {
      expected: '2\n',
      filter: { column: 2, equals: 'SP' },
      name: 'equals',
    },
    {
      expected: '3\n',
      filter: { column: 2, in: ['SP', 'RJ'] },
      name: 'in',
    },
    {
      expected: '2\n',
      filter: { column: 2, notEquals: 'SP' },
      name: 'notEquals',
    },
    {
      expected: '1\n',
      filter: { column: 2, notIn: ['SP', 'RJ'] },
      name: 'notIn',
    },
    {
      expected: '1\n',
      filter: { column: 1, startsWith: 'B' },
      name: 'startsWith',
    },
    {
      expected: '2\n',
      filter: { column: 2, regex: { flags: 'i', source: '^sp$' } },
      name: 'regex',
    },
    {
      expected: '1\n',
      filter: {
        all: [
          { column: 2, in: ['SP', 'RJ'] },
          { column: 1, startsWith: 'B' },
          { column: 0, equals: '3' },
        ],
      },
      name: 'AND',
    },
    {
      expected: '3\n',
      filter: {
        any: [
          { column: 2, equals: 'SP' },
          { column: 1, equals: 'Joao' },
        ],
      },
      name: 'OR',
    },
    {
      expected: '2\n',
      filter: { not: { column: 2, equals: 'SP' } },
      name: 'NOT',
    },
    {
      expected: '2\n',
      filter: {
        all: [
          {
            any: [
              { column: 2, equals: 'SP' },
              { column: 2, equals: 'RJ' },
            ],
          },
          { not: { column: 1, startsWith: 'B' } },
        ],
      },
      name: 'nested Boolean',
    },
  ] as const;

  for (const { expected, filter, name } of filterCases) {
    test(`supports a ${name} JSON filter`, () => {
      const result = runCli(
        'count',
        csvFixturePath('api/unquoted-people-sp-filter.csv'),
        '--delimiter',
        ';',
        '--where',
        JSON.stringify(filter),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe(expected);
      expect(result.stderr.toString()).toBe('');
    });
  }

  const friendlyFilterCases: readonly {
    arguments: readonly string[];
    expected: string;
    name: string;
  }[] = [
    {
      arguments: ['--where-eq', '2=SP'],
      expected: '2\n',
      name: 'equality',
    },
    {
      arguments: ['--where-in', '2=SP', '--where-in', '2=RJ'],
      expected: '3\n',
      name: 'grouped IN',
    },
    {
      arguments: ['--where-neq', '2=SP'],
      expected: '2\n',
      name: 'inequality',
    },
    {
      arguments: ['--where-noin', '2=SP', '--where-noin', '2=RJ'],
      expected: '1\n',
      name: 'grouped NOT IN',
    },
    {
      arguments: ['--where-prefix', '1=B'],
      expected: '1\n',
      name: 'prefix',
    },
    {
      arguments: ['--where-regex', '2=/^sp$/i'],
      expected: '2\n',
      name: 'regex',
    },
    {
      arguments: [
        '--where-in',
        '2=SP',
        '--where-in',
        '2=RJ',
        '--where-prefix',
        '1=B',
        '--where-eq',
        '0=3',
      ],
      expected: '1\n',
      name: 'implicit AND',
    },
    {
      arguments: ['--where', '{"column":2,"in":["SP","RJ"]}', '--where-prefix', '1=B'],
      expected: '1\n',
      name: 'JSON and friendly AND',
    },
  ];

  for (const filterCase of friendlyFilterCases) {
    test(`supports ${filterCase.name} filter flags`, () => {
      const result = runCli(
        'count',
        csvFixturePath('api/unquoted-people-sp-filter.csv'),
        '--delimiter',
        ';',
        ...filterCase.arguments,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe(filterCase.expected);
      expect(result.stderr.toString()).toBe('');
    });
  }

  test('allows equals signs in friendly filter values', () => {
    const result = runCli('count', join(temporaryDirectory, 'equals.csv'), '--where-eq', '1=a=b');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('1\n');
    expect(result.stderr.toString()).toBe('');
  });

  test('streams normalized CSV records', () => {
    const result = runCli('lines', csvFixturePath('rfc4180/simple-lf.csv'));

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('id,name,total\n7,Ada,12\n');
    expect(result.stderr.toString()).toBe('');
  });

  test('streams records as NDJSON string arrays', () => {
    const result = runCli('lines', csvFixturePath('rfc4180/simple-lf.csv'), '--json');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('["id","name","total"]\n["7","Ada","12"]\n');
    expect(result.stderr.toString()).toBe('');
  });

  test('escapes quoted multiline fields in JSON output', () => {
    const result = runCli(
      'lines',
      join(temporaryDirectory, 'quoted.csv'),
      '--delimiter',
      ';',
      '--json',
      '--limit',
      '3',
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(
      '["id","text","note"]\n["1","a,b","say \\"hi\\""]\n["2","multi\\nline",""]\n',
    );
    expect(result.stderr.toString()).toBe('');
  });

  test('applies filters and projections before JSON output', () => {
    const result = runCli(
      'lines',
      csvFixturePath('api/unquoted-people-sp-filter.csv'),
      '--delimiter',
      ';',
      '--columns',
      '0,1',
      '--where-eq',
      '2=SP',
      '--json',
      '--limit',
      '1',
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('["1","Ana"]\n');
    expect(result.stderr.toString()).toBe('');
  });

  test('quotes fields for the output delimiter', () => {
    const result = runCli(
      'lines',
      join(temporaryDirectory, 'quoted.csv'),
      '--delimiter',
      ';',
      '--output-delimiter',
      ',',
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(
      'id,text,note\n1,"a,b","say ""hi"""\n2,"multi\nline",\n3,plain,done\n',
    );
    expect(result.stderr.toString()).toBe('');
  });

  test('uses the selected output delimiter', () => {
    const result = runCli(
      'lines',
      join(temporaryDirectory, 'quoted.csv'),
      '--delimiter',
      ';',
      '--output-delimiter',
      '|',
      '--limit',
      '2',
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('id|text|note\n1|a,b|"say ""hi"""\n');
    expect(result.stderr.toString()).toBe('');
  });

  test('supports filters and projected output columns', () => {
    const result = runCli(
      'lines',
      csvFixturePath('api/unquoted-people-sp-filter.csv'),
      '--delimiter',
      ';',
      '--columns',
      '0,1',
      '--where-eq',
      '2=SP',
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('1,Ana\n3,Bia\n');
    expect(result.stderr.toString()).toBe('');
  });

  test('supports compressed lines input', () => {
    const result = runCli(
      'lines',
      join(temporaryDirectory, 'input.csv.gz'),
      '--compression',
      'auto',
      '--delimiter',
      ';',
      '--limit',
      '2',
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('id,name\n1,Ada\n');
    expect(result.stderr.toString()).toBe('');
  });

  test('an empty file needs an explicit input delimiter and emits no bytes', () => {
    const path = join(temporaryDirectory, 'empty.csv');
    expectCommandError(runCli('lines', path), 'specify delimiter explicitly');
    const result = runCli('lines', path, '--delimiter', ',');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('');
    expect(result.stderr.toString()).toBe('');
  });

  test('stops after the requested 1-indexed output record', () => {
    const result = runCli('lines', csvFixturePath('rfc4180/simple-lf.csv'), '--limit', '1');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('id,name,total\n');
    expect(result.stderr.toString()).toBe('');
  });

  test('applies the line limit after filtering', () => {
    const result = runCli(
      'lines',
      csvFixturePath('api/unquoted-people-sp-filter.csv'),
      '--delimiter',
      ';',
      '--where-eq',
      '2=SP',
      '--limit',
      '1',
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('1,Ana,SP\n');
    expect(result.stderr.toString()).toBe('');
  });

  test('counts a quoted multiline record as one output record', () => {
    const result = runCli(
      'lines',
      join(temporaryDirectory, 'quoted.csv'),
      '--delimiter',
      ';',
      '--limit',
      '3',
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('id,text,note\n1,"a,b","say ""hi"""\n2,"multi\nline",\n');
    expect(result.stderr.toString()).toBe('');
  });

  test('does not validate input after the requested line', () => {
    const result = runCli(
      'lines',
      join(temporaryDirectory, 'strict-prefix.csv'),
      '--strict',
      '--limit',
      '1',
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('id,name\n');
    expect(result.stderr.toString()).toBe('');
  });

  test('keeps records streamed before a later input error', () => {
    const result = runCli(
      'lines',
      join(temporaryDirectory, 'strict-prefix.csv'),
      '--strict',
      '--chunk-size',
      '8',
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe('id,name\n');
    expect(result.stderr.toString()).toContain('strict CSV quote syntax error');
  });

  test('rejects strict line limits with compressed input', () => {
    const result = runCli(
      'lines',
      join(temporaryDirectory, 'input.csv.gz'),
      '--compression',
      'gzip',
      '--strict',
      '--limit',
      '1',
    );

    expectUsageError(result, '--strict with --limit does not support compressed input', 'lines');
  });

  test('exits successfully when the output pipe closes', () => {
    const result = Bun.spawnSync({
      cmd: [
        'bash',
        '-o',
        'pipefail',
        '-c',
        '"$1" "$2" lines "$3" | head -n 1 >/dev/null',
        'csv-lines-epipe',
        process.execPath,
        cliPath,
        join(temporaryDirectory, 'large.csv'),
      ],
      stderr: 'pipe',
      stdout: 'pipe',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('');
    expect(result.stderr.toString()).toBe('');
  });

  test('streams output larger than its write buffer', () => {
    const result = runCli('lines', join(temporaryDirectory, 'large.csv'));
    const stdout = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    expect(stdout).toStartWith('id,value\n0,value-0\n');
    expect(stdout).toEndWith('9999,value-9999\n');
    expect(stdout.split('\n')).toHaveLength(10_002);
    expect(result.stderr.toString()).toBe('');
  });

  test('shows command help', () => {
    const result = runCli('--help');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('count <path>');
    expect(result.stdout.toString()).toContain('lines <path>');
    expect(result.stdout.toString()).toContain('probe <path>');
    expect(result.stdout.toString()).toContain('bunx @konstit/csv <command> <path>');
    expect(result.stderr.toString()).toBe('');
  });

  test('shows every count option in count help', () => {
    const result = runCli('count', '--help');
    const stdout = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    expect(stdout).toContain('Usage: csv count <path> [options]');
    for (
      const option of [
        '--delimiter',
        '--encoding',
        '--chunk-size',
        '--compression',
        '--zip-entry',
        '--max-compression-ratio',
        '--max-decompressed-bytes',
        '--strict',
        '--fixed-columns',
        '--columns',
        '--selected-columns',
        '--expected-header',
        '--require-header',
        '--min-data-rows',
        '--where',
        '--where-eq',
        '--where-in',
        '--where-neq',
        '--where-noin',
        '--where-prefix',
        '--where-regex',
      ]
    ) {
      expect(stdout).toContain(option);
    }
    expect(stdout).toContain('--where-eq 2=SP');
    expect(stdout).toContain('--where-regex \'1=/^ana/i\'');
    expect(stdout).toContain('Friendly filter clauses use AND.');
    expect(stdout).toContain('Advanced JSON can nest all, any, and not.');
    expect(stdout).toContain('Strict mode cannot use filter options.');
    expect(stdout).not.toContain('--worker-count');
    expect(result.stderr.toString()).toBe('');
  });

  test('shows every lines option in lines help', () => {
    const result = runCli('lines', '--help');
    const stdout = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    for (const option of Object.keys(countOptionNames).concat('--json', '--output-delimiter', '--limit')) {
      expect(stdout).toContain(option);
    }
    expect(stdout).toContain('matching output record N, numbered from 1');
    expect(stdout).toContain('Filters use original input column indexes.');
    expect(stdout).toContain('validation stops');
    expect(stdout).toContain('at the selected record');
    expect(stdout).not.toContain('--worker-count');
    expect(result.stderr.toString()).toBe('');
  });

  test('reports invalid lines usage without a stack trace', () => {
    const result = runCli('lines');

    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toBe('');
    expect(result.stderr.toString()).toBe('csv: lines requires one file path\nRun \'csv lines --help\' for usage.\n');
  });

  for (const value of ['0', '-1', '1.5', '9007199254740992']) {
    test(`rejects lines limit ${value}`, () => {
      const limitArguments = value.startsWith('-') ? [`--limit=${value}`] : ['--limit', value];
      const result = runCli('lines', csvFixturePath('rfc4180/simple-lf.csv'), ...limitArguments);

      expectUsageError(result, 'limit must be an integer greater than or equal to 1', 'lines');
    });
  }

  test('rejects an automatic output delimiter', () => {
    const result = runCli(
      'lines',
      csvFixturePath('rfc4180/simple-lf.csv'),
      '--output-delimiter',
      'auto',
    );

    expectUsageError(result, 'output delimiter must be one safe ASCII character; auto is not supported', 'lines');
  });

  test('rejects a JSON output delimiter', () => {
    const result = runCli(
      'lines',
      csvFixturePath('rfc4180/simple-lf.csv'),
      '--json',
      '--output-delimiter',
      ';',
    );

    expectUsageError(result, '--json cannot be combined with --output-delimiter', 'lines');
  });

  test('rejects a line limit with a whole-file row requirement', () => {
    const result = runCli(
      'lines',
      csvFixturePath('rfc4180/simple-lf.csv'),
      '--strict',
      '--min-data-rows',
      '1',
      '--limit',
      '1',
    );

    expectUsageError(result, '--limit cannot be combined with --min-data-rows', 'lines');
  });

  test('rejects strict line limits with read-ahead options', () => {
    const result = runCli(
      'lines',
      csvFixturePath('rfc4180/simple-lf.csv'),
      '--strict',
      '--limit',
      '1',
      '--chunk-size',
      '2',
    );

    expectUsageError(result, '--strict with --limit requires --chunk-size 1', 'lines');
  });

  test('rejects strict line limits with automatic delimiter detection', () => {
    const result = runCli(
      'lines',
      csvFixturePath('rfc4180/simple-lf.csv'),
      '--strict',
      '--limit',
      '1',
      '--delimiter',
      'auto',
    );

    expectUsageError(result, '--strict with --limit requires a fixed input delimiter', 'lines');
  });

  test('reports invalid usage without a stack trace', () => {
    const result = runCli('count');

    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toBe('');
    expect(result.stderr.toString()).toBe('csv: count requires one file path\nRun \'csv count --help\' for usage.\n');
  });

  const invalidOptionCases: readonly {
    arguments: readonly string[];
    message: string;
    name: string;
  }[] = [
    {
      arguments: ['--delimiter', '||'],
      message: 'delimiter must be one safe ASCII character or auto',
      name: 'a multi-character delimiter',
    },
    {
      arguments: ['--delimiter', '"'],
      message: 'delimiter must be one safe ASCII character or auto',
      name: 'a structural quote delimiter',
    },
    {
      arguments: ['--encoding', 'utf16'],
      message: 'unsupported encoding: utf16',
      name: 'an unsupported encoding',
    },
    {
      arguments: ['--chunk-size', '0'],
      message: 'chunk size must be an integer from 1 through 67108864',
      name: 'a zero chunk size',
    },
    {
      arguments: ['--chunk-size', '67108865'],
      message: 'chunk size must be an integer from 1 through 67108864',
      name: 'an excessive chunk size',
    },
    {
      arguments: ['--fixed-columns', '0'],
      message: 'fixed columns must be an integer greater than or equal to 1',
      name: 'a zero fixed column count',
    },
    {
      arguments: ['--worker-count', '2'],
      message: 'Unknown option \'--worker-count\'',
      name: 'the removed worker count option',
    },
    {
      arguments: ['--compression', 'unknown'],
      message: 'unsupported compression format: unknown',
      name: 'an unsupported compression format',
    },
    {
      arguments: ['--compression', 'zip'],
      message: '--compression zip requires --zip-entry <path>',
      name: 'ZIP input without an entry',
    },
    {
      arguments: ['--compression', 'zip', '--zip-entry', 'data.csv', '--max-compression-ratio', '1.5'],
      message: 'maximum compression ratio must be an integer from 1 through 4294967295',
      name: 'a fractional ZIP compression ratio',
    },
    {
      arguments: ['--where', '{'],
      message: '--where must be valid JSON',
      name: 'invalid filter JSON',
    },
    {
      arguments: ['--where', '[]'],
      message: '--where must be a JSON object',
      name: 'a non-object filter',
    },
    {
      arguments: ['--where', '{"all":[]}'],
      message: '--where.all must be a non-empty array',
      name: 'an empty AND filter',
    },
    {
      arguments: ['--where', '{"any":[]}'],
      message: '--where.any must be a non-empty array',
      name: 'an empty OR filter',
    },
    {
      arguments: ['--where', '{"not":[]}'],
      message: '--where.not must be a JSON object',
      name: 'an invalid NOT filter',
    },
    {
      arguments: ['--where', JSON.stringify(nestedNotFilter(129))],
      message: '--where nesting exceeds 128',
      name: 'excessive filter nesting',
    },
    {
      arguments: ['--where', '{"column":2,"in":[]}'],
      message: '--where.in must be a non-empty string array',
      name: 'an empty in filter',
    },
    {
      arguments: ['--where', '{"column":2,"notIn":[]}'],
      message: '--where.notIn must be a non-empty string array',
      name: 'an empty notIn filter',
    },
    {
      arguments: ['--where', '{"column":2,"equals":"SP","extra":true}'],
      message: '--where contains unknown property: extra',
      name: 'an unknown filter property',
    },
    {
      arguments: ['--where', '{"column":2,"equals":1}'],
      message: '--where.equals must be a string',
      name: 'a non-string filter value',
    },
    {
      arguments: ['--where', '{"equals":"SP"}'],
      message: '--where.column must be a number',
      name: 'a missing filter column',
    },
    {
      arguments: ['--where', '{"column":2025,"equals":"SP"}'],
      message: 'filter column out of range: 2025',
      name: 'an excessive filter column',
    },
    {
      arguments: ['--where', '{"column":2,"regex":{"flags":"i"}}'],
      message: '--where.regex.source must be a string',
      name: 'a regex without a source',
    },
    {
      arguments: ['--where', '{"column":2,"regex":{"source":"["}}'],
      message: 'Invalid regular expression',
      name: 'invalid JavaScript regex syntax',
    },
    {
      arguments: ['--where', '{"column":2,"regex":{"source":"SP","flags":"g"}}'],
      message: 'unsupported regular expression flags: g',
      name: 'unsupported regex flags',
    },
    {
      arguments: ['--where', '{"column":2,"regex":{"source":"(?=SP)"}}'],
      message: 'invalid regular expression: invalid perl operator',
      name: 'an RE2-incompatible regex',
    },
    {
      arguments: [
        '--where',
        JSON.stringify({
          all: Array.from({ length: 33 }, () => ({ column: 2, regex: { source: 'SP' } })),
        }),
      ],
      message: 'regex filter count out of range: 33',
      name: 'too many regex filters',
    },
    {
      arguments: [
        '--where',
        JSON.stringify({
          all: Array.from({ length: 2025 }, () => ({ column: 2, equals: 'SP' })),
        }),
      ],
      message: 'filter count out of range: 2025',
      name: 'too many filters',
    },
    {
      arguments: ['--columns', '2025'],
      message: 'selected column out of range: 2025',
      name: 'an excessive selected column',
    },
    {
      arguments: ['--where-eq', '2'],
      message: '--where-eq must use <column>=<value>',
      name: 'an equality flag without a value separator',
    },
    {
      arguments: ['--where-eq', 'state=SP'],
      message: '--where-eq column must be an integer',
      name: 'a non-numeric friendly filter column',
    },
    {
      arguments: ['--where-prefix', '2025=A'],
      message: 'filter column out of range: 2025',
      name: 'an excessive friendly filter column',
    },
    {
      arguments: ['--where-regex', '1=^A'],
      message: '--where-regex must use <column>=/<pattern>/<flags>',
      name: 'a regex flag without literal syntax',
    },
    {
      arguments: ['--where-regex', '1=/[/'],
      message: 'Invalid regular expression',
      name: 'invalid friendly JavaScript regex syntax',
    },
    {
      arguments: ['--where-regex', '1=/(?=A)/'],
      message: 'invalid regular expression: invalid perl operator',
      name: 'a friendly RE2-incompatible regex',
    },
  ];

  for (const invalidCase of invalidOptionCases) {
    test(`rejects ${invalidCase.name}`, () => {
      const result = runCli(
        'count',
        csvFixturePath('api/unquoted-people-sp-filter.csv'),
        ...invalidCase.arguments,
      );

      expectUsageError(result, invalidCase.message);
    });
  }

  const incompatibleOptionCases: readonly {
    arguments: readonly string[];
    message: string;
    name: string;
  }[] = [
    {
      arguments: ['--columns', '0', '--selected-columns', '1'],
      message: 'use --columns or --selected-columns, not both',
      name: 'both column option aliases',
    },
    {
      arguments: ['--fixed-columns', '3'],
      message: '--fixed-columns requires --strict',
      name: 'fixed columns without strict mode',
    },
    {
      arguments: ['--expected-header', 'id'],
      message: '--expected-header, --require-header, and --min-data-rows require --strict',
      name: 'strict schema options without strict mode',
    },
    {
      arguments: ['--strict', '--where', '{"column":2,"equals":"SP"}'],
      message: '--strict cannot be combined with filter options',
      name: 'strict mode and filtering',
    },
    {
      arguments: ['--strict', '--where-eq', '2=SP'],
      message: '--strict cannot be combined with filter options',
      name: 'strict mode and friendly filtering',
    },
  ];

  for (const incompatibleCase of incompatibleOptionCases) {
    test(`rejects ${incompatibleCase.name}`, () => {
      const result = runCli(
        'count',
        csvFixturePath('api/unquoted-people-sp-filter.csv'),
        ...incompatibleCase.arguments,
      );

      expectUsageError(result, incompatibleCase.message);
    });
  }

  test('reports file errors without a stack trace', () => {
    const missingPath = join(import.meta.dir, 'missing-cli-input.csv');
    const result = runCli('count', missingPath);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe('');
    expect(result.stderr.toString()).toContain('csv: ');
    expect(result.stderr.toString()).toContain('missing-cli-input.csv');
    expect(result.stderr.toString()).not.toContain('\n    at ');
  });
});

function runCli(...arguments_: string[]) {
  return Bun.spawnSync({
    cmd: [process.execPath, cliPath, ...arguments_],
    stderr: 'pipe',
    stdout: 'pipe',
  });
}

const countOptionNames = {
  '--chunk-size': true,
  '--columns': true,
  '--compression': true,
  '--delimiter': true,
  '--encoding': true,
  '--expected-header': true,
  '--fixed-columns': true,
  '--max-compression-ratio': true,
  '--max-decompressed-bytes': true,
  '--min-data-rows': true,
  '--require-header': true,
  '--selected-columns': true,
  '--strict': true,
  '--where': true,
  '--where-eq': true,
  '--where-in': true,
  '--where-neq': true,
  '--where-noin': true,
  '--where-prefix': true,
  '--where-regex': true,
  '--zip-entry': true,
};

function nestedNotFilter(depth: number): unknown {
  let filter: unknown = { column: 0, equals: 'id' };
  for (let index = 0; index < depth; ++index) {
    filter = { not: filter };
  }
  return filter;
}

function expectUsageError(result: ReturnType<typeof runCli>, message: string, command = 'count'): void {
  expect(result.exitCode).toBe(2);
  expect(result.stdout.toString()).toBe('');
  expect(result.stderr.toString()).toContain(`csv: ${message}`);
  expect(result.stderr.toString()).toContain(`Run 'csv ${command} --help' for usage.`);
  expect(result.stderr.toString()).not.toContain('\n    at ');
}

function expectCommandError(result: ReturnType<typeof runCli>, message: string): void {
  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toBe('');
  expect(result.stderr.toString()).toStartWith('csv: ');
  expect(result.stderr.toString()).toContain(message);
  expect(result.stderr.toString()).not.toContain('\n    at ');
}
