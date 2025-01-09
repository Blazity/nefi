#!/usr/bin/env node

const dotenvx = require("@dotenvx/dotenvx");
const envPath = `${process.cwd()}/.env`;

dotenvx.config({
  path: envPath,
  override: true,
});

import { Cli } from "clipanion";
import pc from "picocolors"
import { AgentCommand } from "./commands/agent";
import { TestXmlCommand } from "./commands/test-xml/impl";
import dedent from "dedent";

const cli = new Cli({
  binaryName: "nefi",
  binaryLabel: "Next Enterprise Feature Integrations",
  binaryVersion: "1.0.0",
});

const logo = 
  "                 ___   \n" +
  "               /'___)_ \n" +
  "  ___     __  | (__ (_)\n" +
  "/' _ `\\ /'__`\\| ,__)| |\n" +
  "| ( ) |(  ___/| |   | |\n" +
  "(_) (_)`\\____)(_)   (_)";


// Register all commands
cli.register(AgentCommand);
cli.register(TestXmlCommand);

console.log(logo, "\n");
console.log(dedent`
  ${pc.bold(pc.bgBlazityOrange(pc.black(" Next Enterprise Feature Integrations ")))}
  ${pc.bold(pc.gray("Powered by AI"))} ${pc.gray("created by")} ${pc.dim("https://github.com/")}${pc.bold(pc.blazityOrange("Blazity"))}
`)

console.log("")

cli.runExit(process.argv.slice(2));
