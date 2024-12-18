import {
  generatePackageOperations,
  executePackageOperations,
  validateOperations as validatePackageOperations,
} from "./scripts/package-management";

import {
  generateFileOperations,
  executeFileOperations,
  type SourceFile
} from "./scripts/file-management";

import {
  generateGitNaming,
  executeGitBranching,
  type GitNaming
} from "./scripts/version-control-management";

import type { RequireExactlyOne } from 'type-fest';

export type ScriptContext = {
  rawRequest: string;
  executionPlan: {
    steps: Array<{
      type: string;
      description: string;
      scriptFile: string;
      priority: number;
    }>;
    analysis: string;
  };
  files: {
    [path: string]: {
      content: string;
      isGitIgnored: boolean;
    };
  };
};

export type ScriptRequirements = RequireExactlyOne<{
  requiredFiles: string[];
  requiredFilePatterns: string[];
  files: boolean;
  history: boolean;
}>;

export type ScriptHandler = {
  execute: (context: ScriptContext) => Promise<void>;
  validateRequest?: (context: ScriptContext) => Promise<boolean>;
  requirements?: ScriptRequirements;
};

export const scriptHandlers: Record<string, ScriptHandler> = {
  "package-management": {
    requirements: {
      requiredFiles: ["package.json"]
    },
    execute: async (context: ScriptContext) => {
      const operations = await generatePackageOperations(
        context.rawRequest,
        JSON.stringify(context.files["package.json"])
      );
      if (await validatePackageOperations(operations.operations)) {
        await executePackageOperations(operations.operations);
      }
    },
    validateRequest: async (context: ScriptContext) => {
      if (!context.files["package.json"]) {
        return false;
      }
      
      const operations = await generatePackageOperations(
        context.rawRequest,
        JSON.stringify(context.files["package.json"])
      );
      return validatePackageOperations(operations.operations);
    },
  },
  "file-management": {
    requirements: {
      requiredFilePatterns: ["**/*"],
    },
    execute: async (context: ScriptContext) => {
      const sourceFiles: SourceFile[] = Object.entries(context.files)
        .filter(([_, info]) => !info.isGitIgnored)
        .map(([path, info]) => ({
          path,
          content: info.content,
        }));

      const operations = await generateFileOperations(context.rawRequest, sourceFiles);
      await executeFileOperations(operations);
    },
  },
  "version-control-management": {
    execute: async (context: ScriptContext) => {
      const naming = await generateGitNaming(context.rawRequest);
      await executeGitBranching(naming);
    },
  },
};
