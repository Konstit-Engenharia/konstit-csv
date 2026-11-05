import {
  mkdir,
  mkdtemp,
  rename,
  rm,
} from 'node:fs/promises';
import { join } from 'node:path';
import { repoRoot } from './native-target.ts';

const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

await (import.meta.main ? main() : Promise.resolve());

export interface ReleaseOptions {
  readonly updatePrebuilds: boolean;
  readonly version: string;
}

export interface CommandOptions {
  readonly capture?: boolean;
  readonly label: string;
}

export type CommandRunner = (command: readonly string[], options: CommandOptions) => Promise<string>;

export interface ReleaseDependencies {
  readonly lookupPublishedVersion?: (name: string, version: string) => Promise<string | undefined>;
  readonly readPackageText?: () => Promise<string>;
  readonly run?: CommandRunner;
  readonly updatePrebuilds?: (run: CommandRunner) => Promise<void>;
  readonly writePackageText?: (text: string) => Promise<void>;
}

interface PackageMetadata {
  readonly name: string;
  readonly version: string;
}

interface ParsedVersion {
  readonly core: readonly [number, number, number];
  readonly prerelease: readonly string[];
}

export async function main(
  args: readonly string[] = Bun.argv.slice(2),
  dependencies: ReleaseDependencies = {},
): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  await release(parseArguments(args), dependencies);
}

export function parseArguments(args: readonly string[]): ReleaseOptions {
  let updatePrebuilds = false;
  let version: string | undefined;

  for (const argument of args) {
    if (argument === '--update-prebuilds') {
      updatePrebuilds = true;
      continue;
    }
    if (argument.startsWith('-')) {
      throw new Error(`unknown option: ${argument}\n${usage()}`);
    }
    if (version !== undefined) {
      throw new Error(`expected one version, received ${version} and ${argument}\n${usage()}`);
    }
    version = argument;
  }

  if (version === undefined) {
    throw new Error(`missing release version\n${usage()}`);
  }
  parseVersion(version);
  return { updatePrebuilds, version };
}

export async function release(options: ReleaseOptions, dependencies: ReleaseDependencies = {}): Promise<void> {
  const runCommand = dependencies.run ?? run;
  const readPackageText = dependencies.readPackageText ?? (() => Bun.file(join(repoRoot, 'package.json')).text());
  const writePackageText = dependencies.writePackageText ?? ((text: string) => Bun.write(join(repoRoot, 'package.json'), text));
  const lookupPublishedVersion = dependencies.lookupPublishedVersion ?? lookupNpmVersion;
  const updatePrebuilds = dependencies.updatePrebuilds ?? updateTrackedPrebuilds;

  const initialStatus = await capture(runCommand, ['git', 'status', '--porcelain=v1'], 'Check working tree');
  if (initialStatus.length !== 0) {
    throw new Error('working tree must be clean before a release');
  }

  const branch = await capture(runCommand, ['git', 'branch', '--show-current'], 'Check branch');
  if (branch !== 'main') {
    throw new Error(`release branch must be main, found ${branch || 'detached HEAD'}`);
  }

  await runCommand(['gh', 'auth', 'status'], { label: 'Check GitHub authentication' });
  await runCommand(['git', 'fetch', '--quiet', 'origin', 'main'], { label: 'Refresh origin/main' });
  const divergence = parseDivergence(
    await capture(runCommand, ['git', 'rev-list', '--left-right', '--count', 'origin/main...HEAD'], 'Compare main with origin'),
  );
  if (divergence.behind !== 0) {
    throw new Error(`local main is ${String(divergence.behind)} commit(s) behind origin/main`);
  }
  if (options.updatePrebuilds && divergence.ahead !== 0) {
    throw new Error('push the native source commit before using --update-prebuilds');
  }

  const initialPackageText = await readPackageText();
  const metadata = parsePackageMetadata(initialPackageText);
  assertVersionCanAdvance(metadata.version, options.version);
  const tag = `v${options.version}`;
  const publishedVersion = await lookupPublishedVersion(metadata.name, options.version);
  if (publishedVersion !== undefined) {
    throw new Error(`${metadata.name}@${publishedVersion} is already published`);
  }

  if (options.updatePrebuilds) {
    await updatePrebuilds(runCommand);
  }

  const versionChanged = metadata.version !== options.version;
  let releaseCommitCreated = false;
  if (versionChanged) {
    await writePackageText(updatePackageVersion(initialPackageText, metadata.version, options.version));
  }

  try {
    await runCommand([process.execPath, 'run', 'build:package'], { label: 'Build and verify package' });
    await runCommand([process.execPath, 'run', 'fmt:check'], { label: 'Check formatting' });
    await runCommand([process.execPath, 'run', 'lint'], { label: 'Check types and lint' });
    await runCommand([process.execPath, 'run', 'test'], { label: 'Run tests' });
    await assertExpectedReleaseChanges(runCommand, versionChanged);

    if (versionChanged) {
      await runCommand(['git', 'add', '--', 'package.json'], { label: 'Stage package version' });
      await runCommand(['git', 'commit', '-m', `Release ${options.version}`], { label: 'Commit release version' });
      releaseCommitCreated = true;
    }
  } catch (error) {
    if (versionChanged && !releaseCommitCreated) {
      await restorePackageFile(runCommand, writePackageText, initialPackageText);
    }
    throw error;
  }

  const headCommit = await capture(runCommand, ['git', 'rev-parse', 'HEAD'], 'Resolve release commit');
  await ensureReleaseTag(runCommand, tag, headCommit);
  await runCommand(['git', 'push', '--atomic', 'origin', 'HEAD:refs/heads/main', `refs/tags/${tag}`], {
    label: `Push main and ${tag}`,
  });

  const workflowOutput = await capture(
    runCommand,
    ['gh', 'workflow', 'run', 'package.yml', '--ref', 'main', '-f', `release_tag=${tag}`],
    'Start Package workflow',
  );
  const runId = parseWorkflowRunId(workflowOutput);
  await runCommand(['gh', 'run', 'watch', runId, '--exit-status'], { label: `Wait for Package run ${runId}` });
  await verifyRelease(runCommand, metadata.name, options.version, tag, lookupPublishedVersion);
}

