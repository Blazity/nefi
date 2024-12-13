#!/usr/bin/env node

const dotenvx = require("@dotenvx/dotenvx");
const envPath = `${process.cwd()}/.env`;

dotenvx.config({
  path: envPath,
  override: true,
});

import { Cli } from 'clipanion';
import { AgentCommand } from './commands/agent';

// Create a new CLI instance
const cli = new Cli({
  binaryName: 'next-enterprise-feature-manager',
  binaryLabel: 'Next.js Enterprise Feature Manager CLI',
  binaryVersion: '1.0.0',
});

// Register all commands
cli.register(AgentCommand);

// Run CLI with the current process arguments
cli.runExit(process.argv.slice(2));
