import { text, isCancel, confirm } from "@clack/prompts";
import { anthropic } from "@ai-sdk/anthropic";
import { generateObject, generateText } from "ai";
import { readdir, readFile } from "fs/promises";
import path, { join } from "path";
import { intro, outro, spinner, log } from "@clack/prompts";
import { z } from "zod";
import { isNonNullish, pipe, filter, map, isEmpty } from "remeda";
import { readHistory, formatHistoryForLLM } from "../../helpers/history";
import dedent from "dedent";
import { scriptHandlers, type ScriptContext } from "../../scripts-registry";
import fg from "fast-glob";
import { readFileSync, existsSync } from "fs";
import ignore from "ignore";
import { verboseAIUsage, verboseLog } from "../../helpers/logger";
import micromatch from "micromatch";
import { execa } from "execa";
import pc from "picocolors";
import {
  projectFilePath,
  projectFiles,
  type ProjectFiles,
} from "../../helpers/project-files";
import { xml } from "../../helpers/xml";
import { Tagged } from "type-fest";

type ExecutionPipelineContext = {
  files: ProjectFiles;
};

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

async function readProjectFiles(cwd: string) {
  const gitignorer = ignore();

  try {
    const gitignoreFile = await readFile(path.join("cwd", ".gitignore"), {
      encoding: "utf-8",
    });
    gitignorer.add(gitignoreFile);

    verboseLog("Loaded .gitignore rules", gitignoreFile);
  } catch {
    // Unlikely to happen as we are designing this tool only in scope
    // of next-enterprise repository
    verboseLog("No .gitignore found, proceeding without it");
  }

  verboseLog("Starting file paths scan with fast-glob");

  const filePaths = await fg(["**/*"], {
    cwd,
    dot: true,
    absolute: true,
    ignore: EXCLUDED_PATTERNS,
    followSymbolicLinks: false,
  });

  verboseLog(`Found ${filePaths.length} paths`, filePaths);

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

const executionPlanSchema = z.object({
  steps: z.array(
    z.object({
      description: z.string(),
      scriptFile: z.enum([
        "package-management",
        "file-modifier",
        "version-control-management",
      ]),
      priority: z.number(),
    })
  ),
  analysis: z.string(),
});

type ExecutionPlan = z.infer<typeof executionPlanSchema>;

interface AgentCommandOptions {
  initialResponse?: string;
  context: ExecutionPipelineContext;
}

function createSystemPrompt() {
  return xml.build({
    available_scripts: {
      script: [
        {
          "@_name": "version-management",
          script_specific_rules: {
            rule: ["This script must ALWAYS be the first priority"],
          },
        },
        {
          "@_name": "file-modifier",
          script_specific_rules: {
            rule: [
              "Analyze the needs basing of the files' paths existing in the project, supplied in <files_paths> section",
              "When predicting which files or parts of the codebase should be modified prefer to split the file modification into multiple script calls.",
              "Do include files or parts of the codebase ONLY ONCE without duplicate steps referring to the same modification.",
            ],
          },
        },
        {
          "@_name": "version-control-management",
          script_specific_rules: {
            rule: [
              "This script must ONLY be used for GIT version control management system's specific operations and ALWAYS be the last one.",
            ],
          },
        },
      ],
    },
    rules: {
      rule: [
        "User's request is provided in <user_request> section",
        "The execution plan is kind of priority list in array format. First item is top priority script and the last one is the last priority script.",
        "Break down complex requests into logical stepsa nd provide clear description for each step",
        "Consider dependencies between steps when setting priorities regarding which script to run",
        "As a helper information (It is not a solid knowledge base, you SHOULD NOT RELY on it fully), refer to further provided <history> section. It contains explanation what was done in the past along with explanation of the schema (the way history is written), under child section <schema>, for the LLM",
      ],
    },
    knowledge_base: {
      knowledge: [
        "Most packages require configuration changes in addition to installation",
        "Package installations should be paired with corresponding file changes",
        "Always consider both direct and indirect configuration needs.",
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

export async function agentCommand({
  initialResponse,
  context,
}: AgentCommandOptions) {
  try {
    if (!initialResponse) {
      intro(`Hello, ${await getSystemUserName()}!`);
    }

    if (!(await isGitWorkingTreeClean())) {
      return;
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

    let executionPipelineContext = context;

    if (!executionPipelineContext) {
      const spin = spinner();
      spin.start("Reading project files for analysis...");
      const files = (executionPipelineContext = {
        files: await readProjectFiles(process.cwd()),
      });

      spin.stop("Project files loaded");

      verboseLog("User request", userInput);
      log.step("Tools loaded successfully");
      log.step("Analyzing request and generating base execution plan");
    }

    const spin = spinner();
    spin.start(
      initialResponse
        ? "Regenerating execution plan based on your feedback..."
        : "Generating base execution plan..."
    );

    try {
      const historyContext = formatHistoryForLLM(5);
      verboseLog("History context:", historyContext);

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

      verboseLog("Received execution plan", executionPlan);

      verboseAIUsage("Execution plan generation usage:", {
        usage: executionPlanGenerationUsage,
        experimental_providerMetadata: executionPlanGenerationMetadata,
      });

      spin.stop("Base execution plan generated");

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
                  "You must recognize to e.g. remove the version-control-management execution plan step if user demands to 'remove step related to version control'.",
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
          log.message(
            `${pc.bgWhiteBright(" " + pc.black(pc.bold(index + 1)) + " ")} ${step.description} ${pc.gray("(using ")}${pc.gray(step.scriptFile)}${pc.gray(")")}`
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

          verboseAIUsage("Updated execution plan generation usage:", {
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

          const requiredFiles = projectFiles({});

          if (handler.requirements) {
            if (
              "requiredFilesByPath" in handler.requirements &&
              handler.requirements.requiredFilesByPath
            ) {
              verboseLog(
                "Gathering required files",
                handler.requirements.requiredFilesByPath
              );
              for (const fileToRequirePath of handler.requirements
                .requiredFilesByPath) {
                if (
                  executionPipelineContext.files[
                    projectFilePath(fileToRequirePath)
                  ]
                ) {
                  requiredFiles[fileToRequirePath] =
                    executionPipelineContext.files[fileToRequirePath];

                  verboseLog(`Found required file: ${fileToRequirePath}`);
                } else {
                  verboseLog(`Missing required file: ${fileToRequirePath}`);
                }
              }
            } else if (
              "requiredFilesByPathWildcard" in handler.requirements &&
              handler.requirements.requiredFilesByPathWildcard
            ) {
              verboseLog(
                "Processing file patterns",
                handler.requirements.requiredFilesByPathWildcard
              );
              const paths = Object.keys(executionPipelineContext.files);

              for (const pattern of handler.requirements
                .requiredFilesByPathWildcard) {
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
                verboseLog(`Pattern ${pattern} matched files`, matchingPaths);
              }

              if (
                "excludedFilesByPathWildcard" in handler.requirements &&
                handler.requirements.excludedFilesByPathWildcard
              ) {
                verboseLog(
                  "Processing excluded patterns",
                  handler.requirements.excludedFilesByPathWildcard
                );
                const excludedPaths = micromatch(
                  Object.keys(requiredFiles),
                  handler.requirements.excludedFilesByPathWildcard
                );

                for (const path of excludedPaths) {
                  delete requiredFiles[projectFilePath(path)];
                }
                verboseLog("Files after exclusion", Object.keys(requiredFiles));
              }
            }
          }

          const scriptContext: ScriptContext = {
            rawRequest: userInput,
            executionPlan: currentPlan,
            executionStepDescription: step.description,
            files: requiredFiles,
          };

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
      verboseLog("Fatal error", error);
    }
    outro("Operation failed");
    return;
  }
}
