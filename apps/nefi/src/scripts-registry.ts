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

// Metadata keys
const SCRIPT_REQUIREMENTS_KEY = Symbol("script:requirements");
const PROMPT_FUNCTIONS_KEY = Symbol("script:prompt-functions");
const INTERCEPTOR_METADATA_KEY = Symbol("interceptor:metadata");

// Message targeting types
export type MessageTarget = {
  role: Message["role"];
  index?: number;
} | number;

// Interceptor types
export type HookedFunction = {
  hookedFunctionName: string;
  messageTarget: MessageTarget;
};

export type ScriptInterceptorMetadata = {
  name: string;
  description: string;
  meta: {
    [scriptName: string]: HookedFunction[];
  };
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

export interface ScriptInterceptorConfig {
  name: string;
  description: string;
  meta: {
    [scriptName: string]: HookedFunction[];
  };
  handlebarsContext: Record<string, HandlebarsContextValue>;
  templatePartials?: Record<string, string>;
  llmCallIndex?: number;
  constructor?: any;
  executionPlanHooks?: ExecutionPlanHooks;
}

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
      const interceptors = scriptRegistry.getInterceptorsForScript(scriptName, propertyKey.toString());
      
      // Execute beforeExecution hooks
      for (const interceptor of interceptors) {
        const scriptContext = interceptor.handlebarsContext[`${scriptName}_${propertyKey.toString()}`] as HandlebarsContextValue;
        if (typeof scriptContext === 'object' && 'executionHooks' in scriptContext && scriptContext.executionHooks?.beforeExecution) {
          console.log(`[${interceptor.name}] Executing beforeExecution hook for ${String(propertyKey)}`);
          await scriptContext.executionHooks.beforeExecution();
        }
      }

      // Execute the original method
      const result = await originalMethod.apply(this, args);

      // Execute afterExecution hooks
      for (const interceptor of interceptors) {
        const scriptContext = interceptor.handlebarsContext[`${scriptName}_${propertyKey.toString()}`] as HandlebarsContextValue;
        if (typeof scriptContext === 'object' && 'executionHooks' in scriptContext && scriptContext.executionHooks?.afterExecution) {
          console.log(`[${interceptor.name}] Executing afterExecution hook for ${String(propertyKey)}`);
          await scriptContext.executionHooks.afterExecution();
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

  protected processLLMMessages(messages: LLMMessage[], functionName: string): LLMMessage[] {
    const scriptName = scriptRegistry.getHandlerName(this);
    if (!scriptName) {
      console.log('[processLLMMessages] Handler not registered properly');
      return messages;
    }

    const interceptors = scriptRegistry.getInterceptorsForScript(scriptName, functionName);
    
    console.log('[processLLMMessages] Processing messages for:', {
      scriptName,
      functionName,
      interceptorsCount: interceptors.length,
      interceptors: interceptors.map(i => i.name)
    });
    
    // If no interceptors are registered for this function, return messages untouched
    if (interceptors.length === 0) {
      console.log('[processLLMMessages] No interceptors found, returning original messages');
      return messages;
    }

    return messages.map((message, index) => {
      // Process interceptors
      const applicableInterceptors = interceptors.filter(interceptor => {
        const hooks = interceptor.meta[scriptName] || [];
        console.log('[processLLMMessages] Checking interceptor hooks:', {
          interceptorName: interceptor.name,
          scriptName,
          hooks: hooks.map(h => ({
            function: h.hookedFunctionName,
            target: h.messageTarget
          }))
        });
        
        return hooks.some(hook => {
          if (hook.hookedFunctionName !== functionName) return false;
          if (typeof hook.messageTarget === 'number') {
            return hook.messageTarget === index;
          }
          const matches = hook.messageTarget.role === message.role && 
            (hook.messageTarget.index === undefined || hook.messageTarget.index === index);
          
          console.log('[processLLMMessages] Hook match result:', {
            interceptor: interceptor.name,
            hook: hook.hookedFunctionName,
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

  getInterceptorsForScript(scriptName: string, functionName: string): ScriptInterceptorConfig[] {
    const configs: ScriptInterceptorConfig[] = [];
    
    for (const interceptor of this.interceptors.values()) {
      const config = interceptor.getConfig();
      const hooks = config.meta[scriptName] || [];
      
      if (hooks.some(hook => hook.hookedFunctionName === functionName)) {
        configs.push(config);
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

  protected partial(this: BaseScriptInterceptor, scriptName: string, name: string) {
    const scriptContext = this.context[scriptName];
    if (!scriptContext || !scriptContext.partials || !(name in scriptContext.partials)) {
      throw new Error(`Partial ${name} not found in script ${scriptName}`);
    }
    return `{{> ${scriptName}_${name}}}`;
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

  getConfig(): ScriptInterceptorConfig {
    const metadata = Reflect.getMetadata(INTERCEPTOR_METADATA_KEY, this.constructor) as ScriptInterceptorMetadata;
    if (!metadata) {
      throw new Error('Interceptor metadata not found. Did you forget to add @ScriptsInterception decorator?');
    }

    // Validate that all hooked functions exist in context
    for (const [scriptName, hooks] of Object.entries(metadata.meta)) {
      const scriptContext = this.context[scriptName];
      if (!scriptContext) {
        throw new Error(`Script ${scriptName} not found in context`);
      }

      for (const hook of hooks) {
        if (!(hook.hookedFunctionName in scriptContext)) {
          throw new Error(`Function ${hook.hookedFunctionName} not found in script ${scriptName} context`);
        }
      }
    }

    // Register partials if they exist
    for (const [scriptName, scriptContext] of Object.entries(this.context)) {
      if (scriptContext.partials) {
        Object.entries(scriptContext.partials).forEach(([name, template]) => {
          Handlebars.registerPartial(`${scriptName}_${name}`, template as string);
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
            if (this.isExecutionHooksObject(functionContext)) {
              return { ...transformAcc, [`${scriptName}_${functionName}`]: { executionHooks: functionContext.executionHooks } };
            }
            return transformAcc;
          }, {});

        // Convert values to HandlebarsContextValue
        const handlebarsValues = Object.entries(values).reduce<Record<string, HandlebarsContextValue>>((valuesAcc, [key, value]) => {
          if (typeof value === 'string') {
            return { ...valuesAcc, key: value };
          }
          // Skip function values as they're not compatible with HandlebarsContextValue
          return valuesAcc;
        }, {});

        return { ...acc, ...handlebarsValues, ...transforms };
      }, {}),
      templatePartials: Object.entries(this.context).reduce((acc, [scriptName, scriptContext]) => {
        if (scriptContext.partials) {
          return {
            ...acc,
            ...Object.entries(scriptContext.partials).reduce((partialAcc, [name, template]) => ({
              ...partialAcc,
              [`${scriptName}_${name}`]: template,
            }), {}),
          };
        }
        return acc;
      }, {} as Record<string, string>),
    };
  }
}

export function ScriptsInterception(metadata: ScriptInterceptorMetadata): ClassDecorator {
  return function(target: any) {
    // Validate metadata at decoration time
    if (!metadata.name || !metadata.description || !metadata.meta) {
      throw new Error('Invalid interceptor metadata');
    }

    // Validate that each script has unique hooked functions
    for (const [scriptName, hooks] of Object.entries(metadata.meta)) {
      const functionNames = new Set<string>();
      for (const hook of hooks) {
        if (functionNames.has(hook.hookedFunctionName)) {
          throw new Error(`Duplicate hooked function ${hook.hookedFunctionName} in script ${scriptName}`);
        }
        functionNames.add(hook.hookedFunctionName);
      }
    }

    Reflect.defineMetadata(INTERCEPTOR_METADATA_KEY, metadata, target);
    return target;
  };
}

// Remove old helpers
Handlebars.unregisterHelper('replace');
Handlebars.unregisterHelper('append');
Handlebars.unregisterHelper('prepend');
