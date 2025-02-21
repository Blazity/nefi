import "reflect-metadata";
import type { ProjectFiles, ProjectFilePath } from "./helpers/project-files";
import type { DetailedLogger } from "./helpers/logger";
import { Promisable } from "type-fest";
import Handlebars from "handlebars";
import type { Message } from "ai";
import dedent from "dedent";

// Register Handlebars helpers for interceptor system
Handlebars.registerHelper('replaceXmlLikeContent', function(this: unknown, options: Handlebars.HelperOptions) {
  const content = options.fn(this);
  const tag = options.hash.tag;
  if (!tag) {
    throw new Error('Tag parameter is required for replaceXmlLikeContent helper');
  }

  const fullContent = options.data.root._fullContent || '';
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'g');
  const match = regex.exec(fullContent);

  if (match) {
    options.data.root._fullContent = fullContent.replace(
      match[0],
      `<${tag}>${content}</${tag}>`
    );
  }
  return content;
});

Handlebars.registerHelper('appendXmlLikeContent', function(this: unknown, options: Handlebars.HelperOptions) {
  const content = options.fn(this);
  const tag = options.hash.tag;
  const position = options.hash.position || 'top';
  if (!tag) {
    throw new Error('Tag parameter is required for appendXmlLikeContent helper');
  }

  const fullContent = options.data.root._fullContent || '';
  const regex = new RegExp(`(<${tag}>([\\s\\S]*?))<\\/${tag}>`, 'g');
  const match = regex.exec(fullContent);

  if (match) {
    const existingContent = match[1];
    const replacement = position === 'bottom' 
      ? `${existingContent}\n${content}</${tag}>`
      : `${match[1].replace(/<${tag}>/, `<${tag}>\n${content}`)}</${tag}>`;
    options.data.root._fullContent = fullContent.replace(match[0], replacement);
  }
  return content;
});

// Enhanced metadata keys with more descriptive names
const SCRIPT_REQUIREMENTS_KEY = Symbol("nefi:script-requirements");
const PROMPT_FUNCTIONS_KEY = Symbol("nefi:prompt-functions");
const INTERCEPTOR_METADATA_KEY = Symbol("nefi:interceptor-metadata");

// Message targeting types
export type MessageTarget = {
  role: Message["role"];
  index?: number;
} | number;

// Enhanced types for better type safety and clarity
export type InterceptorHook = {
  script: string;
  function: string;
  messageTarget: MessageTarget;
  priority?: number;
};

export type ScriptInterceptorMetadata = {
  name: string;
  description: string;
  hooks: InterceptorHook[];
};

export type ExecutionHooks = {
  beforeExecution?: () => void | Promise<void>;
  afterExecution?: () => void | Promise<void>;
};

export type ExecutionPlanHooks = {
  beforePlanDetermination?: () => Promise<{
    shouldContinue: boolean;
    message?: string;
  }>;
  afterPlanDetermination?: (plan: {
    steps: Array<{
      description: string;
      scriptFile: string;
      priority: number;
      interceptors?: Array<{
        name: string;
        description: string;
        reason: string;
      }>;
    }>;
    analysis: string;
  }) => Promise<{
    shouldKeepInterceptor: boolean;
    message?: string;
  }>;
};

export type ScriptContextValue = {
  transforms?(): {
    [key: string]: {
      transform: (content: string) => string;
      content: string;
    }[];
  };
  executionHooks?: ExecutionHooks;
} | Record<string, any>;

export type HandlebarsContextValue = string | { executionHooks: ExecutionHooks };

export type ScriptInterceptorContext = {
  [scriptName: string]: {
    [key: string]: ScriptContextValue | Record<string, string> | Record<string, string | (() => Promisable<string>)>;
  } & {
    partials?: Record<string, string>;
    values?: Record<string, string | (() => Promisable<string>)>;
  };
};

export type ScriptInterceptorConfig = {
  name: string;
  description: string;
  hooks: InterceptorHook[];
  handlebarsContext: Record<string, HandlebarsContextValue>;
  templatePartials?: Record<string, string>;
  executionPlanHooks?: ExecutionPlanHooks;
  confidence?: number;
  reason?: string;
};

export type StepInterceptor = {
  name: string;
  description: string;
  reason: string;
  confidence: number;
};

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
      interceptors?: StepInterceptor[];
    }[];
    analysis: string;
  };
  currentStepInterceptors?: StepInterceptor[];
}

