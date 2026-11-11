import { Glob } from 'bun';
import {
  chmod,
  mkdir,
  rm,
} from 'node:fs/promises';
import {
  dirname,
  join,
} from 'node:path';
import { repoRoot } from './native-target.ts';

const distDirectory = join(repoRoot, 'dist');
const sourceDirectory = join(repoRoot, 'src');
await rm(distDirectory, { force: true, recursive: true });

const buildResults = await Promise.allSettled([
  transpileJavaScript(),
  emitDeclarations(),
]);
const failures = buildResults.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
if (failures.length === 1) {
  throw failures[0]?.reason;
}
if (failures.length > 1) {
  throw new AggregateError(failures.map((failure) => failure.reason), 'package build failed');
}

await verifyPackageOutput();
await chmod(join(distDirectory, 'cli.js'), 0o755);

async function transpileJavaScript(): Promise<void> {
  const transpiler = new Bun.Transpiler({
    deadCodeElimination: false,
    loader: 'ts',
    target: 'bun',
    treeShaking: false,
    trimUnusedImports: false,
  });
  const sourceFiles = (await Array.fromAsync(new Glob('**/*.ts').scan({ cwd: sourceDirectory, onlyFiles: true })))
    .filter((file) => !file.endsWith('.d.ts'));
  for (const sourceFile of sourceFiles) {
    const source = await Bun.file(join(sourceDirectory, sourceFile)).text();
    const outputFile = join(distDirectory, sourceFile.replace(/\.ts$/, '.js'));
    const output = transpiler.transformSync(source);
    await mkdir(dirname(outputFile), { recursive: true });
    await Bun.write(outputFile, sourceFile === 'cli.ts' ? `#!/usr/bin/env bun\n${output}` : output);
  }
}

async function emitDeclarations(): Promise<void> {
  const compiler = Bun.spawn([
    'bunx',
    '--bun',
    'tsc',
    '--project',
    'tsconfig.build.json',
  ], {
    cwd: repoRoot,
    stderr: 'inherit',
    stdout: 'inherit',
  });
  const exitCode = await compiler.exited;
  if (exitCode !== 0) {
    throw new Error(`package declaration build failed with exit code ${String(exitCode)}`);
  }
}

async function verifyPackageOutput(): Promise<void> {
  const requiredFiles = [
    'index.js',
    'index.d.ts',
    'cli.js',
  ] as const;
  for (const file of requiredFiles) {
    if (!(await Bun.file(join(distDirectory, file)).exists())) {
      throw new Error(`package build did not emit dist/${file}`);
    }
  }

  const declarationFiles = new Glob('**/*.d.ts');
  for await (const file of declarationFiles.scan({ cwd: distDirectory, onlyFiles: true })) {
    const declaration = await Bun.file(join(distDirectory, file)).text();
    if (/(?:\bfrom\s+|\bimport\(\s*)['"]\.\.?\/[^'"]+\.ts['"]/.test(declaration)) {
      throw new Error(`package declaration contains a TypeScript runtime path: dist/${file}`);
    }
  }
}
