// Verifies that tracked native libraries match their recorded source inputs and package metadata.
import { Glob } from 'bun';
import {
  lstat,
  readdir,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
  nativeLibraryFileName,
  packagedNativeTargets,
  repoRoot,
} from './native-target.ts';

const manifestSchemaVersion = 1;
const manifestRelativePath = 'prebuilds/manifest.json';
const provenanceDirectory = 'prebuilds/provenance';
const ignoredInventoryEntries = new Set(['.DS_Store']);
const ignoredSourceInputs = new Set([
  'native/mitata.hpp',
  'native/native_bench.cpp',
  'native/native_csv_cxx_test.cpp',
  'native/native_csv_fuzz.cpp',
]);
const requiredSourceInputs = [
  '.github/workflows/update-prebuilds.yml',
  'CMakeLists.txt',
  'CMakePresets.json',
  'scripts/build-linux-native.ts',
  'scripts/native-build-predicate.ts',
  'scripts/native-target.ts',
  'scripts/stage-native.ts',
] as const;
const sourceInputGlobs = [
  'docker/**/*',
  'native/**/*',
  'scripts/build-native*.ts',
  'toolchains/**/*',
] as const;
const requiredNativeSymbols = [
  'csv_zip_reader_enable_read_ahead',
  'csv_runtime_supports_avx2',
  'csv_parser_write_projected_batch_where_all',
  'csv_parser_finish_projected_batch_where_all',
  'csv_parser_write_count_where_all',
  'csv_parser_finish_count_where_all',
  'csv_parser_prepare',
  'csv_parser_write_prepared_batch',
  'csv_parser_write_prepared_count',
  'csv_parser_create_latin1_rows',
  'csv_parser_create_latin1_rows_with_quoted_spans',
  'csv_parser_create_latin1_quoted_rows',
  'csv_batch_quoted_rows_ptr',
  'csv_parser_create_latin1_rows_with_fixed_columns',
] as const;

interface NativeManifestSource {
  commit?: string;
  files: string[];
  sha256: string;
}

interface NativeManifestTarget {
  attestation?: string;
  file: string;
  sha256: string;
  size: number;
  target: string;
}

export interface NativePackageManifest {
  schemaVersion: number;
  source: NativeManifestSource;
  targets: NativeManifestTarget[];
}

export async function createNativePackageManifest(root: string = repoRoot): Promise<NativePackageManifest> {
  const hasAttestations = await verifyPrebuildInventory(root, false);
  const sourceFiles = await collectNativeSourceInputs(root);
  const targets: NativeManifestTarget[] = [];

  for (const target of packagedNativeTargets) {
    const file = `${target}/${nativeLibraryFileName(target)}`;
    const path = join(root, 'prebuilds', file);
    const bytes = await readRegularFile(path, `prebuilds/${file}`);
    if (bytes.byteLength < 32) {
      throw new Error(`prebuilds/${file} is too small to be a native library`);
    }
    verifyBinaryFormat(bytes, target);
    const entry: NativeManifestTarget = {
      file,
      sha256: sha256(bytes),
      size: bytes.byteLength,
      target,
    };
    if (hasAttestations) {
      entry.attestation = `provenance/${target}.json`;
    }
    targets.push(entry);
  }

  const sourceCommit = process.env['CSV_NATIVE_SOURCE_COMMIT'];
  if (hasAttestations && sourceCommit === undefined) {
    throw new Error('CSV_NATIVE_SOURCE_COMMIT is required when updating a manifest with build attestations');
  }

  return {
    schemaVersion: manifestSchemaVersion,
    source: {
      ...(sourceCommit === undefined ? {} : { commit: requireGitCommit(sourceCommit, 'source commit') }),
      files: sourceFiles,
      sha256: await digestSourceInputs(root, sourceFiles),
    },
    targets,
  };
}

