import { packagedNativeTargets } from './native-target.ts';

await (import.meta.main ? main() : Promise.resolve());

export interface PrePushDependencies {
  readonly run?: typeof run;
}

export async function main(dependencies: PrePushDependencies = {}): Promise<void> {
  const runCommand = dependencies.run ?? run;
  await runCommand([
    process.execPath,
    'run',
    'prepush',
  ], 'pre-push checks');

  // macOS builds both Darwin targets and the Linux x64 target through Docker.
  const targets = process.platform === 'darwin' ? packagedNativeTargets : [];
  await runCommand([
    process.execPath,
    'run',
    'stage:native',
    ...targets,
  ], 'stage native prebuilds');
}

export async function run(command: string[], label: string): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: process.cwd(),
    stderr: 'inherit',
    stdin: 'ignore',
    stdout: 'inherit',
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${String(exitCode)}`);
  }
}
