import {
  generatePackageOperations,
  executePackageOperations,
  validateOperations as validatePackageOperations,
} from "./scripts/package-management";

import {
  generateGitNaming,
  executeGitBranching,
  type GitNaming,
} from "./scripts/version-control-management";

import {
  type ProjectFiles,
  type ProjectFilePath,
  projectFilePath,
  ProjectFileModification,
} from "./helpers/project-files";

import type { RequireExactlyOne } from "type-fest";
import { verboseLog } from "./helpers/logger";
import { executeProjectFilesAnalysis } from "./scripts/file-modifier";
import * as R from "remeda";
import { executeSingleFileModifications } from "./scripts/file-modifier";
import { deleteAsync } from "del";

export type ScriptContext = {
  rawRequest: string;
  executionStepDescription: string;
  executionPlan: {
    steps: Array<{
      description: string;
      scriptFile: string;
      priority: number;
    }>;
    analysis: string;
  };
  files: ProjectFiles;
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
    execute: async ({ rawRequest, files }) => {
      const operations = await generatePackageOperations(
        rawRequest,
        JSON.stringify(files[projectFilePath("package.json")])
      );

      if (await validatePackageOperations(operations.operations)) {
        await executePackageOperations(operations.operations);
      }
    },
    validateRequest: async ({ rawRequest, files }) => {
      if (!files[projectFilePath("package.json")]) return false;
      const operations = await generatePackageOperations(
        rawRequest,
        JSON.stringify(files[projectFilePath("package.json")])
      );

      return validatePackageOperations(operations.operations);
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
    execute: async ({ files, executionStepDescription }) => {
      const projectFilesAnalysis = await executeProjectFilesAnalysis(
        executionStepDescription,
        files
      );

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

      verboseLog(
        `Files to process: ${JSON.stringify(filesToProcess, null, 2)}`
      );

      for (const projectFileModification of filesToProcess) {
        await executeSingleFileModifications(
          projectFileModification,
          projectFilesAnalysis
        );
      }

      if (projectFilesAnalysis.removal?.file_paths_to_remove) {
        for (const { path } of projectFilesAnalysis.removal
          .file_paths_to_remove) {
          await deleteAsync(path);
          verboseLog(`Safely deleted project file: ${path}`);
        }
      }
    },
  },
  "version-control-management": {
    execute: async ({ rawRequest }) => {
      const naming = await generateGitNaming(rawRequest);
      await executeGitBranching(naming);
    },
  },
};
