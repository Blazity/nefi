#!/usr/bin/env node

const dotenvx = require("@dotenvx/dotenvx");
const envPath = `${process.cwd()}/.env`;

dotenvx.config({
  path: envPath,
  override: true,
});

import { buildApplication, buildRouteMap } from "@stricli/core";
import { run } from "@stricli/core";

import { agentCommand } from "./commands/agent";

const rootCommandRouter = buildRouteMap({
  routes: {
    agent: agentCommand
  },
  docs: {
    brief: "Test",
  },
});

run(
  buildApplication(rootCommandRouter, {
    name: "next-enterprise-feature-manager",
  }),
  process.argv.slice(2),
  { process },
);
