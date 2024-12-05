import { execa } from "execa";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import dedent from "dedent";
import { log, spinner } from "@clack/prompts";
import { writeHistory } from "../helpers/history";
import type { ScriptContext } from "../types";

type PackageManager = "npm" | "yarn" | "pnpm" | "bun";

interface SystemInfo {
  packageManager: PackageManager;
  nodeVersion: string;
  isNvm: boolean;
}

async function detectPackageManager(
  projectPath: string
): Promise<PackageManager> {
  const lockFiles = {
    "yarn.lock": "yarn",
    "package-lock.json": "npm",
    "pnpm-lock.yaml": "pnpm",
    "bun.lockb": "bun",
  } as const;

  for (const [file, manager] of Object.entries(lockFiles)) {
    if (existsSync(join(projectPath, file))) {
      return manager as PackageManager;
    }
  }

  return "npm";
}

async function detectNodeVersion(): Promise<string> {
  const { stdout } = await execa("node", ["--version"]);
  return stdout.trim();
}

async function isNvmInstalled(): Promise<boolean> {
  try {
    const { stdout } = await execa("command", ["-v", "nvm"]);
    return !!stdout;
  } catch {
    return false;
  }
}

async function getSystemInfo(projectPath: string): Promise<SystemInfo> {
  const spin = spinner();
  spin.start("Detecting system configuration");

  const [packageManager, nodeVersion, isNvm] = await Promise.all([
    detectPackageManager(projectPath),
    detectNodeVersion(),
    isNvmInstalled(),
  ]);

  spin.stop("System configuration detected");

  return {
    packageManager,
    nodeVersion,
    isNvm,
  };
}

async function installPackages(
  packages: string[],
  projectPath: string,
  systemInfo: SystemInfo
): Promise<string> {
  const commands: Record<PackageManager, { cmd: string; args: string[] }> = {
    npm: { cmd: "npm", args: ["install", "--save"] },
    yarn: { cmd: "yarn", args: ["add"] },
    pnpm: { cmd: "pnpm", args: ["add"] },
    bun: { cmd: "bun", args: ["add"] },
  };

  const { cmd, args } = commands[systemInfo.packageManager];
  const spin = spinner();

  spin.start(`Installing packages using ${systemInfo.packageManager}`);
  const { stdout } = await execa(cmd, [...args, ...packages], {
    cwd: projectPath,
  });
  spin.stop("Packages installed successfully");

  return stdout;
}

export default async function ({
  path = process.cwd(),
  packages = [],
}: ScriptContext) {
  if (!Array.isArray(packages) || !packages.length) {
    log.error("No packages specified or invalid packages array");
    throw new Error("No packages specified");
  }

  try {
    const systemInfo = await getSystemInfo(path);
    log.info(dedent`System Information:
- Package Manager: ${systemInfo.packageManager}
- Node Version: ${systemInfo.nodeVersion}
- NVM Installed: ${systemInfo.isNvm}`);

    log.step(`Installing packages: ${packages.join(", ")}`);
    const result = await installPackages(packages, path, systemInfo);

    log.success("Installation completed successfully");

    const resultToReturn = {
      systemInfo,
      installed: packages,
      output: result,
    };

    writeHistory({
      op: "add-package",
      p: packages,
    });

    return resultToReturn;
  } catch (error) {
    if (error instanceof Error) {
      log.error(error.message);
    }
    throw error;
  }
}
