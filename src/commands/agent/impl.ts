import { text, isCancel } from "@clack/prompts";
import { anthropic } from "@ai-sdk/anthropic";
import { generateObject, generateText } from "ai";
import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { intro, outro, spinner, log } from "@clack/prompts";
import { z } from "zod";
import { isNonNullish } from "remeda";
import { readHistory, formatHistoryForLLM } from "../../helpers/history";
import dedent from "dedent";
import { scriptHandlers, type ScriptContext } from "../../scripts-registry";
import fg from "fast-glob";
import { readFileSync, existsSync } from "fs";
import ignore from "ignore";
import { verboseLog } from "../../helpers/logger";

async function getExecutionPipelineContext(cwd: string): Promise<{ [path: string]: { content: string; isGitIgnored: boolean; } }> {
  const ig = ignore();
  
  try {
    const gitignore = readFileSync(join(cwd, '.gitignore'), 'utf-8');
    ig.add(gitignore);
    verboseLog("Loaded .gitignore rules", gitignore);
  } catch {
    verboseLog("No .gitignore found, proceeding without it");
  }

  verboseLog("Starting file scan with fast-glob");
  const files = await fg(['**/*'], {
    cwd,
    dot: true,
    absolute: true,
    ignore: ['.git', 'node_modules'],
    followSymbolicLinks: false
  });
  verboseLog(`Found ${files.length} files`, files);

  const result: { [path: string]: { content: string; isGitIgnored: boolean; } } = {};

  for (const file of files) {
    const relativePath = file.replace(cwd + '/', '');
    try {
      const content = await readFile(file, 'utf-8');
      const isGitIgnored = ig.ignores(relativePath);
      result[relativePath] = {
        content,
        isGitIgnored
      };
      verboseLog(`Processed file: ${relativePath}`, { isGitIgnored });
    } catch (error) {
      console.error(`Failed to read file ${file}:`, error);
      verboseLog(`Failed to read file: ${file}`, error);
    }
  }

  verboseLog("Completed file context gathering", {
    totalFiles: Object.keys(result).length,
    ignoredFiles: Object.entries(result).filter(([, v]) => v.isGitIgnored).length
  });

  return result;
}

const executionPlanSchema = z.object({
  steps: z.array(
    z.object({
      type: z.string(),
      description: z.string(),
      scriptFile: z.string(),
      priority: z.number(),
    })
  ),
  analysis: z.string(),
});

type ExecutionPlan = z.infer<typeof executionPlanSchema>;

type Flags = {
  hidden?: boolean;
};