export async function verifyNativePackage(root: string = repoRoot): Promise<void> {
  const hasAttestations = await verifyPrebuildInventory(root, true);
  const manifest = await readManifest(root);

  const expectedSourceFiles = await collectNativeSourceInputs(root);
  if (!arraysEqual(manifest.source.files, expectedSourceFiles)) {
    const detail = describeInventoryDifference(expectedSourceFiles, manifest.source.files);
    throw new Error(
      `native source input inventory changed${detail}; rebuild and stage all native targets, then update ${manifestRelativePath}`,
    );
  }

  const sourceDigest = await digestSourceInputs(root, expectedSourceFiles);
  if (manifest.source.sha256 !== sourceDigest) {
    throw new Error(
      `native source inputs do not match ${manifestRelativePath}: expected ${manifest.source.sha256}, got ${sourceDigest}; rebuild and stage all native targets, then update the manifest`,
    );
  }

  verifyManifestTargetInventory(manifest.targets);
  const attestationCount = manifest.targets.filter((entry) => entry.attestation !== undefined).length;
  if (attestationCount !== 0 && attestationCount !== manifest.targets.length) {
    throw new Error(`invalid ${manifestRelativePath}: build attestations must be recorded for every target`);
  }
  const manifestHasAttestations = attestationCount === manifest.targets.length;
  if (manifestHasAttestations !== hasAttestations) {
    throw new Error(`${manifestRelativePath} attestation inventory does not match ${provenanceDirectory}`);
  }
  if (manifestHasAttestations && manifest.source.commit === undefined) {
    throw new Error(`invalid ${manifestRelativePath}: source.commit is required with build attestations`);
  }
  for (const entry of manifest.targets) {
    const relativePath = `prebuilds/${entry.file}`;
    const bytes = await readRegularFile(join(root, relativePath), relativePath);
    if (bytes.byteLength !== entry.size) {
      throw new Error(
        `${relativePath} size does not match ${manifestRelativePath}: expected ${String(entry.size)}, got ${String(bytes.byteLength)}`,
      );
    }
    const digest = sha256(bytes);
    if (digest !== entry.sha256) {
      throw new Error(`${relativePath} SHA-256 does not match ${manifestRelativePath}: expected ${entry.sha256}, got ${digest}`);
    }
    verifyBinaryFormat(bytes, entry.target);
    if (entry.attestation !== undefined) {
      const expectedAttestation = `provenance/${entry.target}.json`;
      if (entry.attestation !== expectedAttestation) {
        throw new Error(
          `${manifestRelativePath} records the wrong attestation for ${entry.target}: expected ${expectedAttestation}, got ${entry.attestation}`,
        );
      }
      await readRegularFile(join(root, 'prebuilds', entry.attestation), `prebuilds/${entry.attestation}`);
    }
    console.log(`${entry.target}: ${String(entry.size)} bytes, sha256 ${entry.sha256}`);
  }

  console.log(`native source inputs: sha256 ${manifest.source.sha256}`);
}

export async function verifyNativeAttestations(
  root: string = repoRoot,
  repository: string | undefined = process.env['GITHUB_REPOSITORY'],
): Promise<void> {
  await verifyNativePackage(root);
  const manifest = await readManifest(root);
  if (repository === undefined || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('GITHUB_REPOSITORY must identify the expected owner and repository');
  }
  const sourceCommit = manifest.source.commit;
  if (sourceCommit === undefined || manifest.targets.some((entry) => entry.attestation === undefined)) {
    throw new Error('tracked prebuild attestations are required before publication; run the Update prebuilds workflow');
  }
  requireMatchingSourceCommit(root, sourceCommit, manifest.source.files);

  for (const entry of manifest.targets) {
    const attestation = entry.attestation;
    if (attestation === undefined) {
      throw new Error(`missing build attestation for ${entry.target}`);
    }
    const command = [
      'gh',
      'attestation',
      'verify',
      join(root, 'prebuilds', entry.file),
      '--bundle',
      join(root, 'prebuilds', attestation),
      '--repo',
      repository,
      '--signer-workflow',
      `${repository}/.github/workflows/update-prebuilds.yml`,
      '--source-digest',
      sourceCommit,
      '--predicate-type',
      'https://konstit.com/attestations/native-build/v1',
      '--deny-self-hosted-runners',
    ];
    const result = Bun.spawnSync({ cmd: command, cwd: root, stderr: 'inherit', stdout: 'inherit' });
    if (!result.success) {
      throw new Error(`build attestation verification failed for ${entry.target} with exit code ${String(result.exitCode)}`);
    }
  }
}

export async function writeNativePackageManifest(root: string = repoRoot): Promise<void> {
  const manifest = await createNativePackageManifest(root);
  await Bun.write(join(root, manifestRelativePath), `${JSON.stringify(manifest, null, 2)}\n`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    await verifyNativePackage();
  } else if (args.length === 1 && args[0] === '--update-manifest') {
    await writeNativePackageManifest();
    await verifyNativePackage();
    console.log(`updated ${manifestRelativePath}`);
  } else if (args.length === 1 && args[0] === '--verify-attestations') {
    await verifyNativeAttestations();
  } else {
    throw new Error('usage: bun scripts/verify-native-package.ts [--update-manifest|--verify-attestations]');
  }
}

