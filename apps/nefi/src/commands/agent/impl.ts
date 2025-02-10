import { anthropic } from "@ai-sdk/anthropic";
import {
  confirm,
  intro,
  isCancel,
  log,
  outro,
  spinner,
  text,
} from "@clack/prompts";
import { generateObject } from "ai";
import dedent from "dedent";
import { execa } from "execa";
import fg from "fast-glob";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import ignore from "ignore";
import micromatch from "micromatch";
import path, { join } from "path";
import pc from "picocolors";
import { z } from "zod";
import { formatHistoryForLLM } from "../../helpers/history";
import { createDetailedLogger } from "../../helpers/logger";
import * as R from "remeda";
import {
  projectFilePath,
  projectFiles,
  type ProjectFiles,
} from "../../helpers/project-files";
import { xml } from "../../helpers/xml";
import { scriptRegistry, type ScriptContext } from "../../scripts-registry";
import { PackageManagementHandler } from "../../scripts/package-management";
import { FileModifierHandler } from "../../scripts/file-modifier";
import { GitOperationsHandler } from "../../scripts/git-operations";
import { HelloInterceptor } from "../../scripts/interceptors/hello.interceptor";

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

const USER_INPUT_SUGGESTIONS = [
  "remove storybook from my project",
  "add million.js to my project",
  "install and configure opentelemetry using @vercel/otel package",
  "install biome as new linter and formatter and remove prettier",
];

// Define available interceptors enum based on registered interceptors
const AVAILABLE_INTERCEPTORS = ["hello"] as const;
type AvailableInterceptor = typeof AVAILABLE_INTERCEPTORS[number];

const executionPlanSchema = z.object({
  steps: z.array(
    z.object({
      description: z.string(),
      scriptFile: z.enum([
        "package-management",
        "file-modifier",
        "git-operations",
      ]),
      priority: z.number(),
      interceptors: z.array(z.object({
        name: z.enum(AVAILABLE_INTERCEPTORS),
        description: z.string(),
        reason: z.string().describe("Explanation why this interceptor matches the user's request"),
      })).optional(),
    })
  ),
  analysis: z.string(),
});

type AgentCommandOptions = {
  initialResponse?: string;
  previousExecutionContext?: {
    files: ProjectFiles;
  };
  clipanionContext: Partial<{
    usage: boolean;
    verbose: boolean;
    force: boolean;
  }>;
};

