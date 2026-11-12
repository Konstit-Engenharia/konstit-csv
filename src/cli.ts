#!/usr/bin/env bun

import { runCli } from './cli-command.js';

process.exitCode = await runCli(Bun.argv.slice(2));