export function updatePackageVersion(text: string, currentVersion: string, targetVersion: string): string {
  const marker = `"version": ${JSON.stringify(currentVersion)}`;
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0 || text.indexOf(marker, markerIndex + marker.length) >= 0) {
    throw new Error('package.json must contain one formatted top-level version field');
  }
  return `${text.slice(0, markerIndex)}"version": ${JSON.stringify(targetVersion)}${text.slice(markerIndex + marker.length)}`;
}

export function parseWorkflowRunId(output: string): string {
  const match = /\/actions\/runs\/(\d+)/u.exec(output);
  if (match?.[1] === undefined) {
    throw new Error(`could not read workflow run ID from: ${output.trim() || '(empty output)'}`);
  }
  return match[1];
}

export function compareVersions(left: string, right: string): number {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);
  for (let index = 0; index < parsedLeft.core.length; ++index) {
    const leftPart = parsedLeft.core[index];
    const rightPart = parsedRight.core[index];
    if (leftPart === undefined || rightPart === undefined || leftPart === rightPart) {
      continue;
    }
    return leftPart < rightPart ? -1 : 1;
  }
  return comparePrerelease(parsedLeft.prerelease, parsedRight.prerelease);
}

export async function run(command: readonly string[], options: CommandOptions): Promise<string> {
  console.log(`\n${options.label}`);
  const child = Bun.spawn([...command], {
    cwd: repoRoot,
    stderr: 'inherit',
    stdin: 'inherit',
    stdout: options.capture === true ? 'pipe' : 'inherit',
  });
  const stdoutPromise = options.capture === true ? new Response(child.stdout).text() : Promise.resolve('');
  const [exitCode, stdout,] = await Promise.all([child.exited, stdoutPromise]);
  if (exitCode !== 0) {
    throw new Error(`${options.label} failed with exit code ${String(exitCode)}`);
  }
  return stdout.trimEnd();
}

