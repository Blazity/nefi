#!/usr/bin/env node

const dotenvx = require("@dotenvx/dotenvx");
const envPath = `${process.cwd()}/.env`;
import { PackageJson } from "type-fest"; 
import rawPackageJson from "../package.json"

const packageJson = rawPackageJson as unknown as PackageJson

dotenvx.config({
  path: envPath,
  override: true,
});

import { Cli } from "clipanion";
import pc from "picocolors"
import { AgentCommand } from "./commands/agent";
import { TestXmlCommand } from "./commands/test-xml/impl";
import dedent from "dedent";
import { isBefore, parseISO } from "date-fns";

const cli = new Cli({
  binaryName: packageJson.name,
  binaryLabel: packageJson.description,
  binaryVersion: packageJson.version,
  enableColors: true
});

const logo = 
  "                 ___   \n" +
  "               /'___)_ \n" +
  "  ___     __  | (__ (_)\n" +
  "/' _ `\\ /'__`\\| ,__)| |\n" +
  "| ( ) |(  ___/| |   | |\n" +
  "(_) (_)`\\____)(_)   (_)";


cli.register(AgentCommand);
cli.register(TestXmlCommand);

console.log(logo, "\n");

const RELEASE_DATE = parseISO('2025-01-23')
const shouldSkipDateCheck = process.argv.includes('--skip-date-check')

if (shouldSkipDateCheck) {
  process.argv = process.argv.filter(arg => arg !== '--skip-date-check')
}

if (isBefore(new Date(), RELEASE_DATE) && !shouldSkipDateCheck) {
  console.log(" Coming soon... 23th of January, 2025\n")
  console.log(` ${pc.bgBlack(pc.whiteBright(pc.bold(" https://x.com/")))}${pc.bgBlack(pc.whiteBright(pc.bold("nefi_ai ")))}\n`)
  console.log(` ${pc.bgBlack(pc.whiteBright(pc.bold(" https://nefi.ai ")))}\n`)
  process.exit(1)
}

console.log(dedent`
  ${pc.bold(pc.bgBlazityOrange(pc.black(" Next Enterprise Feature Integrations ")))}

  ${pc.bold(pc.white(" Powered by AI"))}
  ${pc.dim("     created by")} ${pc.white(pc.bold("https://github.com/"))}${pc.bold(pc.blazityOrange("Blazity"))}
`)

console.log("")


cli.runExit(process.argv.slice(2));
