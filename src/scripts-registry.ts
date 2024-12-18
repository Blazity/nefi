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
  requirements: ScriptRequirements;
};

export const scriptHandlers: Record<string, ScriptHandler> = {
  "package-management.ts": {
    requirements: {
      requiredFiles: ["package.json"],
    },
    execute: async (context: ScriptContext) => {
      const packageJsonContent = context.files["package.json"]?.content;
      if (!packageJsonContent) {
        throw new Error("package.json is required but not found in context");
      }

      const operations = await generatePackageOperations(context.rawRequest, packageJsonContent);
      if (await validatePackageOperations(operations.operations)) {
        await executePackageOperations(operations.operations);
      }
    },
    validateRequest: async (context: ScriptContext) => {
      const packageJsonContent = context.files["package.json"]?.content;
      if (!packageJsonContent) {
        return false;
      }
      
      const operations = await generatePackageOperations(context.rawRequest, packageJsonContent);
      return await validatePackageOperations(operations.operations);
    },
  },
  "file-management": {
    requirements: {
      requiredFilePatterns: ["**/*"],
    },
    execute: async (context: ScriptContext) => {
      const sourceFiles: SourceFile[] = Object.entries(context.files)
        .filter(([, file]) => !file.isGitIgnored)
        .map(([path, file]) => ({
          path,
          content: file.content
        }));

      const { operations } = await generateFileOperations(context.rawRequest, sourceFiles);
      await executeFileOperations(operations, sourceFiles);
    },
  },
};