export type ScriptHandlerConfig = {
  requirements?: {
    requiredFilesByPath?: ProjectFilePath[];
    requiredFilesByPathWildcard?: string[];
    excludedFilesByPathWildcard?: string[];
  };
};

// Message processing utilities
export interface LLMMessage extends Pick<Message, "role" | "content"> {}

// Decorators
export function ScriptHandler(config: ScriptHandlerConfig = {}) {
  return function <T extends { new (...args: any[]): BaseScriptHandler }>(target: T) {
    Reflect.defineMetadata(SCRIPT_REQUIREMENTS_KEY, config.requirements || {}, target.prototype);
    
    // Initialize prompt functions map if not exists
    if (!Reflect.hasMetadata(PROMPT_FUNCTIONS_KEY, target.prototype)) {
      Reflect.defineMetadata(PROMPT_FUNCTIONS_KEY, new Map(), target.prototype); 
    }

    return target;
  };
}

export function PromptFunction(): MethodDecorator {
  return function (
    target: Object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor
  ): PropertyDescriptor {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      const scriptName = scriptRegistry.getHandlerName(this as BaseScriptHandler);
      if (!scriptName) {
        return originalMethod.apply(this, args);
      }

      // Get interceptors for this function
      const interceptors = Array.from(scriptRegistry.getAllInterceptors().values());
      console.log(`[PromptFunction] Found ${interceptors.length} interceptors for ${scriptName}.${String(propertyKey)}`);
      
      // Execute beforeExecution hooks
      for (const interceptor of interceptors) {
        const hooks = interceptor.getExecutionHooksForFunction(scriptName, propertyKey.toString());
        if (hooks?.beforeExecution) {
          const interceptorName = interceptor.getConfig().name;
          console.log(`[${interceptorName}] Executing beforeExecution hook for ${String(propertyKey)}`);
          await hooks.beforeExecution();
        }
      }

      // Execute the original method
      const result = await originalMethod.apply(this, args);

      // Execute afterExecution hooks
      for (const interceptor of interceptors) {
        const hooks = interceptor.getExecutionHooksForFunction(scriptName, propertyKey.toString());
        if (hooks?.afterExecution) {
          const interceptorName = interceptor.getConfig().name;
          console.log(`[${interceptorName}] Executing afterExecution hook for ${String(propertyKey)}`);
          await hooks.afterExecution();
        }
      }

      return result;
    };

    const promptFunctions = Reflect.getMetadata(PROMPT_FUNCTIONS_KEY, target) || new Map();
    promptFunctions.set(propertyKey, {
      method: descriptor.value
    });
    Reflect.defineMetadata(PROMPT_FUNCTIONS_KEY, promptFunctions, target);
    return descriptor;
  };
}

export abstract class BaseScriptHandler {
  getRequirements(): NonNullable<NonNullable<ScriptHandlerConfig["requirements"]>> {
    return Reflect.getMetadata(SCRIPT_REQUIREMENTS_KEY, this) || {};
  }

  getPromptFunctions(): Map<string, unknown> {
    return Reflect.getMetadata(PROMPT_FUNCTIONS_KEY, this) || new Map();
  }

