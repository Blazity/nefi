import {
  generatePackageOperations,
  executePackageOperations,
  validateOperations as validatePackageOperations,
} from "./scripts/package-management";

import {
  executeGitOperation,
  retrieveGitOperation,
} from "./scripts/git-operations";

import {
  type ProjectFiles,
  type ProjectFilePath,
  projectFilePath,
  ProjectFileModification,
} from "./helpers/project-files";

import { executeProjectFilesAnalysis } from "./scripts/file-modifier";
import * as R from "remeda";
import { executeSingleFileModifications } from "./scripts/file-modifier";
import { deleteAsync } from "del";
import type { DetailedLogger } from "./helpers/logger";
import { withAsyncAnthropicRateLimitRetry } from "./helpers/rate-limit-retrying";

export type ScriptContext = {
  userRequest: string;
  executionStepDescription: string;
  files: ProjectFiles;
  detailedLogger: DetailedLogger;
  executionPlan: {
    steps: {
      description: string;
      scriptFile: string;
      priority: number;
    }[];
    analysis: string;
  };
};

export type ScriptRequirements = Partial<{
  requiredFilesByPath: ProjectFilePath[];
  requiredFilesByPathWildcard: string[];
  excludedFilesByPathWildcard: string[];
}>;

export type ScriptHandler = Readonly<{
  execute: (context: ScriptContext) => Promise<void>;
  validateRequest?: (context: ScriptContext) => Promise<boolean>;
  requirements?: ScriptRequirements;
}>;

export const scriptHandlers: Record<string, ScriptHandler> = {
  "package-management": {
    requirements: {
      requiredFilesByPath: [projectFilePath("package.json")],
    },
    execute: async ({
      userRequest,
      executionStepDescription,
      files,
      detailedLogger,
    }) => {
      const packageJsonContent = files[projectFilePath("package.json")];

      const { operations } = await generatePackageOperations({
        userRequest,
        executionStepDescription,
        packageJsonContent,
        detailedLogger,
      });

      if (await validatePackageOperations({ operations, detailedLogger })) {
        await executePackageOperations({
          operations,
          detailedLogger,
          packageJsonContent,
        });
      }
    },
  },
  "file-modifier": {
    requirements: {
      requiredFilesByPathWildcard: ["**/*"],
      excludedFilesByPathWildcard: [
        "**/node_modules/**",
        "**/*.tsbuildinfo",
        "**/.git/**",
        "**/package-lock.json",
        "**/LICENSE",
        "**/README.md",
        "**/yarn-error.log",
        "**/pnpm-error.log",
        "**/bun-error.log",
        "**/yarn.lock",
        "**/pnpm-lock.yaml",
        "**/bun.lockb",
        "**/.DS_Store",
        "**/*.lock",
        "**/*.log",
        "**/dist/**",
        "**/build/**",
        "**/.next/**",
        "**/coverage/**",
      ],
    },
    execute: async ({ files, executionStepDescription, detailedLogger }) => {
      const projectFilesAnalysis = await withAsyncAnthropicRateLimitRetry({
        fn: () =>
          executeProjectFilesAnalysis({
            executionStepRequest: executionStepDescription,
            allProjectFiles: files,
            detailedLogger,
          }),
        detailedLogger,
      });

      const filesToProcess = R.pipe(
        [
          (projectFilesAnalysis.creation?.files_to_modify ?? []).map(
            ({ path, why }) => ({
              path: projectFilePath(path),
              why,
              operation: "modify" as const,
              content: files[projectFilePath(path)],
            })
          ),
          (projectFilesAnalysis.creation?.files_to_create ?? []).map(
            ({ path, why }) => ({
              path: projectFilePath(path),
              operation: "create" as const,
              why,
            })
          ),
        ],
        R.flat(),
        R.filter(R.isNonNullish)
      ) as ProjectFileModification[];

      detailedLogger.verboseLog(
        `Files to process: ${JSON.stringify(filesToProcess, null, 2)}`
      );

      for (const projectFileModification of filesToProcess) {
        await withAsyncAnthropicRateLimitRetry({
          fn: () =>
            executeSingleFileModifications({
              detailedLogger,
              projectFileModification,
              projectFilesAnalysis,
            }),
          detailedLogger,
        });
      }

      if (projectFilesAnalysis.removal?.file_paths_to_remove) {
        for (const { path } of projectFilesAnalysis.removal
          .file_paths_to_remove) {
          await deleteAsync(path);
          detailedLogger.verboseLog(`Safely deleted project file: ${path}`);
        }
      }
    },
  },
  "git-operations": {
    execute: async ({
      userRequest,
      detailedLogger,
      executionStepDescription,
    }) => {
      const operation = await retrieveGitOperation({
        userRequest,
        executionStepDescription,
      });

      await withAsyncAnthropicRateLimitRetry({
        fn: () =>
          executeGitOperation({
            userRequest,
            operation,
            detailedLogger,
            executionStepDescription,
          }),
        detailedLogger,
      });
    },
  },
};