async function readManifest(root: string): Promise<NativePackageManifest> {
  const path = join(root, manifestRelativePath);
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(
      `missing ${manifestRelativePath}; rebuild and stage all native targets, then run bun scripts/verify-native-package.ts --update-manifest`,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(await file.text());
  } catch (error) {
    throw new Error(`${manifestRelativePath} is not valid JSON`, { cause: error });
  }
  return parseManifest(value);
}

function parseManifest(value: unknown): NativePackageManifest {
  if (!isRecord(value)) {
    throw invalidManifest('root must be an object');
  }
  if (value['schemaVersion'] !== manifestSchemaVersion) {
    throw invalidManifest(`schemaVersion must be ${String(manifestSchemaVersion)}`);
  }

  const source = value['source'];
  if (!isRecord(source)) {
    throw invalidManifest('source must be an object');
  }
  const sourceFiles = source['files'];
  if (!Array.isArray(sourceFiles) || !sourceFiles.every((file) => typeof file === 'string')) {
    throw invalidManifest('source.files must be an array of paths');
  }
  const sourceSha256 = requireSha256(source['sha256'], 'source.sha256');
  const sourceCommitValue = source['commit'];
  const sourceCommit = sourceCommitValue === undefined ? undefined : requireGitCommit(sourceCommitValue, 'source.commit');

  const targetValues = value['targets'];
  if (!Array.isArray(targetValues)) {
    throw invalidManifest('targets must be an array');
  }
  const targets = targetValues.map((targetValue, index): NativeManifestTarget => {
    if (!isRecord(targetValue)) {
      throw invalidManifest(`targets[${String(index)}] must be an object`);
    }
    const target = requireString(targetValue['target'], `targets[${String(index)}].target`);
    const file = requireString(targetValue['file'], `targets[${String(index)}].file`);
    const size = targetValue['size'];
    if (!Number.isSafeInteger(size) || Number(size) <= 0) {
      throw invalidManifest(`targets[${String(index)}].size must be a positive safe integer`);
    }
    return {
      ...(targetValue['attestation'] === undefined
        ? {}
        : { attestation: requireString(targetValue['attestation'], `targets[${String(index)}].attestation`) }),
      file,
      sha256: requireSha256(targetValue['sha256'], `targets[${String(index)}].sha256`),
      size: Number(size),
      target,
    };
  });

  return {
    schemaVersion: manifestSchemaVersion,
    source: {
      ...(sourceCommit === undefined ? {} : { commit: sourceCommit }),
      files: [...sourceFiles],
      sha256: sourceSha256,
    },
    targets,
  };
}

function verifyManifestTargetInventory(targets: readonly NativeManifestTarget[]): void {
  const expectedTargets = [...packagedNativeTargets];
  const actualTargets = targets.map((entry) => entry.target);
  if (!arraysEqual(actualTargets, expectedTargets)) {
    const detail = describeInventoryDifference(expectedTargets, actualTargets);
    throw new Error(`${manifestRelativePath} target inventory does not match the package${detail}`);
  }

  for (const entry of targets) {
    const expectedFile = `${entry.target}/${nativeLibraryFileName(entry.target)}`;
    if (entry.file !== expectedFile) {
      throw new Error(`${manifestRelativePath} records the wrong file for ${entry.target}: expected ${expectedFile}, got ${entry.file}`);
    }
  }
}