export default async function ({ hidden }: Flags) {
  try {
    intro("🤖 AI Script Analysis and Execution");

    const response = await text({
      message: "What do you want to do?",
      placeholder: "e.g., add storybook to my project",
    });

    if (isCancel(response)) {
      outro("Operation cancelled");
      return;
    }

    verboseLog("User request", response);
    log.step("Tools loaded successfully");

    const spin = spinner();
    spin.start("Reading project files...");
    const executionPipelineContext = await getExecutionPipelineContext(process.cwd());
    spin.stop("Project files loaded");

    log.step("Analyzing request and generating base execution plan");
    spin.start("Generating base execution plan...");

    try {
      verboseLog("Available scripts", Object.keys(scriptHandlers));
      const historyContext = formatHistoryForLLM(30);
      verboseLog("History context", historyContext);

      const prompt = `
<role>You are a high-level execution planner that determines which scripts should handle different aspects of a request.</role>

<context>
<available-scripts>
${Object.keys(scriptHandlers).map(script => `- ${script}`).join('\n')}
</available-scripts>
${historyContext}
</context>

<output-format>
  <json-schema>
    {
      "steps": [
        {
          "type": "string",
          "description": "string",
          "scriptFile": "string",
          "priority": number
        }
      ],
      "analysis": "string"
    }
  </json-schema>
</output-format>

<rules>
  - Break down complex requests into logical steps
  - Use only scripts from <available-scripts> section
  - Consider past operations from <context> section when planning
  - Assign appropriate scripts to handle each step
  - Consider dependencies between steps when setting priorities
  - Provide clear descriptions for each step
</rules>`;

      verboseLog("Sending prompt to AI", prompt);

      const { object: executionPlan } = await generateObject({
        model: anthropic("claude-3-5-sonnet-20241022"),
        schema: executionPlanSchema,
        messages: [
          {
            role: "system",
            content: prompt,
          },
          {
            role: "user",
            content: response,
          },
        ],
      });

      verboseLog("Received execution plan", executionPlan);
      spin.stop("Base execution plan generated");

      if (executionPlan.steps.length === 0) {
        log.warn("No actions to execute");
        outro("Operation completed");
        return;
      }

      if (executionPlan.analysis) {
        log.info("Base Execution Plan Analysis");
        log.message(executionPlan.analysis);
      }

      const sortedSteps = [...executionPlan.steps].sort((a, b) => a.priority - b.priority);
      verboseLog("Sorted execution steps", sortedSteps);

      for (const step of sortedSteps) {
        const handler = scriptHandlers[step.scriptFile];
        if (!handler) {
          log.warn(`No handler found for script: ${step.scriptFile}`);
          verboseLog("Missing script handler", { scriptFile: step.scriptFile, availableHandlers: Object.keys(scriptHandlers) });
          continue;
        }

        log.step(`Executing: ${step.description}`);
        verboseLog("Starting step execution", step);

        const requiredFiles: { [path: string]: { content: string; isGitIgnored: boolean; } } = {};
        
        if (handler.requirements.requiredFiles) {
          verboseLog("Gathering required files", handler.requirements.requiredFiles);
          for (const file of handler.requirements.requiredFiles) {
            if (executionPipelineContext[file]) {
              requiredFiles[file] = executionPipelineContext[file];
              verboseLog(`Found required file: ${file}`);
            } else {
              verboseLog(`Missing required file: ${file}`);
            }
          }
        }

        if (handler.requirements.requiredFilePatterns) {
          verboseLog("Processing file patterns", handler.requirements.requiredFilePatterns);
          for (const pattern of handler.requirements.requiredFilePatterns) {
            const matchingFiles = Object.entries(executionPipelineContext)
              .filter(([path]) => path.match(new RegExp(pattern)))
              .reduce((acc, [path, content]) => ({ ...acc, [path]: content }), {});
            Object.assign(requiredFiles, matchingFiles);
            verboseLog(`Pattern ${pattern} matched files`, Object.keys(matchingFiles));
          }
        }

        const scriptContext: ScriptContext = {
          rawRequest: response,
          executionPlan,
          files: requiredFiles,
        };

        if (step.scriptFile === 'package-management') {
          const packageJsonPath = join(process.cwd(), 'package.json');
          if (!existsSync(packageJsonPath)) {
            throw new Error("No package.json found in the current directory");
          }
          const packageJsonContent = readFileSync(packageJsonPath, 'utf-8');
          scriptContext.files['package.json'] = { content: packageJsonContent, isGitIgnored: false };
        }

        verboseLog("Executing script with context", {
          script: step.scriptFile,
          filesProvided: Object.keys(requiredFiles),
        });

        await handler.execute(scriptContext);
        verboseLog(`Completed execution of ${step.scriptFile}`);
      }

      outro("All operations completed successfully");
    } catch (error) {
      spin.stop("Error in execution");
      verboseLog("Execution error", error);
      log.error(
        `Failed to execute plan: ${error instanceof Error ? error.message : "Unknown error"}`
      );
      outro("Operation failed");
    }
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === "AbortError" || error.message.includes("cancel")) {
        outro("Operation cancelled");
        return;
      }
      log.error(error.message);
      verboseLog("Fatal error", error);
    }
    outro("Operation failed");
  }
}
