import { text, isCancel } from "@clack/prompts";
import { anthropic } from "@ai-sdk/anthropic";
import { generateObject, streamObject, streamText } from "ai";
import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { intro, outro, spinner, log } from "@clack/prompts";
import { z } from "zod";
import { isNonNullish, isString, isEmpty } from "remeda";
import { readHistory } from "../../helpers/history";
import { ScriptContext } from "../../types";
import dedent from "dedent";

const executionPlanSchema = z.object({
  executionOrder: z.array(
    z.object({
      filename: z.string(),
      reason: z.string(),
      packages: z.array(z.string()).optional(),
    })
  ),
  analysis: z.string(),
});

type ExecutionPlan = z.infer<typeof executionPlanSchema>;

type Flags = {
  hidden?: boolean;
};

// Map of available scripts and their import functions
const scriptImports: Record<string, () => Promise<ScriptModule>> = {
  "add-package.ts": () => import("../../scripts/add-package"),
  // Add more scripts here as needed
};

interface ScriptModule {
  default?: (context: ScriptContext) => Promise<any> | any;
  [key: string]: any;
}

// Helper function to find matching script
function findMatchingScript(
  filename: string
): (() => Promise<ScriptModule>) | undefined {
  // First try exact match
  if (scriptImports[filename]) {
    return scriptImports[filename];
  }

  // Then try matching without extension
  const filenameWithoutExt = filename.replace(/\.[^/.]+$/, "");
  const match = Object.entries(scriptImports).find(
    ([key]) => key.replace(/\.[^/.]+$/, "") === filenameWithoutExt
  );

  return match?.[1];
}

