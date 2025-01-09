import { text, isCancel, confirm } from "@clack/prompts";
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
import micromatch from "micromatch";
import { execa } from "execa";
import { xml } from "../../helpers/xml";

// Files and patterns to exclude from initial reading
const EXCLUDED_PATTERNS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/package-lock.json",
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
  "**/*.jpg",
  "**/*.png",
  "**/*.svg",
  "**/*.jpeg",
  "**/*.avif",
];

function getLegibleFirstName(fullName: string) {
  return fullName.split(" ")[0];
}

async function getSystemUserName() {
  const [{ stdout: gitConfigUserName }, { stdout: systemUserName }] =
    await Promise.all([
      execa("git", ["config", "user.name"], { encoding: "utf8" }),
      execa("whoami", undefined, { encoding: "utf8" }),
    ]);

  if (!!gitConfigUserName) {
    return getLegibleFirstName(gitConfigUserName);
  }

  if (!!systemUserName) {
    return getLegibleFirstName(systemUserName);
  }

  return "nefi user";
}

async function getExecutionPipelineContext(
  cwd: string,
): Promise<{ [path: string]: { content: string; isGitIgnored: boolean } }> {
  const ig = ignore();

  try {
    const gitignore = readFileSync(join(cwd, ".gitignore"), "utf-8");
    ig.add(gitignore);
    verboseLog("Loaded .gitignore rules", gitignore);
  } catch {
    verboseLog("No .gitignore found, proceeding without it");
  }

  verboseLog("Starting file scan with fast-glob");
  const files = await fg(["**/*"], {
    cwd,
    dot: true,
    absolute: true,
    ignore: EXCLUDED_PATTERNS,
    followSymbolicLinks: false,
  });
  verboseLog(`Found ${files.length} files`, files);

  const result: { [path: string]: { content: string; isGitIgnored: boolean } } =
    {};

  for (const file of files) {
    const relativePath = file.replace(cwd + "/", "");
    try {
      const content = await readFile(file, "utf-8");
      const isGitIgnored = ig.ignores(relativePath);
      result[relativePath] = {
        content,
        isGitIgnored,
      };
      verboseLog(`Processed file: ${relativePath}`, { isGitIgnored });
    } catch (error) {
      console.error(`Failed to read file ${file}:`, error);
      verboseLog(`Failed to read file: ${file}`, error);
    }
  }

  verboseLog("Completed file context gathering", {
    totalFiles: Object.keys(result).length,
    ignoredFiles: Object.entries(result).filter(([, v]) => v.isGitIgnored)
      .length,
  });

  return result;
}

const executionPlanSchema = z.object({
  steps: z.array(
    z.object({
      type: z.string(),
      description: z.string(),
      scriptFile: z.enum(["package-management", "file-management", "version-control-management"]),
      priority: z.number(),
    }),
  ),
  analysis: z.string(),
});

type ExecutionPlan = z.infer<typeof executionPlanSchema>;

type Flags = {
  hidden?: boolean;
};

type ExecutionContext = {
  [path: string]: {
    content: string;
    isGitIgnored: boolean;
  };
};

interface AgentCommandOptions {
  flags: {
    hidden?: boolean;
  };
  initialResponse?: string;
  context?: ExecutionContext;
}

function createSystemPrompt() {
  return xml.build({
    role: {
      "#text":
        "You are a high-level execution planner that determines which scripts should handle different aspects of the request. You strictly follow defined rules with no exceptions. Do not hallucinate",
    },
    available_scripts: {
      script: [
        {
          "@_name": "version-management",
          script_specific_rule:
            "This script should be the first priority in most of the cases",
        },
        {
          "@_name": "file-management",
          script_specific_rule:
            "When predicting which files or parts of the codebase should be modified prefer to not split the file modification into multiple script calls. It is way better to do everything at once.",
        },
        {
          "@_name": "version-control-management",
          script_specific_rule: "This script should ALWAYS be the last one.",
        },
      ],
    },
    rules: [
      "User's request is provided in <user_request> section",
      "Break down complex requests into logical steps",
      "ONLY use scripts from <available_scripts> section, respecting their rules specified as child section called <script_specific_rule>",
      "Consider dependencies between steps when setting priorities",
      "Provide clear description for each step",
      "As a helper information (It is not a solid knowledge base, you SHOULD NOT RELY on it fully), refer to further provided <history> section. It contains explanation what was done in the past along with explanation of the schema (the way history is written), under child section <schema>, for the LLM",
    ],
    knowledge: [
      "Most packages require configuration changes in addition to installation",
      "Package installations should be paired with corresponding file changes",
      "Always consider both direct and indirect configuration needs.",
    ],
  });
}

