#!/usr/bin/env node

import { PackageJson } from "type-fest";
import rawPackageJson from "../package.json";
import { loadEnvVars } from "./helpers/env-loading";

const packageJson = rawPackageJson as unknown as PackageJson;

import { Cli } from "clipanion";
import pc from "picocolors";
import { AgentCommand } from "./commands/agent";
import { TestXmlCommand } from "./commands/test-xml/impl";
import dedent from "dedent";
import { isBefore, parseISO } from "date-fns";

const cli = new Cli({
  binaryName: packageJson.name,
  binaryLabel: packageJson.description,
  binaryVersion: packageJson.version,
  enableColors: true,
});

const logoNew=`
                                 ███████
  ██                            ██     ██
    ██      ██████     █████    ██       ██ 
      ██    ██    ██  ██    ██  ██████    
    ██      ██    ██  ████      ██       ██
  ██        ██    ██  ██    ██  ██       ██
      ████  ██    ██   █████    ██       ██
`;

console.log(pc.whiteBright(logoNew), "\n");
cli.register(AgentCommand);
cli.register(TestXmlCommand);


const RELEASE_DATE = parseISO("2025-01-23");
const shouldSkipDateCheck = process.argv.includes("--skip-date-check");

if (shouldSkipDateCheck) {
  process.argv = process.argv.filter((arg) => arg !== "--skip-date-check");
}

if (isBefore(new Date(), RELEASE_DATE) && !shouldSkipDateCheck) {
  console.log(" Coming soon... 23th of January, 2025\n");
  console.log(
    ` ${pc.bgBlack(pc.whiteBright(pc.bold(" https://x.com/")))}${pc.bgBlack(pc.whiteBright(pc.bold("nefi_ai ")))}\n`
  );
  console.log(` ${pc.bgBlack(pc.whiteBright(pc.bold(" https://nefi.ai ")))}\n`);
  process.exit(1);
}

// console.log(dedent`
//   ${pc.bold(pc.bgBlazityOrange(pc.black(" Next Enterprise Feature Integrations ")))}

//   ${pc.bold(pc.white(" Powered by AI"))}
//   ${pc.dim("     created by")} ${pc.white(pc.bold("https://github.com/"))}${pc.bold(pc.blazityOrange("Blazity"))}
// `);

// console.log("");

await loadEnvVars({
  requiredEnvVars: ["ANTHROPIC_API_KEY"],
});

cli.runExit(process.argv.slice(2));
