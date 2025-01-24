import { generateText, generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { log, spinner } from "@clack/prompts";
import { execa } from "execa";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { writeHistory } from "../helpers/history";
import { xml } from "../helpers/xml";
import { type PackageJson } from "type-fest";
import * as R from "remeda";
import { DetailedLogger } from "../helpers/logger";
import dedent from "dedent";

// Constants
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;
const NPM_REGISTRY = "https://registry.npmjs.org";

// Types
type PackageManager = "npm" | "yarn" | "pnpm" | "bun";

interface SystemInfo {
  packageManager: PackageManager;
  nodeVersion: string;
  isNvm: boolean;
}

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

type GeneratePackageOperationsParams = Readonly<{
  userRequest: string;
  packageJsonContent: string;
  detailedLogger: DetailedLogger;
  executionStepDescription: string;
}>;

export async function generatePackageOperations({
  userRequest,
  packageJsonContent,
  detailedLogger,
  executionStepDescription,
}: GeneratePackageOperationsParams): Promise<PackageOperation> {
  detailedLogger.verboseLog("Generating package operations", { userRequest });

  let packageJson: PackageJson = {};
  try {
    packageJson = JSON.parse(packageJsonContent);
  } catch (error) {
    throw new Error("Invalid package.json content");
  }

  try {
    const { object } = await generateObject({
      model: anthropic("claude-3-5-sonnet-20241022", {
        cacheControl: true,
      }),
      schema: packageOperationSchema,
      messages: [
        {
          role: "system",
          content: dedent`
            You are a package management expert that helps users manage their Node.js project dependencies. The current's package.json is in the <package_json> section. High-level user request is in the <user_request> section.
            
            ${xml.build({
              rules: {
                critical_rules: {
                  rule: [
                    "ONLY suggest removing packages that are EXPLICITLY listed in the current package.json's dependencies or devDependencies",
                    "NEVER suggest removing a package that is not present in the current package.json",
                    "If asked to remove a package that doesn't exist in package.json, respond that it cannot be removed as it's not installed",
                  ],
                },
                general_rules: {
                  rule: [
                    "Suggest installing packages as devDependencies when they are development tools",
                    "Consider peer dependencies when suggesting packages",
                    "Recommend commonly used and well-maintained packages",
                    "Check for existing similar packages before suggesting new ones",
                  ],
                },
              },
            })}
          `,
          experimental_providerMetadata: {
            anthropic: {
              cacheControl: { type: "ephemeral" },
            },
          },
        },
        {
          role: "user",
          content: xml.build({
            package_json: {
              "#text": packageJsonContent,
            },
          }),
          experimental_providerMetadata: {
            anthropic: {
              cacheControl: { type: "ephemeral" },
            },
          },
        },
        {
          role: "user",
          content: dedent`
            User request for you:
            
            ${xml.build({
              user_request: {
                "#text": executionStepDescription,
              },
            })}
          `,
        },
      ],
    });

    const operations = object;
    const installedPackages = {
      ...(packageJson.dependencies || {}),
      ...(packageJson.devDependencies || {}),
    };

    operations.operations = operations.operations.map((operation) => {
      if (operation.type === "remove") {
        const originalLength = operation.packages.length;
        const validPackages = operation.packages.filter((pkg) => {
          const isInstalled = !!installedPackages[pkg];
          if (!isInstalled) {
            detailedLogger.verboseLog(
              `Skipping removal of non-existent package: ${pkg}`
            );
          }
          return isInstalled;
        });

        if (originalLength > 0 && validPackages.length === 0) {
          log.info(`No valid packages to remove - they might not be installed`);
        }

        return {
          ...operation,
          packages: validPackages,
        };
      }
      return operation;
    });

    operations.operations = operations.operations.filter((operation) => {
      return !(operation.type === "remove" && operation.packages.length === 0);
    });

    if (operations.operations.length === 0) {
      log.info(
        "No valid operations to perform - the packages might not be installed"
      );
      return { operations: [], analysis: "No valid operations to perform" };
    }

    detailedLogger.verboseLog("Generated package operations", operations);
    return operations;
  } catch (error) {
    detailedLogger.verboseLog("Failed to generate package operations", error);
    throw error;
  }
}

type ValidateOperationsParams = {
  operations: PackageOperation["operations"];
  detailedLogger: DetailedLogger;
};

export async function validateOperations({
  operations,
  detailedLogger,
}: ValidateOperationsParams) {
  detailedLogger.verboseLog("Validating operations", operations);

  if (R.isEmpty(operations)) {
    return false;
  }

  for (const operation of operations) {
    const validation = await validatePackageNames(operation.packages);
    if (!validation.isValid) {
      log.warn(
        `Package validation warning for ${operation.type} operation: ${validation.reason}`
      );
      detailedLogger.verboseLog("Operations validation result", {
        isValid: false,
      });
      return false;
    }
  }
  detailedLogger.verboseLog("Operations validation result", { isValid: true });

  return true;

  async function validatePackageNames(packages: string[]) {
    const spin = spinner();
    spin.start("Validating package names against npm registry...");

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const validationResults = await Promise.all(
          packages.map(async (pkg) => {
            const exists = await checkRegistry(pkg);
            return { package: pkg, exists };
          })
        );

        const invalidPackages = validationResults.filter(
          (result) => !result.exists
        );

        if (invalidPackages.length > 0) {
          const invalidNames = invalidPackages.map((p) => p.package).join(", ");
          spin.stop("Package validation failed");

          if (attempt < MAX_RETRIES - 1) {
            detailedLogger.verboseLog(
              `Retrying validation for failed packages: ${invalidNames}`
            );
            await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
            continue;
          }

          return {
            isValid: false,
            reason: `The following packages were not found in the npm registry: ${invalidNames}`,
          };
        }

        spin.stop("All packages validated successfully");
        return { isValid: true };
      } catch (error) {
        if (attempt < MAX_RETRIES - 1) {
          detailedLogger.verboseLog(
            "Error during package validation, retrying...",
            error
          );
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
          continue;
        }
        spin.stop("Package validation failed");
        detailedLogger.verboseLog("Error during package validation:", error);
        return {
          isValid: false,
          reason: "Failed to validate packages due to a network error",
        };
      }
    }

    spin.stop("Package validation failed");
    return { isValid: false, reason: "Maximum validation attempts reached" };

    async function checkRegistry(name: string) {
      try {
        const response = await globalThis.fetch(
          `${NPM_REGISTRY}/${name.toLowerCase()}`,
          { method: "HEAD" }
        );
        return response.status !== 404;
      } catch (error) {
        detailedLogger.verboseLog("Error checking package in registry:", error);
        return false;
      }
    }
  }
}