  protected processLLMMessages(messages: LLMMessage[], functionName: string, currentStepInterceptors?: StepInterceptor[]): LLMMessage[] {
    const scriptName = scriptRegistry.getHandlerName(this);
    if (!scriptName) {
      console.log('[processLLMMessages] Handler not registered properly');
      return messages;
    }

    // Get all registered interceptors for this script/function
    const allInterceptors = scriptRegistry.getInterceptorsForScript(scriptName, functionName);
    
    // Filter interceptors based on current step if provided
    const activeInterceptors = currentStepInterceptors 
      ? allInterceptors.filter(interceptor => 
          currentStepInterceptors.some(stepInt => 
            stepInt.name === interceptor.name && stepInt.confidence >= 0.5
          )
        )
      : allInterceptors;
    
    console.log('[processLLMMessages] Processing messages for:', {
      scriptName,
      functionName,
      interceptorsCount: activeInterceptors.length,
      interceptors: activeInterceptors.map(i => i.name),
      hasStepInterceptors: !!currentStepInterceptors
    });
    
    // If no interceptors are active for this step, return messages untouched
    if (activeInterceptors.length === 0) {
      console.log('[processLLMMessages] No active interceptors found for this step, returning original messages');
      return messages;
    }

    return messages.map((message, index) => {
      // Process interceptors
      const applicableInterceptors = activeInterceptors.filter(interceptor => {
        const hooks = interceptor.hooks.filter(hook => hook.script === scriptName);
        console.log('[processLLMMessages] Checking interceptor hooks:', {
          interceptorName: interceptor.name,
          scriptName,
          hooks: hooks.map(h => ({
            function: h.function,
            target: h.messageTarget
          }))
        });
        
        return hooks.some(hook => {
          if (hook.function !== functionName) return false;
          if (typeof hook.messageTarget === 'number') {
            return hook.messageTarget === index;
          }
          const matches = hook.messageTarget.role === message.role && 
            (hook.messageTarget.index === undefined || hook.messageTarget.index === index);
          
          console.log('[processLLMMessages] Hook match result:', {
            interceptor: interceptor.name,
            hook: hook.function,
            messageRole: message.role,
            targetRole: hook.messageTarget.role,
            matches
          });
          
          return matches;
        });
      });

      console.log('[processLLMMessages] Applicable interceptors for message:', {
        messageIndex: index,
        messageRole: message.role,
        applicableCount: applicableInterceptors.length,
        interceptors: applicableInterceptors.map(i => i.name)
      });

      if (applicableInterceptors.length === 0) {
        return message;
      }

      // Apply interceptors
      let content = message.content;

      for (const interceptor of applicableInterceptors) {
        const scriptContext = interceptor.handlebarsContext[`${scriptName}_${functionName}`] as HandlebarsContextValue;
        console.log('[processLLMMessages] Applying interceptor:', {
          interceptor: interceptor.name,
          hasScriptContext: !!scriptContext,
          contextKey: `${scriptName}_${functionName}`,
          availableContexts: Object.keys(interceptor.handlebarsContext)
        });
        
        if (!scriptContext) continue;

        const template = Handlebars.compile(scriptContext as string || '');
        const context = {
          _fullContent: content,
        };
        
        console.log('[processLLMMessages] Before transformation:', {
          interceptor: interceptor.name,
          contentLength: content.length,
          hasFullContent: !!context._fullContent
        });
        
        const result = template(context);
        content = context._fullContent || content;
        
        console.log('[processLLMMessages] After transformation:', {
          interceptor: interceptor.name,
          contentLength: content.length,
          resultLength: result.length,
          hasFullContent: !!context._fullContent
        });
      }

      return {
        role: message.role,
        content
      };
    });
  }

  getAllInterceptorsLLMRelevantMetadata(): Array<{
    name: string;
    description: string;
    canBeUsedWithOtherExtensions: boolean;
  }> {
    const scriptName = this.constructor.name.replace('Handler', '').toLowerCase();
    const promptFunctions = this.getPromptFunctions();
    const allInterceptors = new Map<string, ScriptInterceptorConfig>();
    
    // Gather all interceptors from all prompt functions
    promptFunctions.forEach((_, funcName) => {
      const interceptors = scriptRegistry.getInterceptorsForScript(scriptName, funcName.toString());
      interceptors.forEach(interceptor => {
        allInterceptors.set(interceptor.name, interceptor);
      });
    });

    return Array.from(allInterceptors.values()).map(interceptor => ({
      name: interceptor.name,
      description: interceptor.description,
      canBeUsedWithOtherExtensions: true
    }));
  }

  // Abstract method that must be implemented by all script handlers
  abstract execute(context: ScriptContext): Promise<void>;
}

// Registry class
class ScriptRegistry {
  private static instance: ScriptRegistry;
  private handlers: Map<string, BaseScriptHandler>;
  private interceptors: Map<string, BaseScriptInterceptor>;
  private handlerNames: Map<BaseScriptHandler, string>;
  private matchedInterceptors: Map<string, { confidence: number; reason: string }> = new Map();

  private constructor() {
    this.handlers = new Map();
    this.interceptors = new Map();
    this.handlerNames = new Map();
  }

  static getInstance(): ScriptRegistry {
    if (!ScriptRegistry.instance) {
      ScriptRegistry.instance = new ScriptRegistry();
    }
    return ScriptRegistry.instance;
  }