export async function agentCommand({
  flags,
  initialResponse,
  context,
}: AgentCommandOptions): Promise<void> {
  try {
    if (!initialResponse) {
      intro(`Hello, ${await getSystemUserName()}!`);
    }

    const userInput =
      initialResponse ??
      (await text({
        message: "What do you want to do?",
        placeholder: "e.g., add storybook to my project",
      }));

    if (isCancel(userInput)) {
      outro("Operation cancelled");
      return;
    }

    let executionPipelineContext = context;

    if (!executionPipelineContext) {
      const spin = spinner();
      spin.start("Reading project files for analysis...");
      executionPipelineContext = await getExecutionPipelineContext(
        process.cwd(),
      );
      spin.stop("Project files loaded");

      verboseLog("User request", userInput);
      log.step("Tools loaded successfully");
      log.step("Analyzing request and generating base execution plan");
    }

    const spin = spinner();
    spin.start(
      initialResponse
        ? "Regenerating execution plan based on your feedback..."
        : "Generating base execution plan...",
    );

    try {
      const historyContext = formatHistoryForLLM(5);
      verboseLog("History context:", historyContext);

      const {
        object: executionPlan,
        usage: executionPlanGenerationUsage,
        experimental_providerMetadata: executionPlanGenerationMetadata,
      } = await generateObject({
        model: anthropic("claude-3-5-sonnet-20241022", {
          cacheControl: true,
        }),
        schema: executionPlanSchema,
        messages: [
          {
            role: "system",
            content: createSystemPrompt(),
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: xml.build({
                  user_request: {
                    "#text": userInput,
                  },
                }),
              },
              {
                type: "text",
                text: historyContext,
                experimental_providerMetadata: {
                  anthropic: {
                    cacheControl: { type: "ephemeral" },
                  },
                },
              },
            ],
          },
        ],
      });

      verboseLog("Received execution plan", executionPlan);
      verboseLog("Execution plan generation usage:", {
        ...executionPlanGenerationUsage,
        executionPlanGenerationMetadata,
      });

      spin.stop("Base execution plan generated");

      const MAX_REGENERATION_ATTEMPTS = 3;
      let regenerationAttempts = 0;

      async function regenerateExecutionPlan(
        userFeedbackInput: string,
        previousPlan: any,
      ): Promise<{
        updatedExecutionPlan: any;
        updatedExecutionPlanUsage: any;
        updatedExecutionPlanGenerationMetadata: any;
      }> {
        const {
          object: updatedExecutionPlan,
          usage: updatedExecutionPlanUsage,
          experimental_providerMetadata: updatedExecutionPlanGenerationMetadata,
        } = await generateObject({
          model: anthropic("claude-3-5-sonnet-20241022", {
            cacheControl: true,
          }),
          schema: executionPlanSchema,
          messages: [
            {
              role: "system",
              content: createSystemPrompt(),
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: xml.build({
                    user_request: {
                      "#text": userInput,
                    },
                  }),
                },
                {
                  type: "text",
                  text: historyContext,
                  experimental_providerMetadata: {
                    anthropic: {
                      cacheControl: { type: "ephemeral" },
                    },
                  },
                },
              ],
            },
            {
              role: "assistant",
              content: xml.build({
                role: {
                  "#text":
                    "You are an assistant responsible for correcting/tweaking/adjusting the high-level execution plan generated from previous steps of my pipeline basing on user's new request. You strictly follow defined rules with no exceptions. Do not hallucinate",
                },
                rules: [
                  "User's request to modify the base execution plan with feedback is declared in <user_request_feedback> section",
                  "Previous execution plan is declared in <previous_execution_plan> section. All user requests related to: changing the order of the steps, removing steps, adding new steps, changing theirs instructions (both explicitly and implicitly) should ONLY and PRECISELY operate on the <previous_execution_plan> section data. Do not hallucinate",
                  "If user demands to remove some of the step of the <previous_execution_plan> by calling the script name, follow the available scripts defined in <available_scripts> section. ",
                  "You must recognize to e.g. remove the version-control-management execution plan step if user demands to 'remove step related to version control'.",
                  "You must match the scripts referenced by user's demand regardless of the naming convention (kebab-case, snake_case, PascalCase, camelCase, SHOUTING_SNAKE_CASE) or just regardless of the spaces between words."
                  
                ],
                previous_execution_plan: {
                  "#text": JSON.stringify(previousPlan, null, 2),
                },
              }),
            },
            {
              role: "user",
              content: xml.build({
                user_request_feedback: {
                  "#text": userFeedbackInput,
                },
              }),
            },
          ],
        });

        return {
          updatedExecutionPlan,
          updatedExecutionPlanUsage,
          updatedExecutionPlanGenerationMetadata,
        };
      }

      let currentPlan = executionPlan;
      while (regenerationAttempts < MAX_REGENERATION_ATTEMPTS) {
        if (currentPlan.steps.length === 0) {
          if (existsSync(join(process.cwd(), "package.json"))) {
            log.warn("No actions to execute");
          } else {
            log.warn("No package.json found and no actions to execute");
          }
          outro("Operation completed");
          return;
        }

        if (currentPlan.analysis) {
          log.info("Execution Plan Analysis");
          log.message(currentPlan.analysis);
        }

        log.info("\nProposed Execution Steps:");
        for (const [index, step] of currentPlan.steps.entries()) {
          if (!flags.hidden) {
            log.message(
              `${index + 1}. ${step.description} (using ${step.scriptFile})`,
            );
          }
        }

        const shouldContinue = await confirm({
          message: "Is this what you want to do?",
        });

        if (isCancel(shouldContinue)) {
          outro("Operation cancelled");
          return;
        }

        if (!shouldContinue) {
          regenerationAttempts++;

          if (regenerationAttempts >= MAX_REGENERATION_ATTEMPTS) {
            outro("It seems that our proposed solution wasn't fully suited for your needs :( Please start nefi again and try to provide more detailed description");
            return;
          }

          const userFeedbackInput = await text({
            message: "Please provide additional instructions to adjust the plan:",
            placeholder: "e.g., skip step number 1, use a different approach",
          });

          if (isCancel(userFeedbackInput)) {
            outro("Operation cancelled");
            return;
          }

          spin.start("Regenerating execution plan based on your feedback...");

          const {
            updatedExecutionPlan,
            updatedExecutionPlanUsage,
            updatedExecutionPlanGenerationMetadata,
          } = await regenerateExecutionPlan(userFeedbackInput, currentPlan);

          spin.stop("Updated execution plan generated");

          verboseLog("Updated execution plan generation usage:", {
            ...updatedExecutionPlanUsage,
            updatedExecutionPlanGenerationMetadata,
          });

          currentPlan = updatedExecutionPlan;
          continue;
        }

        // User approved the plan, execute it
        const sortedSteps = [...currentPlan.steps].sort(
          (a, b) => a.priority - b.priority,
        );
        verboseLog("Sorted execution steps", sortedSteps);

        for (const step of sortedSteps) {
          const handler = scriptHandlers[step.scriptFile];
          if (!handler) {
            log.warn(`No handler found for script: ${step.scriptFile}`);
            verboseLog("Missing script handler", {
              scriptFile: step.scriptFile,
              availableHandlers: Object.keys(scriptHandlers),
            });
            continue;
          }

          log.step(`Executing: ${step.description}`);
          verboseLog("Starting step execution", step);

          const requiredFiles: {
            [path: string]: { content: string; isGitIgnored: boolean };
          } = {};

          if (handler.requirements) {
            if (
              "requiredFiles" in handler.requirements &&
              handler.requirements.requiredFiles
            ) {
              verboseLog(
                "Gathering required files",
                handler.requirements.requiredFiles,
              );
              for (const file of handler.requirements.requiredFiles) {
                if (executionPipelineContext[file]) {
                  requiredFiles[file] = executionPipelineContext[file];
                  verboseLog(`Found required file: ${file}`);
                } else {
                  verboseLog(`Missing required file: ${file}`);
                }
              }
            } else if (
              "requiredFilePatterns" in handler.requirements &&
              handler.requirements.requiredFilePatterns
            ) {
              verboseLog(
                "Processing file patterns",
                handler.requirements.requiredFilePatterns,
              );
              const paths = Object.keys(executionPipelineContext);

              // First, apply required patterns
              for (const pattern of handler.requirements.requiredFilePatterns) {
                const matchingPaths = micromatch(paths, pattern);
                const matchingFiles = matchingPaths.reduce(
                  (acc, path) => ({
                    ...acc,
                    [path]: executionPipelineContext[path],
                  }),
                  {},
                );
                Object.assign(requiredFiles, matchingFiles);
                verboseLog(`Pattern ${pattern} matched files`, matchingPaths);
              }

              // Then exclude files based on excluded patterns if any exist
              if (
                "excludedFilePatterns" in handler.requirements &&
                handler.requirements.excludedFilePatterns
              ) {
                verboseLog(
                  "Processing excluded patterns",
                  handler.requirements.excludedFilePatterns,
                );
                const excludedPaths = micromatch(
                  Object.keys(requiredFiles),
                  handler.requirements.excludedFilePatterns,
                );

                // Remove excluded files from requiredFiles
                for (const path of excludedPaths) {
                  delete requiredFiles[path];
                }
                verboseLog("Files after exclusion", Object.keys(requiredFiles));
              }
            }
          }

          const scriptContext: ScriptContext = {
            rawRequest: userInput,
            executionPlan: currentPlan,
            files: requiredFiles,
          };

          if (step.scriptFile === "package-management") {
            const packageJsonPath = join(process.cwd(), "package.json");
            if (!existsSync(packageJsonPath)) {
              throw new Error("No package.json found in the current directory");
            }
            const packageJsonContent = readFileSync(packageJsonPath, "utf-8");
            scriptContext.files["package.json"] = {
              content: packageJsonContent,
              isGitIgnored: false,
            };
          }

          verboseLog("Executing script with context", {
            script: step.scriptFile,
            filesProvided: Object.keys(requiredFiles),
          });

          await handler.execute(scriptContext);
          verboseLog(`Completed execution of ${step.scriptFile}`);
        }

        outro("All operations completed successfully");
        return;
      }
    } catch (error) {
      spin.stop("Error in execution");
      verboseLog("Execution error", error);
      outro(`Error during execution: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return;
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
    return;
  }
}