export default async function ({ hidden }: Flags) {
  // Debug environment variables
  const envPath = `${process.cwd()}/.env`;
  log.info(`Checking environment variables from: ${envPath}`);

  // Check for required environment variables first
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    log.error("Missing API key environment variable");
    log.info(
      `Please add either ANTHROPIC_API_KEY or OPENAI_API_KEY to: ${envPath}`
    );
    process.exit(1);
  }

  intro("🤖 AI Script Analysis and Execution");

  const response = await text({
    message: "What do you want to do?",
  });

  if (isCancel(response)) {
    outro("Operation cancelled by user");
    process.exit(0);
  }

  const scriptsPath = join(process.cwd(), "src", "scripts");
  const spin = spinner();

  try {
    // Read all scripts from the directory
    spin.start("Deciding which tool to pick...");

    const availableScripts = new Set(Object.keys(scriptImports));
    const executedScripts = new Set<string>();

    spin.stop("Tools loaded successfully");

    // Prepare the context for AI analysis
    const scriptsContext = Array.from(availableScripts)
      .map((script) => `Tool: ${script}`)
      .join("\n");

    const history = readHistory();
    const historyContext =
      history.length > 0
        ? `\n\nRecent operations:\n${history
            .slice(0, 5)
            .map((h) => `- ${h.op}${h.p ? ` (${h.p.join(", ")})` : ""}`)
            .join("\n")}`
        : "";

    const { partialObjectStream } = streamObject({
      model: anthropic("claude-3-5-sonnet-20241022"),
      schema: executionPlanSchema,
      messages: [
        {
          role: "system",
          content: dedent`<role>You are a script execution planner that analyzes and executes scripts in the most logical order.</role>

<output_format>
  <json_schema>
    {
      "executionOrder": [
        {
          "filename": "script-name.js",
          "reason": "Explanation why this script should run at this position",
          "packages": ["package1", "package2"]
        }
      ],
      "analysis": "Overall analysis of the execution plan"
    }
  </json_schema>
</output_format>

<examples>
  <example name="development_tools">
    <description>Adding development tools to a project</description>
    <execution_plan>
      {
        "executionOrder": [
          {
            "filename": "add-package.ts",
            "reason": "Installing Storybook and its required dependencies",
            "packages": [
              "@storybook/react",
              "@storybook/builder-webpack5",
              "@storybook/manager-webpack5",
              "@storybook/addon-essentials"
            ]
          }
        ]
      }
    </execution_plan>
  </example>

  <example name="testing_setup">
    <description>Setting up testing environment</description>
    <execution_plan>
      {
        "executionOrder": [
          {
            "filename": "add-package.ts",
            "reason": "Installing Jest with TypeScript support",
            "packages": [
              "jest",
              "@types/jest",
              "ts-jest",
              "@testing-library/react",
              "@testing-library/jest-dom"
            ]
          }
        ]
      }
    </execution_plan>
  </example>
</examples>

<rules>
  <rule>Do not use add-package.ts without specifying the exact packages to install</rule>
  <rule>Return each script decision as soon as you make it</rule>
</rules>

<analysis_criteria>
  <criterion>Dependencies between scripts</criterion>
  <criterion>Impact on the system</criterion>
  <criterion>Risk level (safer operations first)</criterion>
  <criterion>Logical flow of operations</criterion>
</analysis_criteria>

<history_format>
  <description>The system maintains a history of operations in the following format:</description>
  <entry_structure>
    <field name="t">Timestamp of the operation</field>
    <field name="op">Operation type (e.g., "add-package")</field>
    <field name="p">Array of affected packages or paths</field>
  </entry_structure>
  <example>
    {
      "t": 1234567890,
      "op": "add-package",
      "p": ["react", "@types/react"]
    }
  </example>
</history_format>

<operation_history>${historyContext}</operation_history>

<user_request>
  I need to analyze and execute these scripts in the correct order:
  ${scriptsContext}

  Remember to return the response in the specified JSON format with executionOrder array and analysis string.
</user_request>`,
        },
        {
          role: "user",
          content: `User request: ${response.toString()}`,
        },
      ],
    });

    let executionPlan: ExecutionPlan | null = null;
    let partialResponse: any = { executionOrder: [] };
    let availableScriptsSet = new Set(availableScripts);

    spin.stop("Starting execution plan generation");
    log.step("Analyzing scripts and generating execution plan");

    try {
      for await (const partial of partialObjectStream) {
        // Update the partial response
        partialResponse = { ...partialResponse, ...partial };

        // If we have new scripts to execute
        if (Array.isArray(partialResponse.executionOrder)) {
          for (const step of partialResponse.executionOrder) {
            // Validate the script data before execution
            if (!step?.filename || !step?.reason) {
              continue;
            }

            if (
              step.filename === "add-package.ts" &&
              (!step.packages || !step.packages.length)
            ) {
              throw new Error(
                `Invalid execution plan: add-package.ts requires packages to be specified`
              );
            }

            // Check if script exists and hasn't been executed
            if (
              !executedScripts.has(step.filename) &&
              availableScriptsSet.has(step.filename)
            ) {
              log.step(`Executing ${step.filename}`);

              try {
                spin.start(`Running ${step.filename}...`);

                const importFn = findMatchingScript(step.filename);
                if (!importFn) {
                  throw new Error(
                    `No import function found for ${step.filename}`
                  );
                }

                const scriptModule = await importFn();
                const scriptFunction =
                  scriptModule.default || Object.values(scriptModule)[0];

                if (typeof scriptFunction !== "function") {
                  throw new Error(
                    `No executable function found in ${step.filename}`
                  );
                }

                // Create context for script execution
                const context: ScriptContext = {
                  path: process.cwd(),
                  packages:
                    step.filename === "add-package.ts"
                      ? step.packages || []
                      : undefined,
                };

                log.info(
                  `📦 Executing ${step.filename} with context: ${JSON.stringify(context)}`
                );

                const result = await scriptFunction(context);
                spin.stop(`✅ ${step.filename} executed successfully`);

                if (isNonNullish(result)) {
                  if (typeof result === "string") {
                    log.message("Output", { symbol: "📤" });
                    process.stdout.write(result);
                  } else {
                    log.message("Output", { symbol: "📤" });
                    console.log(result);
                  }
                }

                executedScripts.add(step.filename);
              } catch (err) {
                spin.stop(`❌ Failed to execute ${step.filename}`);
                if (err instanceof Error) {
                  log.error(err.message);
                } else {
                  log.error("An unknown error occurred");
                }
                throw err;
              }
            } else if (!availableScriptsSet.has(step.filename)) {
              log.warn(
                `Script ${step.filename} not found in available scripts`
              );
            }
          }
        }
      }

      // Final validation of the complete plan
      if (
        !partialResponse.executionOrder?.length ||
        !partialResponse.analysis
      ) {
        throw new Error("Incomplete execution plan received from AI");
      }

      executionPlan = executionPlanSchema.parse(partialResponse);

      if (executionPlan.analysis) {
        log.info("Execution Plan Analysis");
        log.message(executionPlan.analysis);
      }

      if (executedScripts.size === 0) {
        throw new Error(
          "No scripts were executed. The plan might be incomplete."
        );
      }

      log.success(`Successfully executed ${executedScripts.size} scripts`);
    } catch (error) {
      if (error instanceof Error) {
        if (
          error?.name === "AbortError" ||
          error?.message?.includes("cancel")
        ) {
          outro("Operation cancelled by user");
          process.exit(0);
        }
        log.error("Error during execution");
        if (error instanceof Error) {
          log.error(error.message);
        }
        throw new Error(
          "Failed to complete the execution plan. Please try again."
        );
      }
    }
  } catch (error) {
    log.error("Error during execution");
    if (error instanceof Error) {
      log.error(error.message);
    }
    throw error;
  } finally {
    outro("Finished");
  }
}