async function updateTrackedPrebuilds(runCommand: CommandRunner): Promise<void> {
  const sourceCommit = await capture(runCommand, ['git', 'rev-parse', 'HEAD'], 'Resolve native source commit');
  const workflowOutput = await capture(
    runCommand,
    ['gh', 'workflow', 'run', 'update-prebuilds.yml', '--ref', 'main'],
    'Start Update prebuilds workflow',
  );
  const runId = parseWorkflowRunId(workflowOutput);
  await runCommand(['gh', 'run', 'watch', runId, '--exit-status'], { label: `Wait for Update prebuilds run ${runId}` });

  const runMetadata = parseJsonRecord(
    await capture(runCommand, ['gh', 'run', 'view', runId, '--json', 'headSha'], 'Verify prebuild source commit'),
    'workflow metadata',
  );
  if (runMetadata['headSha'] !== sourceCommit) {
    throw new Error(`prebuild workflow used ${String(runMetadata['headSha'])}, expected ${sourceCommit}`);
  }

  const temporaryDirectory = await mkdtemp(join(repoRoot, '.release-prebuilds-'));
  try {
    const downloadDirectory = join(temporaryDirectory, 'download');
    const extractionDirectory = join(temporaryDirectory, 'extracted');
    await mkdir(downloadDirectory);
    await mkdir(extractionDirectory);
    const artifactName = `tracked-prebuilds-${sourceCommit}`;
    await runCommand(['gh', 'run', 'download', runId, '--name', artifactName, '--dir', downloadDirectory], {
      label: 'Download tracked prebuilds',
    });
    const archivePath = join(downloadDirectory, `${artifactName}.tgz`);
    if (!(await Bun.file(archivePath).exists())) {
      throw new Error(`prebuild artifact is missing ${archivePath}`);
    }
    await runCommand(['tar', '-xzf', archivePath, '-C', extractionDirectory], { label: 'Extract tracked prebuilds' });
    await installAndVerifyPrebuilds(runCommand, temporaryDirectory, join(extractionDirectory, 'prebuilds'));
  } finally {
    await removeTemporaryDirectory(temporaryDirectory);
  }

  const prebuildChanges = await capture(
    runCommand,
    ['git', 'status', '--porcelain=v1', '--', 'prebuilds'],
    'Check tracked prebuild changes',
  );
  if (prebuildChanges.length === 0) {
    throw new Error('Update prebuilds produced no tracked changes');
  }
  await runCommand(['git', 'add', '--', 'prebuilds'], { label: 'Stage tracked prebuilds' });
  await runCommand(['git', 'commit', '-m', `Update native prebuilds for ${sourceCommit.slice(0, 12)}`], {
    label: 'Commit tracked prebuilds',
  });
}

async function installAndVerifyPrebuilds(
  runCommand: CommandRunner,
  temporaryDirectory: string,
  candidateDirectory: string,
): Promise<void> {
  if (!(await Bun.file(join(candidateDirectory, 'manifest.json')).exists())) {
    throw new Error('downloaded prebuild artifact has no manifest.json');
  }

  const currentDirectory = join(repoRoot, 'prebuilds');
  const backupDirectory = join(temporaryDirectory, 'previous-prebuilds');
  let candidateInstalled = false;
  await rename(currentDirectory, backupDirectory);
  try {
    await rename(candidateDirectory, currentDirectory);
    candidateInstalled = true;
    await runCommand([process.execPath, 'run', 'verify:native-package'], { label: 'Verify downloaded prebuilds' });
    await runCommand([process.execPath, 'scripts/verify-native-package.ts', '--verify-attestations'], {
      label: 'Verify downloaded native attestations',
    });
    await rm(backupDirectory, { force: true, recursive: true });
  } catch (error) {
    try {
      if (candidateInstalled) {
        await rm(currentDirectory, { force: true, recursive: true });
      }
      await rename(backupDirectory, currentDirectory);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'prebuild verification failed and rollback was incomplete');
    }
    throw new Error('downloaded prebuild verification failed; restored previous prebuilds', { cause: error });
  }
}

async function assertExpectedReleaseChanges(runCommand: CommandRunner, versionChanged: boolean): Promise<void> {
  const status = await capture(runCommand, ['git', 'status', '--porcelain=v1'], 'Check validation output');
  const expected = versionChanged ? ' M package.json' : '';
  if (status !== expected) {
    throw new Error(`validation changed unexpected files:\n${status || '(package.json version change is missing)'}`);
  }
}

async function ensureReleaseTag(runCommand: CommandRunner, tag: string, headCommit: string): Promise<void> {
  const localTag = await capture(runCommand, ['git', 'tag', '--list', tag], `Check local tag ${tag}`);
  if (localTag.length === 0) {
    const remoteTag = await capture(
      runCommand,
      ['git', 'ls-remote', '--tags', 'origin', `refs/tags/${tag}`],
      `Check remote tag ${tag}`,
    );
    if (remoteTag.length === 0) {
      await runCommand(['git', 'tag', '-a', tag, '-m', tag], { label: `Create tag ${tag}` });
    } else {
      await runCommand(['git', 'fetch', 'origin', `refs/tags/${tag}:refs/tags/${tag}`], { label: `Fetch tag ${tag}` });
    }
  }

  const tagCommit = await capture(runCommand, ['git', 'rev-list', '-n', '1', tag], `Verify tag ${tag}`);
  if (tagCommit !== headCommit) {
    throw new Error(`${tag} identifies ${tagCommit}, but the release commit is ${headCommit}`);
  }
}

