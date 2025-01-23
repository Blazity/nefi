import { generateObject, tool } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { Writeable, z } from "zod";
import { log, outro, spinner } from "@clack/prompts";
import { execa } from "execa";
import type { DetailedLogger } from "../helpers/logger";
import { xml } from "../helpers/xml";
import { writeHistory } from "../helpers/history";
import pc from "picocolors";
import dedent from "dedent";

// Schemas for git operations
const gitBranchCreatePayload = z.object({
  branchName: z
    .string()
    .regex(/^(feature|fix|chore)\/[a-z0-9-]+$/)
    .describe(
      "Branch name following the pattern: feature/my-feature, fix/my-fix, chore/my-chore"
    ),
  description: z.string().describe("Clear explanation of the branch purpose"),
});

const gitCommitPayload = z.object({
  subject: z
    .string()
    .regex(
      /^(feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)(\([a-z-]+\))?: .+$/
    )
    .describe("Commit subject following conventional commits specification"),
  message: z
    .string()
    .describe("Detailed commit message explaining the changes"),
});

const gitOperations = ["commit", "branch-create"] as const;
type GitOperation = (typeof gitOperations)[number];

type ExecuteGitOperationParams = Readonly<{
  userRequest: string;
  executionStepDescription: string;
  operation: GitOperation;
  detailedLogger: DetailedLogger;
}>;

