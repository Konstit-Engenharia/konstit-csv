// Installs a package tarball in a temporary project and smoke-tests its native CSV parser.
import { Glob } from 'bun';
import {
  mkdtemp,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import {
  nativeLibraryFileName,
  packagedNativeTargets,
  repoRoot,
} from './native-target.ts';

const tarball = process.argv[2];
if (tarball === undefined) {
  throw new Error('usage: bun scripts/test-package.ts <package.tgz>');
}

const directory = await mkdtemp(join(tmpdir(), 'konstit-csv-parser-package-'));
try {
  await Bun.write(join(directory, 'package.json'), '{"private":true,"type":"module"}\n');
  run(['bun', 'add', resolve(tarball)], directory);
  await verifyInstalledPackage(directory);
  run([
    'bun',
    '-e',
    'import { csv } from \'@konstit/csv\'; const name = csv.column(1); const where = csv.all(csv.any(name.equals(\'Ada\'), name.equals(\'Bob\')), csv.not(name.startsWith(\'B\'))); const rows = await csv.parse(Buffer.from(\'id,name\\n1,Ada\\n2,Bob\\n\'), { where }); if (rows.length !== 1 || rows[0]?.[1] !== \'Ada\') throw new Error(\'package Boolean filter smoke test failed\');',
  ], directory);
  console.log('package import and filter smoke passed');

  const csvPath = join(directory, 'input.csv');
  await Bun.write(csvPath, 'id;name\n1;Ada\n2;Bob\n');
  run([
    'bun',
    '-e',
    `import assert from 'node:assert/strict';
     import * as pkg from '@konstit/csv';
     const { csv } = pkg;
     const path = 'input.csv';
     assert.equal('findCsvSafeSplitOffsets' in pkg, false);
     assert.equal('findCsvSafeShards' in pkg, false);
     assert.deepEqual(csv.findCsvSafeSplitOffsets(path, 2, { delimiter: ';' }), [0, 14, 20]);
     assert.deepEqual(csv.findCsvSafeShards(path, 2, { delimiter: ';' }), [{ start: 0, end: 13 }, { start: 14, end: 19 }]);`,
  ], directory);
  console.log('package byte-boundary helpers smoke passed');

  const cliResult = Bun.spawnSync({
    cmd: [
      'bunx',
      '@konstit/csv',
      'count',
      csvPath,
      '--chunk-size',
      '2',
      '--delimiter',
      ';',
      '--where-prefix',
      '1=A',
    ],
    cwd: directory,
    stderr: 'inherit',
    stdout: 'pipe',
  });
  if (!cliResult.success || cliResult.stdout.toString() !== '1\n') {
    throw new Error(`package CLI smoke test failed with exit code ${String(cliResult.exitCode)}`);
  }
  console.log('package CLI count smoke passed');

  const linesResult = Bun.spawnSync({
    cmd: [
      'bunx',
      '@konstit/csv',
      'lines',
      csvPath,
      '--delimiter',
      ';',
      '--columns',
      '0,1',
      '--where-prefix',
      '1=A',
      '--json',
      '--limit',
      '1',
    ],
    cwd: directory,
    stderr: 'inherit',
    stdout: 'pipe',
  });
  if (!linesResult.success || linesResult.stdout.toString() !== '["1","Ada"]\n') {
    throw new Error(`package CLI lines smoke test failed with exit code ${String(linesResult.exitCode)}`);
  }
  console.log('package CLI lines smoke passed');

  const completion = Bun.spawnSync({
    cmd: [join(directory, 'node_modules', '.bin', 'csv'), 'completion', 'bash'],
    cwd: directory,
    stderr: 'inherit',
    stdout: 'pipe',
  });
  if (!completion.success || !completion.stdout.toString().includes('shift_jis')) {
    throw new Error(`package CLI completion smoke test failed with exit code ${String(completion.exitCode)}`);
  }
  console.log('package CLI completion smoke passed');
} finally {
  await rm(directory, { recursive: true, force: true });
}

async function verifyInstalledPackage(directory: string): Promise<void> {
  const packageDirectory = join(directory, 'node_modules', '@konstit', 'csv');
  const manifest: unknown = await Bun.file(join(packageDirectory, 'package.json')).json();
  if (!isObject(manifest) || !isObject(manifest['bin']) || manifest['bin']['csv'] !== './dist/cli.js') {
    throw new Error('installed package does not expose the compiled CLI');
  }
  if (manifest['module'] !== './dist/index.js' || manifest['types'] !== './dist/index.d.ts') {
    throw new Error('installed package does not expose compiled JavaScript and declarations');
  }

  const files = await Array.fromAsync(new Glob('**/*').scan({ cwd: packageDirectory, onlyFiles: true }));
  const requiredFiles = [
    'dist/index.js',
    'dist/index.d.ts',
    'dist/cli.js',
    'prebuilds/manifest.json',
    ...packagedNativeTargets.map((target) => `prebuilds/${target}/${nativeLibraryFileName(target)}`),
  ];
  const missingFile = requiredFiles.find((file) => !files.includes(file));
  if (missingFile !== undefined) {
    throw new Error(`installed package is missing ${missingFile}`);
  }
  const runtimeTypeScriptFile = files.find((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'));
  if (runtimeTypeScriptFile !== undefined) {
    throw new Error(`installed package contains TypeScript runtime source: ${runtimeTypeScriptFile}`);
  }

  const cliInfo = await stat(join(packageDirectory, 'dist', 'cli.js'));
  if ((cliInfo.mode & 0o111) === 0) {
    throw new Error('installed package CLI is not executable');
  }

  await Bun.write(
    join(directory, 'typecheck.ts'),
    'import { csv, type CsvFilter } from \'@konstit/csv\';\nconst state = csv.column(1);\nconst filter: CsvFilter = csv.all(csv.any(state.equals(\'SP\'), state.equals(\'RJ\')), csv.not(state.equals(\'MG\')));\nvoid csv.count(\'input.csv\', { where: filter });\n',
  );
  await Bun.write(
    join(directory, 'tsconfig.json'),
    `${
      JSON.stringify(
        {
          compilerOptions: {
            module: 'Preserve',
            moduleResolution: 'Bundler',
            noEmit: true,
            strict: true,
            target: 'ESNext',
            typeRoots: [join(repoRoot, 'node_modules', '@types')],
            types: ['bun'],
          },
          files: ['typecheck.ts'],
        },
        null,
        2,
      )
    }\n`,
  );
  run([
    process.execPath,
    join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--project',
    join(directory, 'tsconfig.json'),
  ], directory);
  console.log('package files and declarations smoke passed');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function run(command: string[], cwd: string): void {
  const result = Bun.spawnSync({
    cmd: command,
    cwd,
    stderr: 'inherit',
    stdout: 'inherit',
  });
  if (!result.success) {
    throw new Error(`${command.join(' ')} failed with exit code ${String(result.exitCode)}`);
  }
}
