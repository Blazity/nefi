import type { ProjectFiles, ProjectFilePath } from "./helpers/project-files";
import type { DetailedLogger } from "./helpers/logger";

// Base interfaces
export interface ScriptContext {
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
}

export interface ScriptRequirements {
  requiredFilesByPath?: ProjectFilePath[];
  requiredFilesByPathWildcard?: string[];
  excludedFilesByPathWildcard?: string[];
}

// Base Script Handler Interface
export interface ScriptHandler {
  execute(context: ScriptContext): Promise<void>;
  validateRequest?(context: ScriptContext): Promise<boolean>;
  getRequirements(): ScriptRequirements;
}

// Script Registry using Singleton pattern
class ScriptRegistry {
  private static instance: ScriptRegistry;
  private handlers: Map<string, ScriptHandler>;

  private constructor() {
    this.handlers = new Map();
  }

  static getInstance(): ScriptRegistry {
    if (!ScriptRegistry.instance) {
      ScriptRegistry.instance = new ScriptRegistry();
    }
    return ScriptRegistry.instance;
  }

  registerHandler(name: string, handler: ScriptHandler): void {
    this.handlers.set(name, handler);
  }

  getHandler(name: string): ScriptHandler | undefined {
    return this.handlers.get(name);
  }

  getAllHandlers(): Map<string, ScriptHandler> {
    return new Map(this.handlers);
  }
}

// Export the registry instance
export const scriptRegistry = ScriptRegistry.getInstance();
