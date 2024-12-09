import {
  generatePackageOperations,
  executePackageOperations,
  validateOperations,
} from "./scripts/package-management";

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

export type ScriptRequirements = {
  requiredFiles?: string[];
  requiredFilePatterns?: string[];
};

export type ScriptHandler = {
  execute: (context: ScriptContext) => Promise<void>;
  validateRequest: (context: ScriptContext) => Promise<boolean>;
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
      if (await validateOperations(operations.operations)) {
        await executePackageOperations(operations.operations);
      }
    },
    validateRequest: async (context: ScriptContext) => {
      const packageJsonContent = context.files["package.json"]?.content;
      if (!packageJsonContent) {
        return false;
      }
      
      const operations = await generatePackageOperations(context.rawRequest, packageJsonContent);
      return await validateOperations(operations.operations);
    },
  },
};