export async function executeGitOperation({
  userRequest,
  operation,
  executionStepDescription,
  detailedLogger,
}: ExecuteGitOperationParams) {
  const gpgConfig = await checkGpgSigning();
  detailedLogger.verboseLog("GPG signing check:", gpgConfig);
  if (gpgConfig.global || gpgConfig.local) {
    log.warn(
      `Unfortunately, nefi is not yet able to sign commits. Please disable commit signing to use ${pc.dim("git-operations")} scripts.`
    );
    log.info(`Skipping git operation in step ${executionStepDescription}`);
    return;
  }


  try {
    if (operation === "branch-create") {
      await handleBranchCreation();
    } else if (operation === "commit") {
      await handleCommit();
    } else {
      throw new Error(`Unsupported git operation: ${operation}`);
    }
  } catch (error) {
    detailedLogger.verboseLog("Error in git operation:", error);
    throw error;
  }

  log.success("Git operation completed");

  async function checkGpgSigning() {
    const checkConfig = async (scope: "global" | "local") => {
      try {
        const { stdout } = await execa("git", [
          "config",
          `--${scope}`,
          "--get",
          "commit.gpgsign",
        ]);
        const value = stdout.trim();
        detailedLogger.verboseLog(`Git ${scope} commit.gpgsign:`, { value });
        return value === "true";
      } catch (error) {
        // Git returns exit code 1 when the config key doesn't exist
        if (error instanceof Error) {
          const isConfigNotFound = error.message.includes("exit code 1");
          detailedLogger.verboseLog(`Git ${scope} config check:`, {
            error: error.message,
            isConfigNotFound,
          });
          return false;
        }
        detailedLogger.verboseLog(
          `Git ${scope} config unexpected error:`,
          error
        );
        return false;
      }
    };

    const [global, local] = await Promise.all([
      checkConfig("global"),
      checkConfig("local"),
    ]);

    return { global, local };
  }

  async function handleBranchCreation() {
    const branchProgress = spinner();
    branchProgress.start("Generating branch details...");

    const { object: branchPayload } = await generateObject({
      model: anthropic("claude-3-5-haiku-20241022"),
      schema: gitBranchCreatePayload,
      messages: [
        {
          role: "system",
          content: dedent`
            You are an AI assistant specialized in generating meaningful git branch names.
            
            ${xml.build({
              rules: {
                branch_rules: {
                  rule: [
                    "Generate branch names that follow conventional naming (feature/fix/chore)",
                    "Use kebab-case for branch names",
                    "Keep branch names concise but descriptive",
                    "Never include special characters in branch names except hyphens",
                    "Branch name should reflect the purpose of changes",
                  ],
                },
              },
            })}
          `,
        },
        {
          role: "user",
          content: userRequest,
        },
      ],
    });

    const currentBranch = await getCurrentBranch();
    detailedLogger.verboseLog("Current branch:", currentBranch);

    let branchName = branchPayload.branchName;
    let attempt = 1;
    const maxAttempts = 10;

    while (attempt <= maxAttempts) {
      try {
        await checkoutNewBranch(branchName);
        detailedLogger.verboseLog(`Successfully created branch: ${branchName}`);
        writeHistory({
          op: "branch-create",
          d: "Created a new branch",
          dt: {
            branch: branchName,
            description: branchPayload.description,
            baseBranch: currentBranch,
          },
        });
        branchProgress.stop("Branch created");
        return;
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("already exists")
        ) {
          attempt++;
          branchName = `${branchPayload.branchName}-${attempt}`;
          detailedLogger.verboseLog(`Branch exists, trying: ${branchName}`);
        } else {
          throw error;
        }
      }
    }


    throw new Error(`Failed to create branch after ${maxAttempts} attempts`);

    async function checkoutNewBranch(branchName: string): Promise<void> {
      if (await branchExists(branchName)) {
        throw new Error(`Branch '${branchName}' already exists`);
      }

      try {
        await execa("git", ["checkout", "-b", branchName]);
      } catch (error) {
        if (error instanceof Error) {
          throw new Error(
            `Failed to create branch '${branchName}': ${error.message}`
          );
        }
        throw new Error(
          `Failed to create branch '${branchName}': Unknown error`
        );
      }
    }

    async function branchExists(branchName: string): Promise<boolean> {
      try {
        const { stdout } = await execa("git", ["branch", "--list", branchName]);
        return stdout.trim() !== "";
      } catch (error) {
        return false;
      }
    }
  }

  async function handleCommit() {
    const commitProgress = spinner();
    commitProgress.start("Generating commit details...");

    const { object: commitPayload } = await generateObject({
      model: anthropic("claude-3-5-haiku-20241022"),
      schema: gitCommitPayload,
      messages: [
        {
          role: "system",
          content: dedent`
            You are an AI assistant specialized in generating meaningful git commit messages.
            
            ${xml.build({
              rules: {
                commit_rules: {
                  rule: [
                    "Follow conventional commits specification for commit messages",
                    "Start commit subject with type (feat/fix/chore/docs/style/refactor/perf/test/build/ci/revert)",
                    "Optionally add scope in parentheses after type",
                    "Use imperative mood in commit subject",
                    "Keep subject line under 72 characters",
                    "Separate subject from body with a blank line",
                    "Use the body to explain what and why vs. how",
                  ],
                },
              },
            })}
          `,
        },
        {
          role: "user",
          content: userRequest,
        },
      ],
    });

    const currentBranch = await getCurrentBranch();
    detailedLogger.verboseLog("Current branch:", currentBranch);

    await createCommit(commitPayload);
    detailedLogger.verboseLog(
      `Successfully created commit: ${commitPayload.subject}`
    );
    writeHistory({
      op: "commit",
      d: "Created a new commit",
      dt: {
        subject: commitPayload.subject,
        message: commitPayload.message,
        branch: currentBranch,
      },
    });
    commitProgress.stop("Commit created");

    async function createCommit(
      payload: z.infer<typeof gitCommitPayload>
    ): Promise<void> {
      try {
        // First, check if there are any changes to commit
        const { stdout: status } = await execa("git", [
          "status",
          "--porcelain",
        ]);
        if (!status.trim()) {
          throw new Error("No changes to commit");
        }

        // Stage all changes
        await execa("git", ["add", "."]);

        // Create commit with subject and message
        // TODO: add co-authoring by nefi if flag is enabled
        const commitMessage = `${payload.subject}\n\n${payload.message}`;
        await execa("git", ["commit", "-m", commitMessage]);
      } catch (error) {
        if (error instanceof Error) {
          throw new Error(`Failed to create commit: ${error.message}`);
        }
        throw new Error("Failed to create commit: Unknown error");
      }
    }
  }

  async function getCurrentBranch(): Promise<string> {
    const { stdout } = await execa("git", ["branch", "--show-current"]);
    return stdout.trim();
  }
}

type RetrieveGitOperationParams = Readonly<{
  userRequest: string;
  executionStepDescription: string;
}>;

export async function retrieveGitOperation({
  userRequest,
  executionStepDescription,
}: RetrieveGitOperationParams) {
  const { object: gitOperation } = await generateObject({
    model: anthropic("claude-3-5-sonnet-20241022"),
    output: "enum",
    enum: gitOperations as Writeable<typeof gitOperations>,
    prompt: dedent`
      What git operation should I perform basing on the request and current execution step?

      <execution_step>
        ${executionStepDescription}
      </execution_step>

      <user_request>
        ${userRequest}
      </user_request>
    `,
  });



  return gitOperation as GitOperation;
}
