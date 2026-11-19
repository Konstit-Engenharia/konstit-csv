import {
  describe,
  expect,
  test,
} from 'bun:test';
import {
  main,
  run,
} from '../scripts/pre-push.ts';

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

describe('pre-push checks', () => {
  test('stages the built prebuilds after prepush validation', async () => {
    const invocations: Array<{ command: string[]; label: string; }> = [];

    await main({
      run: async (command, label) => {
        invocations.push({ command, label });
      },
    });

    const targets = process.platform === 'darwin' ? ['darwin-arm64', 'darwin-x64', 'linux-x64'] : [];
    expect(invocations).toEqual([
      { command: [process.execPath, 'run', 'prepush'], label: 'pre-push checks' },
      { command: [process.execPath, 'run', 'stage:native', ...targets], label: 'stage native prebuilds' },
    ]);
  });

  test('skips staging when prepush validation fails', async () => {
    const labels: string[] = [];
    const failure = new Error('validation failed');

    const error = await rejectedError(main({
      run: async (_command, label) => {
        labels.push(label);
        throw failure;
      },
    }));
    expect(error).toBe(failure);
    expect(labels).toEqual(['pre-push checks']);
  });

  test('runs commands and reports failures', async () => {
    await run([process.execPath, '-e', 'void 0'], 'success');
    expect((await rejectedError(run([process.execPath, '-e', 'process.exit(7)'], 'checks'))).message).toBe(
      'checks failed with exit code 7',
    );
  });
});