export async function agentCommand({
  initialResponse,
  previousExecutionContext,
  clipanionContext,
}: AgentCommandOptions) {
  // Register handlers at the start of execution
  scriptRegistry.registerHandler(
    "package-management",
    new PackageManagementHandler()
  );

  const fileModifierHandler = new FileModifierHandler();
  scriptRegistry.registerHandler("file-modifier", fileModifierHandler);
  scriptRegistry.registerHandler("git-operations", new GitOperationsHandler());

  // Register interceptors at the registry level
  scriptRegistry.registerInterceptor(new HelloInterceptor());

  const detailedLogger = createDetailedLogger({ ...clipanionContext });

  try {
    if (!clipanionContext.force && !(await isGitWorkingTreeClean())) {
      return;
    }

    if (clipanionContext.force) {
      log.info("Skipped checking if the git working tree is clean");
    }

    const userInput =
      initialResponse ??
      (await text({
        message: "What do you want to do?",
        placeholder: `e.g. ${USER_INPUT_SUGGESTIONS[Math.floor(Math.random() * USER_INPUT_SUGGESTIONS.length)]}`,
      }));

    if (isCancel(userInput)) {
      outro("Operation cancelled");
      return;
    }

    const executionPipelineContext = await getExecutionContext(
      previousExecutionContext
    );

    log.step("Analyzing request and generating base execution plan");

    // Check for execution plan hooks
    const allInterceptors = Array.from(scriptRegistry.getAllInterceptors().values());
    for (const interceptor of allInterceptors) {
      const config = interceptor.getConfig();
      if (config.executionPlanHooks?.beforePlanDetermination) {
        const { shouldContinue, message } = await config.executionPlanHooks.beforePlanDetermination();
        if (!shouldContinue) {
          if (message) {
            log.info(message);
          }
          outro("Operation cancelled by interceptor");
          return;
        }
      }
    }

    const spin = spinner();
    spin.start(
      initialResponse
        ? "Regenerating execution plan based on your feedback..."
        : "Generating base execution plan..."
    );

    try {
      const historyContext = formatHistoryForLLM(5);
      detailedLogger.verboseLog("History context:", historyContext);

      const {
        object: executionPlan,
        usage: executionPlanGenerationUsage,
        experimental_providerMetadata: executionPlanGenerationMetadata,
      } = await generateObject({
        model: anthropic("claude-3-5-sonnet-latest", {
          cacheControl: true,
        }),
        schema: executionPlanSchema,
        messages: [
          {
            role: "system",
            content: dedent`
              You are a high-level execution planner that determines which scripts should handle different aspects of the request.
              You strictly follow rules defined in <rules> section with no exceptions. Specific scripts may have their own specific rules
              which affect the output drastically and should be taken as a priority before general rules.
              The rules are defined in <available_scripts> section and <script_specific_rules> subsection. Do not hallucinate

              ${createSystemPrompt()}
            `,
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: xml.build({
                  files: {
                    file: Object.keys(executionPipelineContext.files),
                  },
                }),
              },
              {
                type: "text",
                text: historyContext,
              },
            ],

            experimental_providerMetadata: {
              anthropic: {
                cacheControl: { type: "ephemeral" },
              },
            },
          },
          {
            role: "user",
            content: xml.build({
              user_request: {
                "#text": userInput,
              },
            }),
          },
        ],
      });

      detailedLogger.verboseLog("Received execution plan", executionPlan);

      detailedLogger.usageLog("Execution plan generation usage:", {
        usage: executionPlanGenerationUsage,
        experimental_providerMetadata: executionPlanGenerationMetadata,
      });

      spin.stop("Base execution plan generated");

      // Check for interceptors that need to be removed based on user input
      const allInterceptors = Array.from(scriptRegistry.getAllInterceptors().values());
      for (const interceptor of allInterceptors) {
        const config = interceptor.getConfig();
        if (config.executionPlanHooks?.afterPlanDetermination) {
          // Check if this interceptor is used in any step
          const isInterceptorUsed = executionPlan.steps.some(
            step => step.interceptors?.some(int => int.name === config.name)
          );

          if (isInterceptorUsed) {
            const { shouldKeepInterceptor, message } = await config.executionPlanHooks.afterPlanDetermination(executionPlan);
            
            if (!shouldKeepInterceptor) {
              // Remove this interceptor from all steps
              executionPlan.steps = executionPlan.steps.map(step => ({
                ...step,
                interceptors: step.interceptors?.filter(int => int.name !== config.name)
              }));

              if (message) {
                log.info(message);
              }
            }
          }
        }
      }

      const MAX_REGENERATION_ATTEMPTS = 3;
      let regenerationAttempts = 0;

      async function regenerateExecutionPlan(
        userFeedbackInput: string,
        previousPlan: any
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
              content: dedent`
              You are a high-level execution planner that determines which scripts should handle different aspects of the request.

              You strictly follow rules defined in <rules> section with no exceptions. Specific scripts may have their own specific rules
              which affect the output drastically and should be taken as a priority before general rules.
              The rules are defined in <available_scripts> section and <script_specific_rules> subsection. Do not hallucinate

              ${createSystemPrompt()}
            `,
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: xml.build({
                    files: {
                      file: Object.keys(executionPipelineContext.files),
                    },
                  }),
                },
                {
                  type: "text",
                  text: historyContext,
                },
              ],

              experimental_providerMetadata: {
                anthropic: {
                  cacheControl: { type: "ephemeral" },
                },
              },
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
                  "You must recognize to e.g. remove the git-operations execution plan step if user demands to 'remove step related to version control'.",
                  "You must match the scripts referenced by user's demand regardless of the naming convention (kebab-case, snake_case, PascalCase, camelCase, SHOUTING_SNAKE_CASE) or just regardless of the spaces between words.",
                ],
                previous_execution_plan: {
                  "#text": JSON.stringify(previousPlan, null, 2),
                },
              }),
              // TODO: Is this effective here?
              experimental_providerMetadata: {
                anthropic: {
                  cacheControl: { type: "ephemeral" },
                },
              },
            },
            {
              role: "user",
              content: xml.build({
                user_request: {
                  "#text": userInput,
                },
              }),

              experimental_providerMetadata: {
                anthropic: {
                  cacheControl: { type: "ephemeral" },
                },
              },
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
          const interceptorsInfo = step.interceptors?.length 
            ? pc.gray(`\n    Interceptors:${step.interceptors.map(int => 
                `\n    - ${int.name}: ${int.description}\n      Reason: ${int.reason}`
              ).join('')}`)
            : "";
          log.message(
            `${pc.bgWhiteBright(" " + pc.black(pc.bold(index + 1)) + " ")} ${step.description} ${pc.gray("(using ")}${pc.gray(step.scriptFile)}${pc.gray(")")}${interceptorsInfo}`
          );
        }

        const shouldContinue = await confirm({
          message: `Is this what you want to do? ${pc.gray("p.s. you can refine the execution plan :)")}`,
        });

        if (isCancel(shouldContinue)) {
          outro("Operation cancelled");
          return;
        }

        if (!shouldContinue) {
          regenerationAttempts++;

          if (regenerationAttempts >= MAX_REGENERATION_ATTEMPTS) {
            outro(
              "It seems that our proposed solution wasn't fully suited for your needs :( Please start nefi again and try to provide more detailed description"
            );
            return;
          }

          const userFeedbackInput = await text({
            message:
              "Please provide additional instructions to adjust the plan:",
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

          detailedLogger.usageLog("Updated execution plan generation usage:", {
            usage: updatedExecutionPlanUsage,
            experimental_providerMetadata:
              updatedExecutionPlanGenerationMetadata,
          });

          currentPlan = updatedExecutionPlan;
          continue;
        }

        // User approved the plan, execute it
        const sortedSteps = [...currentPlan.steps].sort(
          (a, b) => a.priority - b.priority
        );
        detailedLogger.verboseLog("Sorted execution steps", sortedSteps);

        for (const step of sortedSteps) {
          const handler = scriptRegistry.getHandler(step.scriptFile);
          if (!handler) {
            log.warn(`No handler found for script: ${step.scriptFile}`);
            detailedLogger.verboseLog("Missing script handler", {
              scriptFile: step.scriptFile,
              availableHandlers: Array.from(
                scriptRegistry.getAllHandlers().keys()
              ),
            });
            continue;
          }

          log.step(`Executing: ${step.description}`);
          detailedLogger.verboseLog("Starting step execution", step);

          const requiredFiles = projectFiles({});

          if (handler.getRequirements()) {
            const requirements = handler.getRequirements();
            if (
              "requiredFilesByPath" in requirements &&
              requirements.requiredFilesByPath
            ) {
              detailedLogger.verboseLog(
                "Gathering required files",
                requirements.requiredFilesByPath
              );
              for (const fileToRequirePath of requirements.requiredFilesByPath) {
                if (
                  executionPipelineContext.files[
                    projectFilePath(fileToRequirePath)
                  ]
                ) {
                  requiredFiles[fileToRequirePath] =
                    executionPipelineContext.files[fileToRequirePath];

                  detailedLogger.verboseLog(
                    `Found required file: ${fileToRequirePath}`
                  );
                } else {
                  detailedLogger.verboseLog(
                    `Missing required file: ${fileToRequirePath}`
                  );
                }
              }
            } else if (
              "requiredFilesByPathWildcard" in requirements &&
              requirements.requiredFilesByPathWildcard
            ) {
              detailedLogger.verboseLog(
                "Processing file patterns",
                requirements.requiredFilesByPathWildcard
              );
              const paths = Object.keys(executionPipelineContext.files);

              for (const pattern of requirements.requiredFilesByPathWildcard) {
                const matchingPaths = micromatch(paths, pattern);
                const matchingFiles = matchingPaths.reduce(
                  (acc, path) => ({
                    ...acc,
                    [path]:
                      executionPipelineContext.files[projectFilePath(path)],
                  }),
                  {}
                );
                Object.assign(requiredFiles, matchingFiles);
                detailedLogger.verboseLog(
                  `Pattern ${pattern} matched files`,
                  matchingPaths
                );
              }

              if (
                "excludedFilesByPathWildcard" in requirements &&
                requirements.excludedFilesByPathWildcard
              ) {
                detailedLogger.verboseLog(
                  "Processing excluded patterns",
                  requirements.excludedFilesByPathWildcard
                );
                const excludedPaths = micromatch(
                  Object.keys(requiredFiles),
                  requirements.excludedFilesByPathWildcard
                );

                for (const path of excludedPaths) {
                  delete requiredFiles[projectFilePath(path)];
                }
                detailedLogger.verboseLog(
                  "Files after exclusion",
                  Object.keys(requiredFiles)
                );
              }
            }
          }

          const scriptContext: ScriptContext = {
            userRequest: userInput,
            executionPlan: currentPlan,
            executionStepDescription: step.description,
            files: requiredFiles,
            detailedLogger,
          };

          detailedLogger.verboseLog("Executing script with context", {
            script: step.scriptFile,
            filesProvided: Object.keys(requiredFiles),
          });

          await handler.execute(scriptContext);
          detailedLogger.verboseLog(
            `Completed execution of ${step.scriptFile}`
          );
        }

        outro("All operations completed successfully");
        return;
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.toLowerCase().includes("billing")
      ) {
        log.error(
          "Unfortunately, your credit balance is too low to access the Anthropic API."
        );
        log.info(
          `You can go to Plans & Billing section of the ${pc.bold("https://console.anthropic.com/")} to upgrade or purchase credits.`
        );
        outro("See you later fellow developer o/");
        return;
      }
      outro(
        `Error during execution: ${error instanceof Error ? error.message : "Unknown error"}`
      );
      return;
    }
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === "AbortError" || error.message.includes("cancel")) {
        outro("Operation cancelled");
        return;
      }
      log.error(error.message);
      detailedLogger.verboseLog("Fatal error", error);
    }
    outro("Operation failed");
    return;
  }

  async function readProjectFiles(cwd: string) {
    const gitignorer = ignore();

    try {
      const gitignoreFile = await readFile(path.join("cwd", ".gitignore"), {
        encoding: "utf-8",
      });
      gitignorer.add(gitignoreFile);

      detailedLogger.verboseLog("Loaded .gitignore rules", gitignoreFile);
    } catch {
      // Unlikely to happen as we are designing this tool only in scope
      // of next-enterprise repository
      detailedLogger.verboseLog("No .gitignore found, proceeding without it");
    }

    detailedLogger.verboseLog("Starting file paths scan with fast-glob");

    const filePaths = await fg(["**/*"], {
      cwd,
      dot: true,
      absolute: true,
      ignore: EXCLUDED_PATTERNS,
      followSymbolicLinks: false,
    });

    detailedLogger.verboseLog(`Found ${filePaths.length} paths`, filePaths);

    return Object.fromEntries(
      // TODO: Change to allSettled?
      await Promise.all(
        filePaths.map(async (filePath) => {
          const relativeFilePath = filePath.split(process.cwd())[1].slice(1);
          const fileContent = await readFile(path.resolve(relativeFilePath), {
            encoding: "utf-8",
          });
          return [relativeFilePath, fileContent];
        })
      )
    ) as ProjectFiles;
  }

  async function getExecutionContext(
    previousExecutionContext: AgentCommandOptions["previousExecutionContext"]
  ) {
    if (
      R.isNullish(previousExecutionContext) ||
      R.isEmpty(previousExecutionContext)
    ) {
      const spin = spinner();
      spin.start("Reading project files for analysis...");

      const files = await readProjectFiles(process.cwd());

      spin.stop("Project files loaded");

      return { files };
    }
    return previousExecutionContext;
  }

  function createSystemPrompt() {
    // Gather all registered handlers and their interceptors
    const handlers = Array.from(scriptRegistry.getAllHandlers().entries());
    const scriptsWithInterceptors = handlers.map(([name, handler]) => {
      const interceptors = handler.getAllInterceptorsLLMRelevantMetadata();
      return {
        name,
        interceptors
      };
    });

    return xml.build({
      available_scripts: {
        script: scriptsWithInterceptors.map(script => ({
          "@_name": script.name,
          script_specific_rules: {
            rule: [
              script.name === "version-management" && "This script must ALWAYS be the first priority",
              script.name === "file-modifier" && [
                "Analyze the needs basing of the files' paths existing in the project, supplied in <files_paths> section",
                "When predicting which files or parts of the codebase should be modified prefer to split the file modification into multiple script calls.",
                "Do include files or parts of the codebase ONLY ONCE without duplicate steps referring to the same modification.",
              ],
              script.name === "git-operations" && [
                "This must ONLY be used for GIT version control management system's specific operations and `git-operations` script entries must ALWAYS be the last one in the execution plan",
                "The script usage must be separated into multiple steps -> FIRST step is branch creating, SECOND is commit the changes",
              ]
            ].flat().filter(Boolean),
          },
          interceptors: script.interceptors.length > 0 ? {
            interceptor: script.interceptors.map(int => ({
              "@_name": int.name,
              "@_description": int.description,
              "#text": dedent`
                ${int.description}
                
                IMPORTANT: This is a registered interceptor that can be referenced by name: "${int.name}".
                When using this interceptor in the execution plan:
                - Use EXACTLY this name: "${int.name}"
                - Use EXACTLY this description: "${int.description}"
                - Only provide a custom reason explaining why this interceptor matches the current task
                
                This interceptor can be used when:
                - The user's request matches the interceptor's purpose
                - The interceptor's functionality aligns with the step's goals
                - The interceptor's description suggests it can help with the current task
              `
            }))
          } : undefined
        })),
      },
      rules: {
        rule: [
          "User's request is provided in <user_request> section",
          "The execution plan is kind of priority list in array format. First item -> top priority script, the last one -> last priority script.",
          "Break down complex requests into multiple logical steps and provide clear description for each step. Avoid duplicating the same steps and always follow SEPARATION OF CONCERNS (e.g. if user wants to remove storybook files, clearly describe that one step is for removing all storybook files and another one is for removing storybook 'scripts' from package.json and the third step is removing the GitHub Actions for deploying storybook)",
          "Consider dependencies between steps when setting priorities regarding which script to run",
          "When selecting interceptors for a step:",
          "- ONLY use interceptors that are explicitly defined in the <available_scripts> section",
          "- Use EXACTLY the name and description provided for each interceptor",
          "- DO NOT create or invent new interceptors",
          "- Include a clear reason why each interceptor is relevant to the task",
          "- Only include interceptors that meaningfully contribute to the step's goals",
          "As a helper information (It is not a solid knowledge base, you SHOULD NOT RELY on it fully), refer to further provided <history> section. It contains explanation what was done in the past along with explanation of the schema (the way history is written), under child section <schema>, for the LLM",
        ],
      },
      knowledge_base: {
        knowledge: [
          "Most packages require configuration changes in addition to installation",
          "Package installations should be paired with corresponding file changes",
          "Always consider both direct and indirect configuration needs. Some of the packages require configuration, some of them require configuration + e.g. layout.tsx changes",
        ],
      },
    });
  }

  async function isWorkingTreeClean() {
    try {
      await execa("git", ["rev-parse", "--is-inside-work-tree"]);

      const { stdout } = await execa("git", ["status", "--porcelain"]);
      return { isClean: stdout.length === 0, isGitRepo: true };
    } catch (error) {
      return { isClean: true, isGitRepo: false };
    }
  }

  async function isGitWorkingTreeClean() {
    const { isClean, isGitRepo } = await isWorkingTreeClean();

    if (!isGitRepo) {
      log.warn(
        "This directory is not a git repository. For proper functioning of the program we require git."
      );
      log.info(
        `You can initialize git by running:\n${pc.bold("git init")}, ${pc.bold("git add .")} and ${pc.bold("git commit")} to start tracking your files :)`
      );
      log.info(`Then run ${pc.blazityOrange(pc.bold("npx nefi"))} again!`);
      outro("See you later fellow developer o/");
      return false;
    }

    if (!isClean) {
      log.warn(
        "Your git working tree has uncommitted changes. Please commit or stash your changes before using nefi."
      );
      log.info(
        `You can use ${pc.bold("git stash")} or ${pc.bold("git commit")} and then run ${pc.blazityOrange(pc.bold("npx nefi"))} again!`
      );
      outro("See you later fellow developer o/");
      return false;
    }

    return true;
  }
}