async function verifyPrebuildInventory(root: string, requireManifest: boolean): Promise<boolean> {
  const prebuildsDirectory = join(root, 'prebuilds');
  const entries = await readdir(prebuildsDirectory, { withFileTypes: true }).catch((error: unknown) => {
    throw new Error('cannot read prebuilds directory', { cause: error });
  });
  const inventoryEntries = entries.filter((entry) => !ignoredInventoryEntries.has(entry.name));
  const hasAttestations = inventoryEntries.some((entry) => entry.name === 'provenance');
  const expectedNames = [
    ...packagedNativeTargets,
    ...(requireManifest ? ['manifest.json'] : []),
    ...(hasAttestations ? ['provenance'] : []),
  ].sort((left, right) => left.localeCompare(right));
  const actualNames = inventoryEntries
    .map((entry) => entry.name)
    .filter((name) => requireManifest || name !== 'manifest.json')
    .sort((left, right) => left.localeCompare(right));
  if (!arraysEqual(actualNames, expectedNames)) {
    const detail = describeInventoryDifference(expectedNames, actualNames);
    throw new Error(`prebuilds inventory does not match packaged native targets${detail}`);
  }

  for (const target of packagedNativeTargets) {
    const targetEntry = inventoryEntries.find((entry) => entry.name === target);
    if (targetEntry === undefined || !targetEntry.isDirectory()) {
      throw new Error(`prebuilds/${target} must be a directory, not a file or symbolic link`);
    }
    const fileName = nativeLibraryFileName(target);
    const targetEntries = (await readdir(join(prebuildsDirectory, target), { withFileTypes: true }))
      .filter((entry) => !ignoredInventoryEntries.has(entry.name));
    if (targetEntries.length !== 1 || targetEntries[0]?.name !== fileName || !targetEntries[0].isFile()) {
      const actualFiles = targetEntries.map((entry) => entry.name).sort((left, right) => left.localeCompare(right));
      throw new Error(`prebuilds/${target} must contain only ${fileName}; found: ${actualFiles.join(', ') || '(empty)'}`);
    }
  }

  if (requireManifest) {
    const manifestEntry = inventoryEntries.find((entry) => entry.name === 'manifest.json');
    if (manifestEntry === undefined || !manifestEntry.isFile()) {
      throw new Error(`${manifestRelativePath} must be a regular file, not a directory or symbolic link`);
    }
  }

  if (hasAttestations) {
    const provenanceEntry = inventoryEntries.find((entry) => entry.name === 'provenance');
    if (provenanceEntry === undefined || !provenanceEntry.isDirectory()) {
      throw new Error(`${provenanceDirectory} must be a directory, not a file or symbolic link`);
    }
    const attestationEntries = (await readdir(join(root, provenanceDirectory), { withFileTypes: true }))
      .filter((entry) => !ignoredInventoryEntries.has(entry.name));
    const expectedAttestations = packagedNativeTargets.map((target) => `${target}.json`).sort((left, right) => left.localeCompare(right));
    const actualAttestations = attestationEntries.map((entry) => entry.name).sort((left, right) => left.localeCompare(right));
    if (!arraysEqual(actualAttestations, expectedAttestations) || attestationEntries.some((entry) => !entry.isFile())) {
      const detail = describeInventoryDifference(expectedAttestations, actualAttestations);
      throw new Error(`${provenanceDirectory} inventory does not match packaged native targets${detail}`);
    }
  }

  return hasAttestations;
}

export async function collectNativeSourceInputs(root: string = repoRoot): Promise<string[]> {
  const inputs = new Set<string>();
  for (const relativePath of requiredSourceInputs) {
    await requireRegularSourceInput(root, relativePath);
    inputs.add(relativePath);
  }

  for (const pattern of sourceInputGlobs) {
    const matches = Array.from(new Glob(pattern).scanSync({ cwd: root, onlyFiles: true }))
      .filter((relativePath) =>
        !ignoredSourceInputs.has(relativePath) && !relativePath.endsWith('/.DS_Store') && relativePath !== '.DS_Store'
      );
    if (matches.length === 0) {
      throw new Error(`native source input pattern has no files: ${pattern}`);
    }
    for (const relativePath of matches) {
      await requireRegularSourceInput(root, relativePath);
      inputs.add(relativePath);
    }
  }

  return [...inputs].sort((left, right) => left.localeCompare(right));
}

async function requireRegularSourceInput(root: string, relativePath: string): Promise<void> {
  const info = await lstat(join(root, relativePath)).catch(() => undefined);
  if (info === undefined || !info.isFile()) {
    throw new Error(`native source input must be a regular file: ${relativePath}`);
  }
}

async function digestSourceInputs(root: string, files: readonly string[]): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  for (const relativePath of files) {
    const bytes = await readRegularFile(join(root, relativePath), relativePath);
    hasher.update(`${relativePath}\0${String(bytes.byteLength)}\0`);
    hasher.update(bytes);
    hasher.update('\0');
  }
  return hasher.digest('hex');
}

async function readRegularFile(path: string, displayPath: string): Promise<Uint8Array> {
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined || !info.isFile()) {
    throw new Error(`missing regular file: ${displayPath}`);
  }
  return new Uint8Array(await Bun.file(path).arrayBuffer());
}

function sha256(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(bytes);
  return hasher.digest('hex');
}

