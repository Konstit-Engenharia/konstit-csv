// Runs the Bun test suite with coverage against the current host's newly built native library.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  currentNativeBuildDir,
  currentNativeTargetName,
  nativeLibraryFileName,
  repoRoot,
} from './native-target.ts';

const target = currentNativeTargetName();
const fileName = nativeLibraryFileName(target);
const buildDirectory = currentNativeBuildDir();
const libraryPath = [
  join(buildDirectory, fileName),
  join(buildDirectory, 'Release', fileName),
].find((candidate) => existsSync(candidate));

if (libraryPath === undefined) {
  throw new Error(`native library not found for ${target}; run bun run build:native first`);
}

const child = Bun.spawn([
  process.execPath,
  'test',
  '--dots',
  '--coverage',
], {
  cwd: repoRoot,
  env: {
    ...process.env,
    CSV_NATIVE_LIBRARY_PATH: libraryPath,
  },
  stderr: 'inherit',
  stdin: 'ignore',
  stdout: 'inherit',
});
const exitCode = await child.exited;
if (exitCode !== 0) {
  throw new Error(`Bun tests against ${target} build failed with exit code ${String(exitCode)}`);
}
