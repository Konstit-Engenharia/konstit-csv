#!/usr/bin/env bun

import { runCli } from './cli-command.js';

process.exitCode = await runCli(Bun.argv.slice(2), {
  log: console.log,
  error: console.error,
  write: (chunk) => Bun.write(Bun.stdout, chunk),
});