async function verifyRelease(
  runCommand: CommandRunner,
  packageName: string,
  version: string,
  tag: string,
  lookupPublishedVersion: (name: string, version: string) => Promise<string | undefined>,
): Promise<void> {
  await runCommand(['gh', 'release', 'verify', tag], { label: `Verify immutable release ${tag}` });
  const releaseMetadata = parseJsonRecord(
    await capture(
      runCommand,
      ['gh', 'release', 'view', tag, '--json', 'isDraft,isImmutable,url,assets'],
      `Inspect release ${tag}`,
    ),
    'release metadata',
  );
  if (releaseMetadata['isDraft'] !== false || releaseMetadata['isImmutable'] !== true) {
    throw new Error(`${tag} is not a published immutable release`);
  }
  const assetName = `konstit-csv-${tag}.tgz`;
  const assets = releaseMetadata['assets'];
  if (!Array.isArray(assets) || !assets.some((asset) => isRecord(asset) && asset['name'] === assetName)) {
    throw new Error(`${tag} is missing ${assetName}`);
  }
  const publishedVersion = await lookupPublishedVersion(packageName, version);
  if (publishedVersion !== version) {
    throw new Error(`${packageName}@${version} is not available from npm`);
  }
  console.log(`\nReleased ${packageName}@${version}: ${String(releaseMetadata['url'])}`);
}

async function restorePackageFile(
  runCommand: CommandRunner,
  writePackageText: (text: string) => Promise<unknown>,
  initialPackageText: string,
): Promise<void> {
  try {
    await runCommand(['git', 'reset', '--quiet', '--', 'package.json'], { label: 'Unstage failed release version' });
  } catch (cleanupError) {
    console.warn('Could not reset package.json after the failed release:', cleanupError);
  }
  await writePackageText(initialPackageText);
}

async function removeTemporaryDirectory(path: string): Promise<void> {
  try {
    await rm(path, { force: true, recursive: true });
  } catch (error) {
    console.warn(`Could not remove temporary release directory ${path}:`, error);
  }
}

async function capture(runCommand: CommandRunner, command: readonly string[], label: string): Promise<string> {
  return await runCommand(command, { capture: true, label });
}

async function lookupNpmVersion(packageName: string, version: string): Promise<string | undefined> {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`npm registry returned HTTP ${String(response.status)} ${response.statusText}`);
  }
  const metadata: unknown = await response.json();
  if (!isRecord(metadata) || typeof metadata['version'] !== 'string') {
    throw new Error('npm registry returned invalid package metadata');
  }
  return metadata['version'];
}

function parsePackageMetadata(text: string): PackageMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error('package.json is not valid JSON', { cause: error });
  }
  if (!isRecord(parsed) || typeof parsed['name'] !== 'string' || typeof parsed['version'] !== 'string') {
    throw new Error('package.json must contain string name and version fields');
  }
  parseVersion(parsed['version']);
  return { name: parsed['name'], version: parsed['version'] };
}

function assertVersionCanAdvance(currentVersion: string, targetVersion: string): void {
  const comparison = compareVersions(targetVersion, currentVersion);
  if (comparison < 0) {
    throw new Error(`release version ${targetVersion} is older than package version ${currentVersion}`);
  }
}

function parseVersion(version: string): ParsedVersion {
  const match = stableVersionPattern.exec(version);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
    throw new Error(`invalid release version: ${version}`);
  }
  const prerelease = match[4]?.split('.') ?? [];
  const invalidNumericIdentifier = prerelease.find((identifier) =>
    /^\d+$/u.test(identifier) && identifier.length > 1 && identifier[0] === '0'
  );
  if (invalidNumericIdentifier !== undefined) {
    throw new Error(`invalid release version: ${version}`);
  }
  const core = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  if (core.some((part) => !Number.isSafeInteger(part))) {
    throw new Error(`invalid release version: ${version}`);
  }
  return { core, prerelease };
}

function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) {
    return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; ++index) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) {
      continue;
    }
    const leftNumeric = /^\d+$/u.test(leftPart);
    const rightNumeric = /^\d+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) {
      if (leftPart.length !== rightPart.length) {
        return leftPart.length < rightPart.length ? -1 : 1;
      }
      return leftPart < rightPart ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function parseDivergence(output: string): { readonly ahead: number; readonly behind: number; } {
  const match = /^(\d+)\s+(\d+)$/u.exec(output);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`could not parse git divergence: ${output}`);
  }
  return { ahead: Number(match[2]), behind: Number(match[1]) };
}

function parseJsonRecord(text: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new Error(`${label} must be an object`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function printUsage(): void {
  console.log(usage());
}

function usage(): string {
  return 'usage: bun run release <version> [--update-prebuilds]';
}