  registerHandler(name: string, handler: BaseScriptHandler) {
    this.handlers.set(name, handler);
    this.handlerNames.set(handler, name);
    return this;
  }

  registerInterceptor(interceptor: BaseScriptInterceptor) {
    const config = interceptor.getConfig();
    this.interceptors.set(config.name, interceptor);
    return this;
  }

  getHandler(name: string): BaseScriptHandler | undefined {
    return this.handlers.get(name);
  }

  getAllHandlers(): Map<string, BaseScriptHandler> {
    return new Map(this.handlers);
  }

  setMatchedInterceptors(matches: Array<{ name: string; confidence: number; reason: string }>) {
    this.matchedInterceptors.clear();
    for (const match of matches) {
      this.matchedInterceptors.set(match.name, { 
        confidence: match.confidence,
        reason: match.reason 
      });
    }
  }

  getInterceptorsForScript(scriptName: string, functionName: string): ScriptInterceptorConfig[] {
    const configs: ScriptInterceptorConfig[] = [];
    
    for (const interceptor of this.interceptors.values()) {
      const config = interceptor.getConfig();
      const matchInfo = this.matchedInterceptors.get(config.name);
      
      // Only include interceptors that were matched with sufficient confidence
      if (!matchInfo || matchInfo.confidence < 0.5) continue;

      const matchingHooks = config.hooks.filter(hook => 
        hook.script === scriptName && hook.function === functionName
      );
      
      if (matchingHooks.length > 0) {
        configs.push({ 
          ...config, 
          hooks: matchingHooks,
          confidence: matchInfo.confidence,
          reason: matchInfo.reason
        });
      }
    }

    return configs;
  }

  getAllInterceptors(): Map<string, BaseScriptInterceptor> {
    return new Map(this.interceptors);
  }

  getHandlerName(handler: BaseScriptHandler): string | undefined {
    return this.handlerNames.get(handler);
  }
}

export const scriptRegistry = ScriptRegistry.getInstance();

export abstract class BaseScriptInterceptor {
  abstract readonly context: ScriptInterceptorContext;
  protected executionPlanHooks?: ExecutionPlanHooks;

  // Simplified partial method that just returns the scoped partial reference
  protected partial(scriptName: string, name: string): string {
    const metadata = Reflect.getMetadata(INTERCEPTOR_METADATA_KEY, this.constructor) as ScriptInterceptorMetadata;
    if (!metadata) {
      throw new Error('Interceptor metadata not found. Did you forget to add @ScriptsInterception decorator?');
    }
    return `{{> ${metadata.name}:${scriptName}:${name}}}`;
  }

  getConfig(): ScriptInterceptorConfig {
    const metadata = Reflect.getMetadata(INTERCEPTOR_METADATA_KEY, this.constructor) as ScriptInterceptorMetadata;
    if (!metadata) {
      throw new Error('Interceptor metadata not found. Did you forget to add @ScriptsInterception decorator?');
    }

    // Group hooks by script for validation
    const hooksByScript = metadata.hooks.reduce((acc, hook) => {
      if (!acc[hook.script]) {
        acc[hook.script] = [];
      }
      acc[hook.script].push(hook);
      return acc;
    }, {} as Record<string, InterceptorHook[]>);

    // Validate script contexts and hooked functions
    for (const [scriptName, hooks] of Object.entries(hooksByScript)) {
      const scriptContext = this.context[scriptName];
      if (!scriptContext) {
        throw new Error(`Script ${scriptName} not found in context`);
      }

      for (const hook of hooks) {
        if (!(hook.function in scriptContext)) {
          throw new Error(
            `Function ${hook.function} not found in script ${scriptName} context. ` +
            `Available functions: ${Object.keys(scriptContext).join(", ")}`
          );
        }
      }
    }

    // Register partials with script-scoped names to prevent conflicts
    for (const [scriptName, scriptContext] of Object.entries(this.context)) {
      if (scriptContext.partials) {
        Object.entries(scriptContext.partials).forEach(([name, template]) => {
          const scopedName = `${metadata.name}:${scriptName}:${name}`;
          if (!Handlebars.partials[scopedName]) {
            Handlebars.registerPartial(scopedName, template as string);
          }
        });
      }
    }

    return {
      ...metadata,
      executionPlanHooks: this.executionPlanHooks,
      handlebarsContext: Object.entries(this.context).reduce<Record<string, HandlebarsContextValue>>((acc, [scriptName, scriptContext]) => {
        const values = scriptContext.values || {};
        const transforms = Object.entries(scriptContext)
          .filter(([key]) => key !== 'partials' && key !== 'values')
          .reduce<Record<string, HandlebarsContextValue>>((transformAcc, [functionName, functionContext]) => {
            if (this.isTransformFunction(functionContext)) {
              const transformsObj = functionContext.transforms();
              const transformsTemplate = Object.entries(transformsObj)
                .map(([_key, transforms]) => 
                  transforms.map((t) => t.transform(t.content)).join('\n')
                )
                .join('\n');
              return { ...transformAcc, [`${scriptName}_${functionName}`]: transformsTemplate };
            }
            return transformAcc;
          }, {});

        return { ...acc, ...transforms };
      }, {}),
      templatePartials: Object.entries(this.context).reduce((acc, [scriptName, scriptContext]) => {
        if (scriptContext.partials) {
          return {
            ...acc,
            ...Object.entries(scriptContext.partials).reduce((partialAcc, [name, template]) => ({
              ...partialAcc,
              [`${metadata.name}:${scriptName}:${name}`]: template,
            }), {}),
          };
        }
        return acc;
      }, {} as Record<string, string>),
    };
  }

