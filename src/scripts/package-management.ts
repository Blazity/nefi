import { generateText, generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { log, spinner } from "@clack/prompts";
import { execa } from "execa";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { writeHistory } from "../helpers/history";
import { verboseLog } from "../helpers/logger";

// Constants
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;

// Types
type PackageManager = "npm" | "yarn" | "pnpm" | "bun";

interface SystemInfo {
  packageManager: PackageManager;
  nodeVersion: string;
  isNvm: boolean;
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

// Schemas
export const packageOperationSchema = z.object({
  operations: z.array(
    z.object({
      type: z.enum(["add", "remove"]),
      packages: z.array(z.string()),
      reason: z.string(),
      dependencies: z.array(z.string()).optional(),
    })
  ),
  analysis: z.string(),
});

export type PackageOperation = z.infer<typeof packageOperationSchema>;

// System Information Functions
async function detectNodeVersion(): Promise<string> {
  const { stdout } = await execa("node", ["--version"]);
  return stdout.trim();
}

async function isNvmInstalled(): Promise<boolean> {
  try {
    await execa("command", ["-v", "nvm"]);
    return true;
  } catch {
    return false;
  }
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

  return "npm"; // Default to npm if no lock file is found
}

async function getSystemInfo(projectPath: string): Promise<SystemInfo> {
  const [packageManager, nodeVersion, isNvm] = await Promise.all([
    detectPackageManager(projectPath),
    detectNodeVersion(),
    isNvmInstalled(),
  ]);

  return {
    packageManager,
    nodeVersion,
    isNvm,
  };
}

// Package Installation Functions
async function installPackages(
  packages: string[],
  projectPath: string,
  systemInfo: SystemInfo
): Promise<string> {
  const installCommands = {
    npm: ["install"],
    yarn: ["add"],
    pnpm: ["add"],
    bun: ["add"],
  };

  const command = systemInfo.packageManager;
  const args = [...installCommands[command], ...packages];

  const { stdout } = await execa(command, args, {
    cwd: projectPath,
    stdio: ["inherit", "pipe", "pipe"],
  });

  verboseLog("Package installation output:", stdout);
  return stdout;
}

// Package Validation Functions
async function validatePackageNames(
  packages: string[]
): Promise<{ isValid: boolean; reason?: string }> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await generateText({
        model: anthropic("claude-3-5-haiku-20241022"),
        messages: [
          {
            role: "system",
            content: `
<role>You are a package name validator that checks if provided npm package names are valid and complete.</role>

<rules>
  - Package names must be complete (e.g., '@storybook/react' not just 'storybook')
  - Package names must follow npm naming conventions
  - Package names should be commonly used in the npm ecosystem
  - Respond in XML format only
</rules>

<output-format>
  <validation>
    <result>VALID</result> or <result>INVALID</result>
    <reason>Only if invalid, explain why</reason>
  </validation>
</output-format>

<examples>
  <example>
    <input>["react", "@types/react"]</input>
    <validation>
      <result>VALID</result>
    </validation>
  </example>
  <example>
    <input>["storybook"]</input>
    <validation>
      <result>INVALID</result>
      <reason>Incomplete package name. Should be '@storybook/react' or similar specific Storybook package</reason>
    </validation>
  </example>
</examples>`,
          },
          {
            role: "user",
            content: `Validate these package names: ${JSON.stringify(packages)}`,
          },
        ],
      });

      const responseText = response.text.trim();
      const isValid = responseText.includes("<result>VALID</result>");

      if (!isValid && attempt < MAX_RETRIES - 1) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        continue;
      }

      const reasonMatch = responseText.match(/<reason>(.*?)<\/reason>/s);
      return {
        isValid,
        reason: !isValid && reasonMatch ? reasonMatch[1].trim() : undefined,
      };
    } catch (error) {
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        continue;
      }
      throw error;
    }
  }

  return { isValid: false, reason: "Maximum validation attempts reached" };
}

// Package Operation Functions
const SYSTEM_PROMPT = `<package_manager>
  <role>You are a package management expert that helps users manage their Node.js project dependencies.</role>
  
  <rules>
    <critical_rules>
      <rule>ONLY suggest removing packages that are EXPLICITLY listed in the current package.json's dependencies or devDependencies</rule>
      <rule>NEVER suggest removing a package that is not present in the current package.json</rule>
      <rule>If asked to remove a package that doesn't exist in package.json, respond that it cannot be removed as it's not installed</rule>
      <rule>When removing packages, ALWAYS verify their existence in package.json first</rule>
      <rule>NEVER hallucinate or make assumptions about installed packages - use ONLY the package.json content provided</rule>
    </critical_rules>

    <package_addition>
      <rule>Suggest appropriate versions for new packages</rule>
      <rule>Consider existing dependencies to avoid version conflicts</rule>
      <rule>Recommend packages as devDependencies when they are development tools</rule>
    </package_addition>

    <validation>
      <rule>Always validate that suggested changes won't break the project's functionality</rule>
    </validation>
  </rules>
</package_manager>`;