type ExecutePackageOperationsParams = Readonly<{
  operations: PackageOperation["operations"];
  detailedLogger: DetailedLogger;
  packageJsonContent: string;
}>;

export async function executePackageOperations({
  operations,
  detailedLogger,
  packageJsonContent,
}: ExecutePackageOperationsParams) {
  detailedLogger.verboseLog("Executing package operations", operations);
  const spin = spinner();
  const projectPath = process.cwd();

  if (R.isEmpty(operations)) {
    log.info("No valid operations to perform");
    return;
  }

  try {
    spin.start("Gathering system information");
    const systemInfo = await getSystemInfo(projectPath);
    spin.stop("System information gathered");

    let packageJson: PackageJson = {};
    try {
      packageJson = JSON.parse(packageJsonContent);
    } catch (error) {
      throw new Error("Invalid package.json content");
    }
    const allDeps = {
      ...(packageJson.dependencies || {}),
      ...(packageJson.devDependencies || {}),
    };

    log.info(`Using ${systemInfo.packageManager} package manager`);
    log.info(`Node.js version: ${systemInfo.nodeVersion}`);

    for (const operation of operations) {
      detailedLogger.verboseLog(
        `Executing operation: ${operation.type}`,
        operation
      );
      const packageList = operation.packages
        .map((pkg) => `'${pkg}'`)
        .join(", ");

      if (operation.type === "add") {
        const existingPackages = operation.packages.filter(
          (pkg) => allDeps[pkg]
        );
        if (existingPackages.length === operation.packages.length) {
          log.info(`All packages are already installed: ${packageList}`);
          continue;
        }

        const newPackages = operation.packages.filter((pkg) => !allDeps[pkg]);
        if (newPackages.length > 0) {
          const installList = newPackages.map((pkg) => `${pkg}`).join(", ");
          
          log.info(`Installing new packages: ${installList}`);
          await installPackages(newPackages, projectPath, systemInfo);
          log.info("Packages installed successfully");
        }
      } else {
        const existingPackages = operation.packages.filter(
          (pkg) => allDeps[pkg]
        );
        if (existingPackages.length === 0) {
          log.info(
            `No packages to remove - none of the specified packages are installed: ${packageList}`
          );
          continue;
        }

        const removeList = existingPackages.map((pkg) => `${pkg}`).join(", ");
        log.info(`Removing packages: ${removeList}`);
        
        try {
          const removeCommand =
            systemInfo.packageManager === "yarn" ? "remove" : "uninstall";

          await execa(systemInfo.packageManager, [removeCommand, ...existingPackages], {
            stdio: ["ignore", "pipe", "pipe"],
            cwd: projectPath
          });

          // Update allDeps to reflect the removed packages
          for (const pkg of existingPackages) {
            delete allDeps[pkg];
          }

          log.info("Packages removed successfully");
        } catch (error: any) {
          log.error(`Failed to remove packages: ${error.message}`);
          throw error;
        }
      }

      writeHistory({
        op: `package-${operation.type}`,
        d:
          operation.reason ||
          `${operation.type === "add" ? "Added" : "Removed"} packages: ${packageList}`,
        dt: {
          packages: operation.packages,
          type: operation.type,
          packageManager: systemInfo.packageManager,
          nodeVersion: systemInfo.nodeVersion,
          dependencies: operation.dependencies || [],
        },
      });
    }
  } catch (error: any) {
    spin.stop(
      `Failed to execute package operations: ${error?.message || "Unknown error"}`
    );
    throw error;
  }

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
      stdio: ["ignore", "pipe", "pipe"],
    });

    detailedLogger.verboseLog("Package installation output:", stdout);
    return stdout;
  }
}