  // Add a method to get execution hooks for a specific function
  getExecutionHooksForFunction(scriptName: string, functionName: string): ExecutionHooks | undefined {
    const scriptContext = this.context[scriptName];
    if (!scriptContext) return undefined;

    const functionContext = scriptContext[functionName];
    if (!functionContext || !this.isExecutionHooksObject(functionContext)) return undefined;

    return functionContext.executionHooks;
  }

  protected transform = {
    appendAtTheTopOfTag: (tag: string) => (content: string) => {
      return dedent`
        {{#appendXmlLikeContent tag="${tag}"}}
        ${content}
        {{/appendXmlLikeContent}}
      `;
    },
    appendAtTheBottomOfTag: (tag: string) => (content: string) => {
      return dedent`
        {{#appendXmlLikeContent tag="${tag}" position="bottom"}}
        ${content}
        {{/appendXmlLikeContent}}
      `;
    },
    replaceBetweenTagBounds: (tag: string) => (content: string) => {
      return dedent`
        {{#replaceXmlLikeContent tag="${tag}"}}
        ${content}
        {{/replaceXmlLikeContent}}
      `;
    }
  };

  protected isTransformFunction(value: unknown): value is { 
    transforms(): {
      [key: string]: {
        transform: (content: string) => string;
        content: string;
      }[];
    }
  } {
    return typeof value === 'object' && value !== null && 'transforms' in value && typeof (value as any).transforms === 'function';
  }

  protected isExecutionHooksObject(value: unknown): value is {
    executionHooks: ExecutionHooks;
  } {
    return typeof value === 'object' && value !== null && 'executionHooks' in value;
  }

  protected isExecutionPlanHooksObject(value: unknown): value is {
    executionPlanHooks: ExecutionPlanHooks;
  } {
    return typeof value === 'object' && value !== null && 'executionPlanHooks' in value;
  }
}

export function ScriptsInterception(metadata: ScriptInterceptorMetadata): ClassDecorator {
  return function(target: any) {
    // Enhanced validation
    if (!metadata.name || !metadata.description || !metadata.hooks?.length) {
      throw new Error(
        'Invalid interceptor metadata. Required fields: name, description, and at least one hook'
      );
    }

    // Validate hook uniqueness using a more robust approach
    const hookSignatures = new Set<string>();
    for (const hook of metadata.hooks) {
      const signature = `${hook.script}:${hook.function}:${
        typeof hook.messageTarget === 'number' 
          ? hook.messageTarget 
          : `${hook.messageTarget.role}:${hook.messageTarget.index || '*'}`
      }`;

      if (hookSignatures.has(signature)) {
        throw new Error(
          `Duplicate hook found: ${signature}. Each hook must be unique per script/function/target combination.`
        );
      }
      hookSignatures.add(signature);
    }

    Reflect.defineMetadata(INTERCEPTOR_METADATA_KEY, metadata, target);
    return target;
  };
}

// Remove old helpers
Handlebars.unregisterHelper('replace');
Handlebars.unregisterHelper('append');
Handlebars.unregisterHelper('prepend');
