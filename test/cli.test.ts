import {
  afterAll,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test';
import iconv from 'iconv-lite';
import {
  mkdtemp,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli as runCommand } from '../src/cli-command.ts';
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
  test('the executable forwards its arguments, output, and exit status', async () => {
    const originalArgs = Bun.argv.slice(2);
    const status = process.exitCode;
    using write = spyOn(Bun, 'write');
    write.mockResolvedValue(0);
    try {
      Bun.argv.splice(2, originalArgs.length, 'lines', join(temporaryDirectory, 'equals.csv'), '--limit', '1');
      process.exitCode = 42;
      await import('../src/cli.ts');
      expect(process.exitCode).toBe(0);
      expect(write).toHaveBeenCalledWith(Bun.stdout, 'id,value\n');
    } finally {
      Bun.argv.splice(2, Bun.argv.length - 2, ...originalArgs);
      process.exitCode = status;
    }
  });

  test('rejects abbreviated and unknown subcommand names', async () => {
    for (const name of ['c', 'cou', 'unknown']) {
      const result = await runCli(name);
      expect(result.exitCode).toBe(2);
      expect(result.stdout.length).toBe(0);
      expect(result.stderr.toString()).toContain(`csv: unexpected argument '${name}'`);
      expect(result.stderr.toString()).toContain('Run \'csv --help\' for usage.');
    }
  });

  test('stops writing when the output stream closes', async () => {
    const exitCode = await runCommand(['lines', join(temporaryDirectory, 'large.csv')], {
      log: () => {
        throw new Error('unexpected log');
      },
      error: () => {
        throw new Error('unexpected diagnostic');
      },
      write: () => {
        throw Object.assign(new Error('closed pipe'), { code: 'EPIPE' });
      },
    });
    expect(exitCode).toBe(0);
  });

  test('rejects ZIP-only flags without ZIP compression and incomplete filter predicates', async () => {
    for (
      const [args, message,] of [
        [['--max-compression-ratio', '3'], 'argument group \'zip-limits\' requires \'--zip-entry\''],
        [['--max-decompressed-bytes', '1KiB'], 'argument group \'zip-limits\' requires \'--zip-entry\''],
        [['--zip-entry', 'rows.csv'], 'argument \'--zip-entry\' requires \'--compression\''],
        [['--compression', 'gzip', '--zip-entry', 'rows.csv'], '--zip-entry requires --compression zip'],
        [['--compression', 'zip', '--zip-entry='], 'invalid value \'\' for \'--zip-entry\': expected a non-empty ZIP entry name'],
        [['--where', '{"column":1,"regex":false}'], '--where.regex must contain source and optional flags strings'],
        [['--where', '{"column":1}'], '--where must contain equals, in, notEquals, notIn, startsWith, or regex'],
      ] as const
    ) {
      expectUsageError(await runCli('count', 'input.csv', ...args), message);
    }
  });

  test('an inherited predicate cannot supply a missing filter key', async () => {
    // Model an inherited property without changing Object.prototype for the process.
    using parse = spyOn(JSON, 'parse');
    parse.mockReturnValueOnce(Object.assign(Object.create({ equals: 'x' }), { column: 0 }));
    expectUsageError(await runCli('count', 'input.csv', '--where', '{"column":0}'), '--where is missing property: equals');
  });

  test('an invalid option value fails before a later override or help request', async () => {
    const path = csvFixturePath('rfc4180/simple-lf.csv');
    for (const suffix of [['--limit', '1'], ['--help']]) {
      expectUsageError(await runCli('lines', path, '--limit', 'bad', ...suffix), 'invalid value \'bad\' for \'--limit\'', 'lines');
    }
    expectUsageError(await runCli('count', path, '--where', '{', '--help'), 'invalid value \'{\' for \'--where\': expected valid JSON');
    expectUsageError(
      await runCli('count', path, '--where-in', '=x', '--help'),
      'invalid value \'=x\' for \'--where-in\': expected KEY=VALUE',
    );
    expectUsageError(
      await runCli('probe', path, '--zip-entry=', '--help'),
      'invalid value \'\' for \'--zip-entry\': expected a non-empty ZIP entry name',
      'probe',
    );
    expect(await runCli('lines', '--help', '--limit', 'bad')).toEqual(await runCli('lines', '--help'));
  });

  test('accepts decimal counts and applies the last valid limit', async () => {
    const path = csvFixturePath('rfc4180/simple-lf.csv');
    const result = await runCli('lines', path, '--strict', '--fixed-columns', '03', '--limit', '2', '--limit', '+1');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('id,name,total\n');
    const count = await runCli('count', path, '--strict', '--min-data-rows=0');
    expect(count.exitCode).toBe(0);
    expect(count.stdout.toString()).toBe('2\n');
  });

  test('requires decimal integer text for counts, limits, and the compression ratio', async () => {
    const path = csvFixturePath('rfc4180/simple-lf.csv');
    for (
      const [option, value,] of [
        ['--fixed-columns', '3.0'],
        ['--min-data-rows', ''],
        ['--limit', '2e0'],
        ['--max-compression-ratio', '0x10'],
      ] as const
    ) {
      expectUsageError(
        await runCli('lines', path, `${option}=${value}`, '--help'),
        `invalid value '${value}' for '${option}': expected an integer`,
        'lines',
      );
    }
  });

  test('counts every record in a CSV file', async () => {
    const result = await runCli('count', csvFixturePath('rfc4180/simple-lf.csv'));

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('2\n');
    expect(result.stderr.toString()).toBe('');
  });

  test('supports delimiter and chunk size options', async () => {
    const result = await runCli(
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

  test('supports automatic delimiter detection', async () => {
    const result = await runCli('count', csvFixturePath('api/unquoted-people-sp-filter.csv'), '--delimiter', 'auto');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('4\n');
    expect(result.stderr.toString()).toBe('');
  });

  test('accepts unitless, SI, and IEC chunk sizes and enforces the byte limit after conversion', async () => {
    const path = csvFixturePath('rfc4180/simple-lf.csv');
    for (const size of ['1024', '0x400', '1.5KB', '1.5KiB']) {
      const result = await runCli('count', path, '--chunk-size', size);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe('2\n');
    }
    expectUsageError(
      await runCli('count', path, '--chunk-size', '65MiB'),
      'invalid value \'65MiB\' for \'--chunk-size\': expected at most 64 MiB',
    );
    expectUsageError(await runCli('count', path, '--chunk-size', '0.1B'), 'invalid value \'0.1B\' for \'--chunk-size\'');
    expectUsageError(await runCli('count', path, '--chunk-size', '1.5'), 'invalid value \'1.5\' for \'--chunk-size\'');
    expectUsageError(await runCli('count', path, '--chunk-size', '8PiB'), 'invalid value \'8PiB\' for \'--chunk-size\'');
  });

  test('detects the encoding with a fixed delimiter and detects both for filtered counts', async () => {
    const path = join(temporaryDirectory, 'windows-1252.csv');
    const lines = await runCli('lines', path, '--encoding', 'auto', '--delimiter', ';', '--json');
    expect(lines.exitCode).toBe(0);
    expect(lines.stdout.toString()).toBe('["id","name"]\n["1","€"]\n["2","“quoted”"]\n');
    const count = await runCli('count', path, '--where-eq', '1=€');
    expect(count.exitCode).toBe(0);
    expect(count.stdout.toString()).toBe('1\n');
    expect((await runCli('lines', path, '--json')).stdout.toString()).toBe(lines.stdout.toString());
  });

  test('probe reports the compressed size and the format of quoted UTF-16 records', async () => {
    const path = join(temporaryDirectory, 'compressed-without-extension');
    const compressed = Bun.gzipSync(Buffer.from('\ufeff"first\nfield"\t"say ""hi""\there"\t\r\n1\t2\t3\r\n', 'utf16le'));
    await Bun.write(path, compressed);
    const result = await runCli('probe', path);
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
    const result = await runCli('probe', path);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain(
      'Encoding: windows-1252\nDelimiter: ","\nLine endings: mixed\nCompression: none\nFirst record columns: 2',
    );
  });

  test('probe uses the only ZIP entry or the named entry in a multi-file archive', async () => {
    const single = await runCli('probe', join(temporaryDirectory, 'input.zip'));
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
    expectCommandError(await runCli('probe', path), 'exactly one file');
    const chosen = await runCli('probe', path, '--zip-entry', 'data.psv');
    expect(chosen.exitCode).toBe(0);
    expect(chosen.stdout.toString()).toContain('Delimiter: "|"\nLine endings: CR\nCompression: zip\nFirst record columns: 2');
  });

  test('probe ignores OS metadata when automatically selecting a ZIP entry', async () => {
    const path = join(temporaryDirectory, 'with-metadata.zip');
    await Bun.write(
      path,
      createZip([
        { data: Buffer.from('metadata'), method: 0, name: '__MACOSX/._example.csv' },
        { data: Buffer.from('id;name\n1;Ada\n'), method: 8, name: 'example.csv' },
        { data: Buffer.from('metadata'), method: 0, name: '.DS_Store' },
        { data: Buffer.from('metadata'), method: 0, name: 'Thumbs.db' },
      ]),
    );
    for (const arguments_ of [[], ['--zip-entry', '*']]) {
      const result = await runCli('probe', path, ...arguments_);
      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).toBe('');
      expect(result.stdout.toString()).toContain('Delimiter: ";"\nLine endings: LF\nCompression: zip\nFirst record columns: 2');
    }
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
      const result = await runCli('probe', path);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain(
        `Delimiter: undetermined\nLine endings: ${ending}\nCompression: none\nFirst record columns: ${width}`,
      );
      if (input.length > 65536) {
        expect(result.stdout.toString()).toStartWith('File size: 64 KiB\n');
      }
    }
  });

  test('probe accepts one file path and provides command help', async () => {
    expectUsageError(await runCli('probe'), 'the following required arguments were not provided: <path>', 'probe');
    expectUsageError(await runCli('probe', 'one', 'two'), 'unexpected argument \'two\'', 'probe');
    expectUsageError(await runCli('probe', 'one', '--strict'), 'unexpected argument \'--strict\'', 'probe');
    const help = await runCli('probe', '--help');
    expect(help.exitCode).toBe(0);
    expect(help.stdout.toString()).toContain('Usage: csv probe [OPTIONS] <PATH>');
    expectCommandError(await runCli('probe', join(temporaryDirectory, 'missing')), 'missing');
  });

  test('rejects an encoding probe when strict line limits forbid read-ahead', async () => {
    const result = await runCli('lines', join(temporaryDirectory, 'strict-prefix.csv'), '--encoding', 'auto', '--strict', '--limit', '1');
    expectUsageError(result, '--strict with --limit requires a fixed input encoding', 'lines');
  });

  test('supports compression options', async () => {
    const result = await runCli(
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

  test('defaults to auto compression for compressed and plain paths, with an explicit raw mode', async () => {
    const gzip = await runCli('lines', join(temporaryDirectory, 'input.csv.gz'), '--limit', '1');
    expect(gzip.exitCode).toBe(0);
    expect(gzip.stdout.toString()).toBe('id,name\n');
    const plain = await runCli('count', join(temporaryDirectory, 'equals.csv'), '--compression', 'auto');
    expect(plain.exitCode).toBe(0);
    expect(plain.stdout.toString()).toBe('3\n');
    const unknown = join(temporaryDirectory, 'records');
    await Bun.write(unknown, 'x,y\n1,2\n');
    expectCommandError(await runCli('count', unknown), 'no supported signature');
    expect((await runCli('count', unknown, '--compression', 'none')).stdout.toString()).toBe('2\n');
  });

  test('auto replays a split signature and decompresses non-seekable input', () => {
    const result = runCliFromPipe(Bun.gzipSync(Buffer.from('id;name\n1;Ada\n')), 'lines');
    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('id,name\n1,Ada\n');
  });

  test('supports ZIP entry and safety options', async () => {
    const result = await runCli(
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

  test('count and lines automatically select ZIP data while ignoring OS metadata', async () => {
    const path = join(temporaryDirectory, 'auto-select.zip');
    await Bun.write(
      path,
      createZip([
        { data: Buffer.from('metadata'), method: 0, name: '__MACOSX/._input.csv' },
        { data: Buffer.from('id;name\n1;Ada\n2;Bob\n'), method: 8, name: 'input.csv' },
        { data: Buffer.from('metadata'), method: 0, name: '.DS_Store' },
      ]),
    );
    const count = await runCli('count', path);
    expect(count.exitCode).toBe(0);
    expect(count.stdout.toString()).toBe('3\n');
    expect(count.stderr.toString()).toBe('');
    const lines = await runCli('lines', path, '--compression', 'auto', '--limit', '2');
    expect(lines.exitCode).toBe(0);
    expect(lines.stdout.toString()).toBe('id,name\n1,Ada\n');
    expect(lines.stderr.toString()).toBe('');
  });

  test('limited ZIP lines can stop before a corrupt final chunk', async () => {
    const path = join(temporaryDirectory, 'late-crc.zip');
    const prefix = '1,a\n'.repeat(16_500);
    const data = Buffer.from(`${prefix}4,early\n${prefix}2,match\n${'3,z\n'.repeat(4096)}`);
    const crc32 = (Bun.hash.crc32(data) ^ 1) >>> 0;
    await Bun.write(path, createZip([{ data, method: 8, name: 'rows.csv', crc32 }]));
    const result = await runCli('lines', path, '--chunk-size', '1024', '--where-eq', '0=2', '--limit', '1');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('2,match\n');
    const prefetched = await runCli('lines', path, '--chunk-size', '65536', '--where-eq', '0=4', '--limit', '1');
    expect(prefetched.exitCode).toBe(0);
    expect(prefetched.stdout.toString()).toBe('4,early\n');
    expectCommandError(await runCli('lines', path, '--chunk-size', '65536', '--where-eq', '0=2'), 'CRC32');
  });

  test('rejects auto-detected ZIP input from a pipe', () => {
    const result = runCliFromPipe(createZip([{ data: Buffer.from('a,b\n1,2\n'), method: 0, name: 'input.csv' }]), 'count');
    expectCommandError(result, 'ZIP input requires a regular file');
  });

  test('forwards the ZIP decompressed byte limit', async () => {
    const result = await runCli(
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

  test('forwards the ZIP compression ratio limit', async () => {
    const result = await runCli(
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

  test('applies decimal and binary size limits to the actual decompressed ZIP bytes', async () => {
    const args = [
      'count',
      join(temporaryDirectory, 'high-ratio.zip'),
      '--compression',
      'zip',
      '--zip-entry',
      'input.csv',
      '--max-compression-ratio',
      '1000',
      '--max-decompressed-bytes',
    ];
    expectCommandError(await runCli(...args, '16KB'), 'maximum decompressed byte count');
    const exact = await runCli(...args, '16KiB');
    expect(exact.exitCode).toBe(0);
    expect(exact.stdout.toString()).toBe('4096\n');
    expectUsageError(
      await runCli(...args, '0B'),
      'invalid value \'0B\' for \'--max-decompressed-bytes\': expected at least 1 byte',
    );
    expect((await runCli(...args, '9007199254740991')).exitCode).toBe(0);
    expectUsageError(await runCli(...args, '9007199254740992'), 'invalid value \'9007199254740992\' for \'--max-decompressed-bytes\'');
  });

  test('supports latin1 encoding', async () => {
    const result = await runCli(
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

  test('decodes a Bun encoding for lines output', async () => {
    const result = await runCli(
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

  test('accepts decoder aliases and distinguishes native Latin-1 from Windows-1252', async () => {
    const path = join(temporaryDirectory, 'windows-1252.csv');
    const windows = await runCli('lines', path, '--encoding', '  CP1252  ');
    const latin = await runCli('lines', path, '--encoding', 'ISO-8859-1');
    expect(windows.exitCode).toBe(0);
    expect(latin.exitCode).toBe(0);
    expect(windows.stdout.toString()).toContain('1,€\n');
    expect(latin.stdout.toString()).toContain('1,\u0080\n');
  });

  test('supports strict validation and a fixed column count', async () => {
    const result = await runCli(
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

  test('supports strict schema count options', async () => {
    const result = await runCli(
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

  test('reports an expected header mismatch', async () => {
    const result = await runCli(
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

  test('retains an explicitly empty expected header', async () => {
    const path = join(temporaryDirectory, 'empty-header.csv');
    await Bun.write(path, ',name\n1,Ada\n');
    const headers = ['--expected-header=', '--expected-header', 'name'];
    const result = await runCli('count', path, '--strict', ...headers);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('2\n');
    expectCommandError(await runCli('count', path, '--strict', '--expected-header', 'name'), 'header');
  });

  test('reports a missing required header', async () => {
    const result = await runCli('count', join(temporaryDirectory, 'empty.csv'), '--strict', '--require-header', '--delimiter', ',');

    expectCommandError(result, 'strict CSV schema error: missing header row');
  });

  test('reports an insufficient data row count', async () => {
    const result = await runCli(
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

  test('accepts --columns for count', async () => {
    const result = await runCli('count', csvFixturePath('rfc4180/simple-lf.csv'), '--columns', '0');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('2\n');
    expect(result.stderr.toString()).toBe('');
  });

  test('reports strict syntax errors', async () => {
    const result = await runCli(
      'count',
      csvFixturePath('rfc4180-invalid/unescaped-quote-in-unquoted-field.csv'),
      '--strict',
    );

    expectCommandError(result, 'strict CSV quote syntax error: unescaped quote in unquoted field');
  });

  test('reports fixed column count mismatches', async () => {
    const result = await runCli(
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
    test(`supports a ${name} JSON filter`, async () => {
      const result = await runCli(
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
    test(`supports ${filterCase.name} filter flags`, async () => {
      const result = await runCli(
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

  test('allows equals signs in friendly filter values', async () => {
    const result = await runCli('count', join(temporaryDirectory, 'equals.csv'), '--where-eq', '1=a=b');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('1\n');
    expect(result.stderr.toString()).toBe('');
  });

  test('matches an empty friendly filter value', async () => {
    const result = await runCli('count', join(temporaryDirectory, 'quoted.csv'), '--delimiter', ';', '--where-eq', '2=');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('1\n');
  });

  test('streams normalized CSV records', async () => {
    const result = await runCli('lines', csvFixturePath('rfc4180/simple-lf.csv'));

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('id,name,total\n7,Ada,12\n');
    expect(result.stderr.toString()).toBe('');
  });

  test('streams records as NDJSON string arrays', async () => {
    const result = await runCli('lines', csvFixturePath('rfc4180/simple-lf.csv'), '--json');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('["id","name","total"]\n["7","Ada","12"]\n');
    expect(result.stderr.toString()).toBe('');
  });

  test('escapes quoted multiline fields in JSON output', async () => {
    const result = await runCli(
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

  test('applies filters and projections before JSON output', async () => {
    const result = await runCli(
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

  test('quotes fields for the output delimiter', async () => {
    const result = await runCli(
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

  test('uses the selected output delimiter', async () => {
    const result = await runCli(
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

  test('supports filters and projected output columns', async () => {
    const result = await runCli(
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

  test('supports compressed lines input', async () => {
    const result = await runCli(
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

  test('an empty file needs an explicit input delimiter and emits no bytes', async () => {
    const path = join(temporaryDirectory, 'empty.csv');
    expectCommandError(await runCli('lines', path), 'specify delimiter explicitly');
    const result = await runCli('lines', path, '--delimiter', ',');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('');
    expect(result.stderr.toString()).toBe('');
  });

  test('stops after the requested 1-indexed output record', async () => {
    const result = await runCli('lines', csvFixturePath('rfc4180/simple-lf.csv'), '--limit', '1');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('id,name,total\n');
    expect(result.stderr.toString()).toBe('');
  });

  test('applies the line limit after filtering', async () => {
    const result = await runCli(
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

  test('counts a quoted multiline record as one output record', async () => {
    const result = await runCli(
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

  test('does not validate input after the requested line', async () => {
    const result = await runCli(
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

  test('keeps records streamed before a later input error', async () => {
    const result = await runCli(
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

  test('rejects strict line limits with compressed input', async () => {
    const result = await runCli(
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

  test('streams output larger than its write buffer', async () => {
    const result = await runCli('lines', join(temporaryDirectory, 'large.csv'));
    const stdout = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    expect(stdout).toStartWith('id,value\n0,value-0\n');
    expect(stdout).toEndWith('9999,value-9999\n');
    expect(stdout.split('\n')).toHaveLength(10_002);
    expect(result.stderr.toString()).toBe('');
  });

  test('lists subcommands with --help or no arguments', async () => {
    const result = await runCli('--help');

    expect(result.exitCode).toBe(0);
    for (const name of ['count', 'lines', 'probe', 'completion']) {
      expect(result.stdout.toString()).toContain(`\n  ${name} `);
    }
    expect(result.stdout.toString()).toContain('bunx @konstit/csv <command> <path>');
    expect(result.stderr.toString()).toBe('');
    expect(await runCli()).toEqual(result);
  });

  test('shows every count option in count help', async () => {
    const result = await runCli('count', '--help');
    const stdout = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    expect(stdout).toContain('Usage: csv count [OPTIONS] <PATH>');
    expect(stdout).toContain('shift_jis');
    expect(stdout).toContain('windows-1252');
    expect(stdout).toContain('deflate-raw');
    expect(stdout).toContain('256KiB');
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

  test('help displays immediately and the help subcommand selects the same command', async () => {
    for (const name of ['count', 'lines', 'probe', 'completion']) {
      const expected = await runCli('help', name);
      expect(expected.exitCode).toBe(0);
      expect(expected.stdout.toString()).toContain(`Usage: csv ${name}`);
      const result = await runCli(name, '--help', '--bogus');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toEqual(expected.stdout);
      expect(result.stderr.length).toBe(0);
      expectUsageError(await runCli(name, '--bogus', '--help'), 'unexpected argument \'--bogus\'', name);
    }
  });

  test('generates completion scripts with csv commands, options and enum values', async () => {
    for (
      const [shell, header,] of [
        ['bash', '# bash completion for csv'],
        ['zsh', '#compdef csv'],
        ['fish', '# fish completion for csv'],
        ['powershell', '# PowerShell completion for csv'],
      ] as const
    ) {
      const result = await runCli('completion', shell);
      expect(result.exitCode).toBe(0);
      expect(result.stderr.length).toBe(0);
      const script = result.stdout.toString();
      expect(script).toStartWith(header);
      for (const candidate of ['probe', '--chunk-size', '--encoding', 'shift_jis', 'deflate-raw']) {
        expect(script).toContain(candidate);
      }
    }
    const invalid = await runCli('completion', 'unknown');
    expectUsageError(invalid, 'invalid value \'unknown\'', 'completion');
    expect(invalid.stderr.toString()).toContain('expected one of: bash, zsh, fish, powershell');
  });

  test('shows every lines option in lines help', async () => {
    const result = await runCli('lines', '--help');
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

  test('reports invalid lines usage without a stack trace', async () => {
    const result = await runCli('lines');
    expectUsageError(result, 'the following required arguments were not provided: <path>', 'lines');
  });

  for (
    const [value, message,] of [
      ['0', 'expected an integer from 1 to 9007199254740991'],
      ['-1', 'expected an integer from 1 to 9007199254740991'],
      ['1.5', 'expected an integer'],
      ['9007199254740992', 'integer is outside the safe range'],
    ] as const
  ) {
    test(`rejects lines limit ${value}`, async () => {
      const limitArguments = value.startsWith('-') ? [`--limit=${value}`] : ['--limit', value];
      const result = await runCli('lines', csvFixturePath('rfc4180/simple-lf.csv'), ...limitArguments);

      expectUsageError(result, `invalid value '${value}' for '--limit': ${message}`, 'lines');
    });
  }

  test('rejects an automatic output delimiter', async () => {
    const result = await runCli(
      'lines',
      csvFixturePath('rfc4180/simple-lf.csv'),
      '--output-delimiter',
      'auto',
    );

    expectUsageError(result, 'invalid value \'auto\' for \'--output-delimiter\': expected one safe ASCII character', 'lines');
  });

  test('rejects a JSON output delimiter', async () => {
    const result = await runCli(
      'lines',
      csvFixturePath('rfc4180/simple-lf.csv'),
      '--json',
      '--output-delimiter',
      ';',
    );

    expectUsageError(result, 'arguments \'--json\' and \'--output-delimiter\' cannot be used together', 'lines');
  });

  test('rejects a line limit with a whole-file row requirement', async () => {
    const result = await runCli(
      'lines',
      csvFixturePath('rfc4180/simple-lf.csv'),
      '--strict',
      '--min-data-rows',
      '1',
      '--limit',
      '1',
    );

    expectUsageError(result, 'arguments \'--limit\' and \'--min-data-rows\' cannot be used together', 'lines');
  });

  test('rejects strict line limits with read-ahead options', async () => {
    const result = await runCli(
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

  test('rejects strict line limits with automatic delimiter detection', async () => {
    const result = await runCli(
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

  test('reports invalid usage without a stack trace', async () => {
    const result = await runCli('count');
    expectUsageError(result, 'the following required arguments were not provided: <path>');
  });

  const invalidOptionCases: readonly {
    arguments: readonly string[];
    message: string;
    name: string;
  }[] = [
    {
      arguments: ['--delimiter', '||'],
      message: 'invalid value \'||\' for \'--delimiter\': expected one safe ASCII character or auto',
      name: 'a multi-character delimiter',
    },
    {
      arguments: ['--delimiter', '"'],
      message: `invalid value '"' for '--delimiter': expected one safe ASCII character or auto`,
      name: 'a structural quote delimiter',
    },
    {
      arguments: ['--encoding', 'utf16'],
      message: 'invalid value \'utf16\' for \'--encoding\': unsupported encoding: utf16',
      name: 'an unsupported encoding',
    },
    {
      arguments: ['--chunk-size', '0'],
      message: 'invalid value \'0\' for \'--chunk-size\': expected at least 1 byte',
      name: 'a zero chunk size',
    },
    {
      arguments: ['--chunk-size', '67108865'],
      message: 'invalid value \'67108865\' for \'--chunk-size\': expected at most 64 MiB',
      name: 'an excessive chunk size',
    },
    {
      arguments: ['--strict', '--fixed-columns', '0'],
      message: 'invalid value \'0\' for \'--fixed-columns\': expected an integer from 1 to 4294967295',
      name: 'a zero fixed column count',
    },
    {
      arguments: ['--selected-columns', '0'],
      message: 'unexpected argument \'--selected-columns\'',
      name: 'the removed column selection alias',
    },
    {
      arguments: ['--worker-count', '2'],
      message: 'unexpected argument \'--worker-count\'',
      name: 'the removed worker count option',
    },
    {
      arguments: ['--compression', 'unknown'],
      message:
        'invalid value \'unknown\' for \'--compression\': expected one of: auto, none, gzip, deflate, deflate-raw, brotli, zstd, zip',
      name: 'an unsupported compression format',
    },
    {
      arguments: ['--compression', 'zip'],
      message: 'argument \'--compression\' requires \'--zip-entry\' when its value is \'zip\'',
      name: 'ZIP input without an entry',
    },
    {
      arguments: ['--compression', 'zip', '--zip-entry', 'data.csv', '--max-compression-ratio', '1.5'],
      message: 'invalid value \'1.5\' for \'--max-compression-ratio\': expected an integer',
      name: 'a fractional ZIP compression ratio',
    },
    {
      arguments: ['--where', '{'],
      message: 'invalid value \'{\' for \'--where\': expected valid JSON',
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
      message: 'invalid value \'2\' for \'--where-eq\': expected KEY=VALUE with a non-empty key',
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
    test(`rejects ${invalidCase.name}`, async () => {
      const result = await runCli(
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
      arguments: ['--fixed-columns', '3'],
      message: 'argument group \'schema\' requires \'--strict\'',
      name: 'fixed columns without strict mode',
    },
    {
      arguments: ['--expected-header', 'id'],
      message: 'argument group \'schema\' requires \'--strict\'',
      name: 'strict schema options without strict mode',
    },
    {
      arguments: ['--strict', '--where', '{"column":2,"equals":"SP"}'],
      message: 'argument group \'filters\' conflicts with \'--strict\'',
      name: 'strict mode and filtering',
    },
    {
      arguments: ['--strict', '--where-eq', '2=SP'],
      message: 'argument group \'filters\' conflicts with \'--strict\'',
      name: 'strict mode and friendly filtering',
    },
  ];

  for (const incompatibleCase of incompatibleOptionCases) {
    test(`rejects ${incompatibleCase.name} for count and lines`, async () => {
      for (const command of ['count', 'lines']) {
        const result = await runCli(command, csvFixturePath('api/unquoted-people-sp-filter.csv'), ...incompatibleCase.arguments);
        expectUsageError(result, incompatibleCase.message, command);
      }
    });
  }

  test('reports file errors without a stack trace', async () => {
    const missingPath = join(import.meta.dir, 'missing-cli-input.csv');
    const result = await runCli('count', missingPath);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe('');
    expect(result.stderr.toString()).toContain('csv: ');
    expect(result.stderr.toString()).toContain('missing-cli-input.csv');
    expect(result.stderr.toString()).not.toContain('\n    at ');
  });
});

interface CliResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

function runCliFromPipe(stdin: Uint8Array, command: string): CliResult {
  // Bun can back a byte-array stdin with a seekable file on Linux.
  return Bun.spawnSync({
    cmd: ['sh', '-c', 'cat | "$@"', 'csv-input-pipe', process.execPath, cliPath, command, '/dev/stdin', '--chunk-size', '1'],
    stdin,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 5_000,
  });
}

async function runCli(...arguments_: string[]): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCommand(arguments_, {
    log: (message) => stdout.push(`${String(message)}\n`),
    error: (message) => stderr.push(`${message}\n`),
    write: (chunk) => {
      stdout.push(chunk);
      return Promise.resolve(Buffer.byteLength(chunk));
    },
  });
  return { exitCode, stdout: Buffer.from(stdout.join('')), stderr: Buffer.from(stderr.join('')) };
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

function expectUsageError(result: CliResult, message: string, command = 'count'): void {
  expect(result.exitCode).toBe(2);
  expect(result.stdout.toString()).toBe('');
  expect(result.stderr.toString()).toContain(`csv: ${message}`);
  expect(result.stderr.toString()).toContain(`Run 'csv ${command} --help' for usage.`);
  expect(result.stderr.toString()).not.toContain('\n    at ');
}

function expectCommandError(result: CliResult, message: string): void {
  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toBe('');
  expect(result.stderr.toString()).toStartWith('csv: ');
  expect(result.stderr.toString()).toContain(message);
  expect(result.stderr.toString()).not.toContain('\n    at ');
}
