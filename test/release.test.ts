import {
  describe,
  expect,
  test,
} from 'bun:test';
import {
  type CommandRunner,
  compareVersions,
  parseArguments,
  parseWorkflowRunId,
  release,
  run,
  updatePackageVersion,
} from '../scripts/release.ts';

async function rejectedError(operation: Promise<unknown>): Promise<Error> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof Error)) {
    throw new Error('expected operation to reject');
  }
  return caught;
}

describe('release automation', () => {
  test('parses normal and native release modes', () => {
    expect(parseArguments(['0.4.2'])).toEqual({ updatePrebuilds: false, version: '0.4.2' });
    expect(parseArguments(['--update-prebuilds', '0.5.0'])).toEqual({ updatePrebuilds: true, version: '0.5.0' });
    expect(parseArguments(['0.5.0', '--update-prebuilds'])).toEqual({ updatePrebuilds: true, version: '0.5.0' });
  });

  test('rejects missing, duplicate, and invalid versions', () => {
    expect(() => parseArguments([])).toThrow('missing release version');
    expect(() => parseArguments(['0.4.2', '0.4.3'])).toThrow('expected one version');
    expect(() => parseArguments(['v0.4.2'])).toThrow('invalid release version');
    expect(() => parseArguments(['0.04.2'])).toThrow('invalid release version');
    expect(() => parseArguments(['0.4.2+local'])).toThrow('invalid release version');
    expect(() => parseArguments(['999999999999999999999.4.2'])).toThrow('invalid release version');
    expect(() => parseArguments(['0.4.2', '--unknown'])).toThrow('unknown option');
  });

  test('validates versions through the CLI entry point', () => {
    const result = Bun.spawnSync([process.execPath, 'scripts/release.ts', 'invalid'], {
      stderr: 'pipe',
      stdout: 'pipe',
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('invalid release version');
  });

  test('orders stable and prerelease versions', () => {
    expect(compareVersions('0.4.2', '0.4.1')).toBe(1);
    expect(compareVersions('0.4.2-beta.2', '0.4.2-beta.1')).toBe(1);
    expect(compareVersions('0.4.2-beta.100000000000000000000', '0.4.2-beta.9')).toBe(1);
    expect(compareVersions('0.4.2-beta.1', '0.4.2')).toBe(-1);
    expect(compareVersions('0.4.2', '0.4.2')).toBe(0);
  });

  test('updates only the formatted package version field', () => {
    const input = '{\n  "name": "@konstit/csv",\n  "version": "0.4.1"\n}\n';
    expect(updatePackageVersion(input, '0.4.1', '0.4.2')).toBe(
      '{\n  "name": "@konstit/csv",\n  "version": "0.4.2"\n}\n',
    );
    expect(() => updatePackageVersion('{}\n', '0.4.1', '0.4.2')).toThrow('one formatted top-level version field');
  });

  test('extracts the run ID from gh workflow output', () => {
    expect(parseWorkflowRunId('https://github.com/Konstit-Engenharia/csv-parser/actions/runs/32922391540')).toBe(
      '32922391540',
    );
    expect(() => parseWorkflowRunId('')).toThrow('could not read workflow run ID');
  });

  test('preserves leading whitespace in captured command output', async () => {
    const status = await run([process.execPath, '-e', 'process.stdout.write(" M package.json\\n")'], {
      capture: true,
      label: 'Capture porcelain status',
    });
    expect(status).toBe(' M package.json');
  });

  test('runs the verified release sequence', async () => {
    const headCommit = '31507a86b3d036f3f9d2892db61c8158cf034c91';
    const commands: string[][] = [];
    let packageText = '{\n  "name": "@konstit/csv",\n  "version": "0.4.1"\n}\n';
    let versionWritten = false;
    let npmLookupCount = 0;

    const run: CommandRunner = async (command) => {
      const mutableCommand = [...command];
      commands.push(mutableCommand);
      const joined = mutableCommand.join(' ');
      if (joined === 'git status --porcelain=v1') {
        return versionWritten ? ' M package.json' : '';
      }
      if (joined === 'git branch --show-current') {
        return 'main';
      }
      if (joined === 'git rev-list --left-right --count origin/main...HEAD') {
        return '0 1';
      }
      if (joined === 'git rev-parse HEAD' || joined === 'git rev-list -n 1 v0.4.2') {
        return headCommit;
      }
      if (joined === 'git tag --list v0.4.2' || joined === 'git ls-remote --tags origin refs/tags/v0.4.2') {
        return '';
      }
      if (joined === 'gh workflow run package.yml --ref main -f release_tag=v0.4.2') {
        return 'https://github.com/Konstit-Engenharia/csv-parser/actions/runs/42';
      }
      if (joined === 'gh release view v0.4.2 --json isDraft,isImmutable,url,assets') {
        return JSON.stringify({
          assets: [{ name: 'konstit-csv-v0.4.2.tgz' }],
          isDraft: false,
          isImmutable: true,
          url: 'https://github.com/Konstit-Engenharia/csv-parser/releases/tag/v0.4.2',
        });
      }
      return '';
    };

    await release(
      { updatePrebuilds: false, version: '0.4.2' },
      {
        lookupPublishedVersion: async (_name, version) => {
          ++npmLookupCount;
          return npmLookupCount === 1 ? undefined : version;
        },
        readPackageText: async () => packageText,
        run,
        writePackageText: async (text) => {
          packageText = text;
          versionWritten = true;
        },
      },
    );

    expect(packageText).toContain('"version": "0.4.2"');
    expect(commands).toContainEqual(['git', 'commit', '-m', 'Release 0.4.2']);
    expect(commands).toContainEqual(['git', 'tag', '-a', 'v0.4.2', '-m', 'v0.4.2']);
    expect(commands).toContainEqual([
      'git',
      'push',
      '--atomic',
      'origin',
      'HEAD:refs/heads/main',
      'refs/tags/v0.4.2',
    ]);
    expect(commands).toContainEqual(['gh', 'run', 'watch', '42', '--exit-status']);
    expect(commands).toContainEqual(['gh', 'release', 'verify', 'v0.4.2']);
    expect(npmLookupCount).toBe(2);
  });

  test('restores package.json when validation fails before the release commit', async () => {
    const initialPackageText = '{\n  "name": "@konstit/csv",\n  "version": "0.4.1"\n}\n';
    const commands: string[][] = [];
    let packageText = initialPackageText;

    const run: CommandRunner = async (command) => {
      const mutableCommand = [...command];
      commands.push(mutableCommand);
      const joined = mutableCommand.join(' ');
      if (joined === 'git status --porcelain=v1') {
        return packageText === initialPackageText ? '' : ' M package.json';
      }
      if (joined === 'git branch --show-current') {
        return 'main';
      }
      if (joined === 'git rev-list --left-right --count origin/main...HEAD') {
        return '0 0';
      }
      if (mutableCommand[1] === 'run' && mutableCommand[2] === 'lint') {
        throw new Error('lint failed');
      }
      return '';
    };

    const error = await rejectedError(
      release(
        { updatePrebuilds: false, version: '0.4.2' },
        {
          lookupPublishedVersion: async () => undefined,
          readPackageText: async () => packageText,
          run,
          writePackageText: async (text) => {
            packageText = text;
          },
        },
      ),
    );

    expect(error.message).toBe('lint failed');
    expect(packageText).toBe(initialPackageText);
    expect(commands).toContainEqual(['git', 'reset', '--quiet', '--', 'package.json']);
    expect(commands.some((command) => command.includes('commit'))).toBe(false);
    expect(commands.some((command) => command.includes('push'))).toBe(false);
  });
});