export async function generatePackageOperations(
  request: string,
  packageJsonContent: string
): Promise<PackageOperation> {
  verboseLog("Generating package operations for request", {
    request,
    packageJsonContent,
  });

  let packageJson: PackageJson = {};
  try {
    packageJson = JSON.parse(packageJsonContent);
  } catch (error) {
    throw new Error("Invalid package.json content");
  }

  const result = await generateObject<PackageOperation>({
    model: anthropic("claude-3-5-sonnet-20241022"),
    schema: packageOperationSchema,
    messages: [
      {
        role: "system",
        content: SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: `<request>
  <package_json>
${packageJsonContent}
  </package_json>

  <user_request>${request}</user_request>
</request>`,
      },
    ],
  });

  const operations = result.object;

  const installedPackages = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };

  // Filter out non-existent packages for removal operations
  operations.operations = operations.operations.map((operation) => {
    if (operation.type === "remove") {
      const validPackages = operation.packages.filter((pkg) => {
        const isInstalled = !!installedPackages[pkg];
        if (!isInstalled) {
          verboseLog(`Skipping removal of non-existent package: ${pkg}`);
        }
        return isInstalled;
      });

      return {
        ...operation,
        packages: validPackages,
      };
    }
    return operation;
  });

  // Remove operations with no valid packages
  operations.operations = operations.operations.filter((operation) => {
    if (operation.type === "remove" && operation.packages.length === 0) {
      log.info(`No valid packages to remove - they might not be installed`);
      return false;
    }
    return true;
  });

  if (operations.operations.length === 0) {
    log.info(
      "No valid operations to perform - the packages might not be installed"
    );
    return { operations: [], analysis: "No valid operations to perform" };
  }

  verboseLog("Generated package operations", operations);
  return operations;
}

export async function validateOperations(
  operations: PackageOperation["operations"]
): Promise<boolean> {
  verboseLog("Validating operations", operations);

  if (operations.length === 0) {
    return false;
  }

  for (const operation of operations) {
    const validation = await validatePackageNames(operation.packages);
    if (!validation.isValid) {
      log.warn(
        `Package validation warning for ${operation.type} operation: ${validation.reason}`
      );
      verboseLog("Operations validation result", { isValid: false });
      return false;
    }
  }
  verboseLog("Operations validation result", { isValid: true });
  return true;
}

export async function executePackageOperations(
  operations: PackageOperation["operations"]
): Promise<void> {
  verboseLog("Executing package operations", operations);
  const spin = spinner();
  const projectPath = process.cwd();

  if (operations.length === 0) {
    log.info("No valid operations to perform");
    return;
  }

  try {
    spin.start("Gathering system information");
    const systemInfo = await getSystemInfo(projectPath);
    spin.stop("System information gathered");

    // Read package.json once at the start
    const packageJsonPath = join(projectPath, "package.json");
    if (!existsSync(packageJsonPath)) {
      throw new Error("No package.json found in the current directory");
    }
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
    const allDeps = {
      ...(packageJson.dependencies || {}),
      ...(packageJson.devDependencies || {}),
    };

    log.info(`Using ${systemInfo.packageManager} package manager`);
    log.info(`Node.js version: ${systemInfo.nodeVersion}`);

    for (const operation of operations) {
      verboseLog(`Executing operation: ${operation.type}`, operation);
      const packageList = operation.packages
        .map((pkg) => `'${pkg}'`)
        .join(", ");

      if (operation.type === "add") {
        // Check if packages are already installed
        const existingPackages = operation.packages.filter((pkg) => allDeps[pkg]);
        if (existingPackages.length === operation.packages.length) {
          log.info(`All packages are already installed: ${packageList}`);
          continue;
        }

        const newPackages = operation.packages.filter((pkg) => !allDeps[pkg]);
        if (newPackages.length > 0) {
          const installList = newPackages.map(pkg => `'${pkg}'`).join(", ");
          spin.start(`Installing new packages: ${installList}`);
          await installPackages(newPackages, projectPath, systemInfo);
          spin.stop("Packages installed successfully");
        }
      } else {
        // For removal operations
        const existingPackages = operation.packages.filter((pkg) => allDeps[pkg]);
        if (existingPackages.length === 0) {
          log.info(`No packages to remove - none of the specified packages are installed: ${packageList}`);
          continue;
        }

        const removeList = existingPackages.map(pkg => `'${pkg}'`).join(", ");
        spin.start(`Removing packages: ${removeList}`);
        const removeCommand = systemInfo.packageManager === "yarn" ? "remove" : "uninstall";
        const result = await execa(
          systemInfo.packageManager,
          [removeCommand, ...existingPackages],
          {
            cwd: projectPath,
            stdio: ["inherit", "pipe", "pipe"],
          }
        );

        verboseLog("Package removal output:", result.stdout);
        spin.stop("Packages removed successfully");
      }

      // Record the operation in history
      await writeHistory({
        op: `package-${operation.type}`,
        p: operation.packages,
      });
    }

    log.info("All operations completed successfully");
  } catch (error: any) {
    spin.stop(
      `Failed to execute package operations: ${error?.message || "Unknown error"}`
    );
    throw error;
  }
}