function verifyBinaryFormat(bytes: Uint8Array, target: string): void {
  const isElf = bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46;
  const isMachO = bytes[0] === 0xcf && bytes[1] === 0xfa && bytes[2] === 0xed && bytes[3] === 0xfe;
  if (target.startsWith('linux-') && !isElf) {
    throw new Error(`${target} library is not an ELF binary`);
  }
  if (target.startsWith('darwin-') && !isMachO) {
    throw new Error(`${target} library is not a Mach-O binary`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (target === 'linux-x64' && view.getUint16(18, true) !== 0x3e) {
    throw new Error(`${target} library does not contain x64 machine code`);
  }
  if (target === 'darwin-x64' && view.getUint32(4, true) !== 0x01000007) {
    throw new Error(`${target} library does not contain x64 machine code`);
  }
  if (target === 'darwin-arm64' && view.getUint32(4, true) !== 0x0100000c) {
    throw new Error(`${target} library does not contain ARM64 machine code`);
  }
  verifyRequiredSymbols(bytes, target);
  if (target.startsWith('darwin-')) {
    verifyMacOsDeploymentTarget(view, target);
  }
}

function verifyRequiredSymbols(bytes: Uint8Array, target: string): void {
  const encoder = new TextEncoder();
  for (const symbol of requiredNativeSymbols) {
    const encoded = encoder.encode(symbol);
    if (!containsBytes(bytes, encoded)) {
      throw new Error(`${target} library does not export required symbol: ${symbol}`);
    }
  }
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  const finalStart = haystack.length - needle.length;
  for (let start = 0; start <= finalStart; ++start) {
    let index = 0;
    while (index < needle.length && haystack[start + index] === needle[index]) {
      ++index;
    }
    if (index === needle.length) {
      return true;
    }
  }
  return false;
}

function verifyMacOsDeploymentTarget(view: DataView, target: string): void {
  const loadCommandCount = view.getUint32(16, true);
  let offset = 32;
  for (let index = 0; index < loadCommandCount; ++index) {
    const command = view.getUint32(offset, true);
    const commandSize = view.getUint32(offset + 4, true);
    if (commandSize < 8 || offset + commandSize > view.byteLength) {
      throw new Error(`${target} contains an invalid Mach-O load command`);
    }
    if (command === 0x32) {
      const minimumVersion = view.getUint32(offset + 12, true);
      if (minimumVersion > 0x000d0000) {
        throw new Error(`${target} requires macOS newer than 13.0`);
      }
      return;
    }
    offset += commandSize;
  }
  throw new Error(`${target} does not declare a macOS deployment target`);
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidManifest(`${path} must be a non-empty string`);
  }
  return value;
}

function requireSha256(value: unknown, path: string): string {
  const digest = requireString(value, path);
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw invalidManifest(`${path} must be a lowercase SHA-256 digest`);
  }
  return digest;
}

function requireGitCommit(value: unknown, path: string): string {
  const commit = requireString(value, path);
  if (!/^[0-9a-f]{40,64}$/.test(commit)) {
    throw invalidManifest(`${path} must be a full lowercase Git object ID`);
  }
  return commit;
}

function requireMatchingSourceCommit(root: string, sourceCommit: string, sourceFiles: readonly string[]): void {
  const commit = Bun.spawnSync({
    cmd: ['git', 'cat-file', '-e', `${sourceCommit}^{commit}`],
    cwd: root,
    stderr: 'inherit',
    stdout: 'ignore',
  });
  if (!commit.success) {
    throw new Error(`attested native source commit is unavailable: ${sourceCommit}`);
  }

  const difference = Bun.spawnSync({
    cmd: [
      'git',
      'diff',
      '--quiet',
      sourceCommit,
      'HEAD',
      '--',
      ...sourceFiles,
    ],
    cwd: root,
    stderr: 'inherit',
    stdout: 'ignore',
  });
  if (!difference.success) {
    throw new Error(`native source inputs differ from attested commit ${sourceCommit}; run the Update prebuilds workflow`);
  }
}

function invalidManifest(detail: string): Error {
  return new Error(`invalid ${manifestRelativePath}: ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function describeInventoryDifference(expected: readonly string[], actual: readonly string[]): string {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((value) => !actualSet.has(value));
  const unexpected = actual.filter((value) => !expectedSet.has(value));
  const details: string[] = [];
  if (missing.length > 0) {
    details.push(`missing: ${missing.join(', ')}`);
  }
  if (unexpected.length > 0) {
    details.push(`unexpected: ${unexpected.join(', ')}`);
  }
  return details.length === 0 ? `; expected order: ${expected.join(', ')}` : `; ${details.join('; ')}`;
}
