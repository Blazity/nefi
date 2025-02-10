import { generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { Writeable, z } from "zod";
import { log, spinner } from "@clack/prompts";
import { execa } from "execa";
import type { DetailedLogger } from "../helpers/logger";
import { xml } from "../helpers/xml";
import { writeHistory } from "../helpers/history";
import pc from "picocolors";
import dedent from "dedent";
import { BaseScriptHandler, ScriptHandler, PromptFunction, type ScriptContext } from "../scripts-registry";

type CommitStyle = "conventional-commits" | "imperative" | "custom";
type BranchStyle = "conventional" | "feature-dash" | "custom";

type CommitPattern = {
  style: CommitStyle;
  scopes: Set<string>;
  types: Set<string>;
};

type BranchPattern = {
  style: BranchStyle;
  prefixes: Set<string>;
};

const gitOperations = ["commit", "branch-create"] as const;
type GitOperation = (typeof gitOperations)[number];

type ExecuteGitOperationParams = Readonly<{
  userRequest: string;
  executionStepDescription: string;
  operation: GitOperation;
  detailedLogger: DetailedLogger;
}>;

// Dynamic schemas will be initialized during execution
let gitBranchCreatePayload: z.ZodType;
let gitCommitPayload: z.ZodType;

@ScriptHandler({
  requirements: {
    excludedFilesByPathWildcard: ["**/.git/**"]
  }
})
export class GitOperationsHandler extends BaseScriptHandler {
  private gitBranchCreatePayload: z.ZodType | undefined;
  private gitCommitPayload: z.ZodType | undefined;

  async execute({
    userRequest,
    detailedLogger,
    executionStepDescription,
  }: ScriptContext): Promise<void> {
    const operation = await this.retrieveGitOperation({
      userRequest,
      executionStepDescription,
    });

    await this.executeGitOperation({
      userRequest,
      operation,
      detailedLogger,
      executionStepDescription,
    });
  }

  @PromptFunction()
  private async retrieveGitOperation({
    userRequest,
    executionStepDescription,
  }: {
    userRequest: string;
    executionStepDescription: string;
  }): Promise<GitOperation> {
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

  @PromptFunction()
  private async executeGitOperation({
    userRequest,
    operation,
    executionStepDescription,
    detailedLogger,
  }: ExecuteGitOperationParams): Promise<void> {
    const gpgConfig = await this.checkGpgSigning(detailedLogger);
    detailedLogger.verboseLog("GPG signing check:", gpgConfig);
    if (gpgConfig.global || gpgConfig.local) {
      log.warn(
        `Unfortunately, nefi is not yet able to sign commits. Please disable commit signing to use ${pc.dim("git-operations")} scripts.`
      );
      log.info(`Skipping git operation in step ${executionStepDescription}`);
      return;
    }

    await this.initializeSchemas(detailedLogger);

    try {
      if (operation === "branch-create") {
        await this.handleBranchCreation(userRequest, detailedLogger);
      } else if (operation === "commit") {
        await this.handleCommit(userRequest, detailedLogger);
      } else {
        throw new Error(`Unsupported git operation: ${operation}`);
      }
    } catch (error) {
      detailedLogger.verboseLog("Error in git operation:", error);
      throw error;
    }

    log.success("Git operation completed");
  }

  private async getRecentCommits(detailedLogger: DetailedLogger) {
    try {
      const { stdout } = await execa("git", [
        "log",
        "--max-count=100",
        "--pretty=format:%s",
      ]);

      const commits = stdout.split("\n");
      detailedLogger.verboseLog("Retrieved recent commits:", {
        count: commits.length,
      });
      return commits;
    } catch (error) {
      detailedLogger.verboseLog("Failed to get recent commits:", error);
      return [];
    }
  }

  private async getRecentBranches(detailedLogger: DetailedLogger) {
    try {
      const { stdout } = await execa("git", [
        "branch",
        "-a",
        "--sort=-committerdate",
        "--format=%(refname:short)",
      ]);

      const branches = stdout
        .split("\n")
        .map((b) => b.replace(/^origin\//, ""))
        .filter((b) => b !== "HEAD" && b !== "origin" && b)
        .filter((b, i, arr) => arr.indexOf(b) === i)
        .map((branch) => branch.replace("origin/", ""))
        .slice(0, 30);

      detailedLogger.verboseLog("Retrieved recent branches:", {
        count: branches.length,
      });
      return branches;
    } catch (error) {
      detailedLogger.verboseLog("Failed to get recent branches:", error);
      return [];
    }
  }

  private async analyzeCommitPattern(commits: string[], detailedLogger: DetailedLogger) {
    const pattern: CommitPattern = {
      style: "imperative",
      scopes: new Set<string>(),
      types: new Set<string>(),
    };

    // Use AI to detect the commit style
    const { object: detectedStyle } = await generateObject({
      model: anthropic("claude-3-5-haiku-20241022"),
      output: "enum",
      enum: ["conventional-commits", "imperative", "custom"] as const,
      messages: [
        {
          role: "system",
          content: dedent`
            You are an expert at analyzing git commit message patterns.
            
            ${xml.build({
              rules: {
                commit_style_rules: {
                  rule: [
                    "conventional-commits: Messages start with type(scope): description, e.g. 'feat(ui): add button' or 'fix: resolve crash'",
                    "imperative: Messages start with imperative verb, e.g. 'Add button' or 'Fix crash'",
                    "custom: Messages don't follow either pattern consistently",
                  ],
                  detection: [
                    "If more than 30% of commits follow conventional commits pattern, classify as conventional-commits",
                    "If commits consistently start with imperative verbs and don't follow conventional pattern, classify as imperative",
                    "If no clear pattern is detected, classify as custom",
                    "Presence of conventional commit markers (feat:, fix:, etc.) strongly indicates conventional-commits style",
                    "Ignore automated commits like dependabot, release, etc. in the analysis",
                  ],
                },
              },
            })}
          `,
        },
        {
          role: "user",
          content: dedent`
            Analyze these commit messages and determine the commit style:

            ${commits.join("\n")}
          `,
        },
      ],
    });

    // Extract types and scopes if conventional-commits style is detected
    if (detectedStyle === "conventional-commits") {
      commits.forEach((commit) => {
        const match = commit.match(/^([^(]+)(?:\(([^)]+)\))?:/);
        if (match) {
          pattern.types.add(match[1]);
          if (match[2]) pattern.scopes.add(match[2]);
        }
      });
    }

    pattern.style = detectedStyle;

    detailedLogger.verboseLog("Analyzed commit pattern:", {
      style: pattern.style,
      typesCount: pattern.types.size,
      scopesCount: pattern.scopes.size,
      totalCommits: commits.length,
    });

    return pattern;
  }

  private async analyzeBranchPattern(branches: string[], detailedLogger: DetailedLogger) {
    const pattern: BranchPattern = {
      style: "custom",
      prefixes: new Set<string>(),
    };

    const reliableBranches = branches.filter(branch => 
      !["main", "master", "develop", "release", "renovate"].some(prefix => 
        branch === prefix || branch.startsWith(`${prefix}/`) || branch.startsWith(`${prefix}-`)
      )
    );

    detailedLogger.verboseLog("Filtered reliable branches:", {
      total: branches.length,
      reliable: reliableBranches.length,
      excluded: branches.length - reliableBranches.length,
    });

    // If we don't have enough reliable branches, default to conventional
    if (reliableBranches.length < 3) {
      pattern.style = "conventional";
      detailedLogger.verboseLog("Not enough reliable branches, defaulting to conventional style");
      return pattern;
    }

    // Use AI to detect the branch style
    const { object: detectedStyle } = await generateObject({
      model: anthropic("claude-3-5-haiku-20241022", {
        cacheControl: true 
      }),
      maxRetries: 10,
      output: "enum",
      enum: ["conventional", "feature-dash", "custom"] as const,
      messages: [
        {
          role: "system",
          content: dedent`
            You are an expert at analyzing git branch naming patterns.
            
            ${xml.build({
              rules: {
                branch_style_rules: {
                  rule: [
                    "conventional: Branches follow pattern type/description, e.g. 'feature/add-button' or 'fix/resolve-crash'",
                    "feature-dash: Branches follow pattern prefix-number-description, e.g. 'feat-123-add-button' or 'fix-456-crash'",
                    "custom: Branches don't follow either pattern consistently",
                  ],
                  detection: [
                    "If more than 30% of branches follow conventional pattern (type/description), classify as conventional",
                    "If more than 30% of branches follow feature-dash pattern (prefix-number-description) or (prefix-description), classify as feature-dash",
                    "If no clear pattern is detected, classify as custom",
                    "Common conventional prefixes: feature/*, fix/*, chore/*, docs/*, etc. The * can be replaced with any word. It means that slash after prefix indicates it's a conventional style",
                    "Common feature-dash prefixes: feat-*, fix-*, chore-*, etc. The * can be replaced with any word. It means that dash after prefix indicates it's a feature-dash style",
                    "If there's no clear majority pattern, prefer conventional style",
                  ],
                },
              },
            })}
          `,
        },
        {
          role: "user",
          content: dedent`
            Analyze these branch names and determine the branch naming style:

            ${reliableBranches.join("\n")}
          `,
          experimental_providerMetadata: {
            anthropic: {
              cacheControl: {
                type: "ephemeral",
              }
            }
          }
        },
      ],
    });

    // Extract prefixes based on detected style
    reliableBranches.forEach((branch) => {
      if (detectedStyle === "conventional") {
        const prefix = branch.split("/")[0];
        if (prefix) pattern.prefixes.add(prefix);
      } else if (detectedStyle === "feature-dash") {
        const prefix = branch.split("-")[0];
        if (prefix) pattern.prefixes.add(prefix);
      }
    });

    // If we detected custom style, fallback to conventional
    pattern.style = detectedStyle === "custom" ? "conventional" : detectedStyle;

    detailedLogger.verboseLog("Analyzed branch pattern:", {
      style: pattern.style,
      prefixesCount: pattern.prefixes.size,
      totalBranches: reliableBranches.length,
      detectedStyle,
    });
    return pattern;
  }

  private generateCommitSchema(pattern: CommitPattern, detailedLogger: DetailedLogger) {
    if (pattern.style === "conventional-commits") {
      const types = Array.from(pattern.types);
      const scopes = Array.from(pattern.scopes);

      const typeRegex =
        types.length > 0
          ? types.join("|")
          : "feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert";
      const scopeRegex =
        scopes.length > 0 ? `(${scopes.join("|")})` : "[a-z-]+";

      detailedLogger.verboseLog("Generated conventional commit schema:", {
        types: types.join(", "),
        scopes: scopes.join(", "),
      });

      return z.object({
        subject: z
          .string()
          .regex(new RegExp(`^(${typeRegex})(\\(${scopeRegex}\\))?: .+$`))
          .describe(
            "Commit subject following detected conventional commits pattern"
          ),
        message: z
          .string()
          .describe("Detailed commit message explaining the changes"),
      });
    }

    if (pattern.style === "custom") {
      detailedLogger.verboseLog("Generated custom commit schema");
      return z.object({
        subject: z.string().describe("Commit subject in any style"),
        message: z
          .string()
          .describe("Detailed commit message explaining the changes"),
      });
    }

    detailedLogger.verboseLog("Generated imperative commit schema");
    return z.object({
      subject: z
        .string()
        .regex(/^[A-Z].*$/)
        .describe(
          "Commit subject in imperative mood starting with capital letter"
        ),
      message: z
        .string()
        .describe("Detailed commit message explaining the changes"),
    });
  }

  private generateBranchSchema(pattern: BranchPattern, detailedLogger: DetailedLogger) {
    if (pattern.style === "conventional") {
      const prefixes = Array.from(pattern.prefixes)
        .filter(prefix => !["main", "master"].includes(prefix))
        .filter(prefix => !prefix.includes("-")); // Filter out non-conventional prefixes

      const prefixRegex = prefixes.length > 0 
        ? prefixes.join("|") 
        : "feature|fix|chore|docs|style|refactor|perf|test|build|ci|revert";

      detailedLogger.verboseLog("Generated conventional branch schema:", {
        prefixes: prefixes.join(", "),
        regex: `^(${prefixRegex})/[a-z0-9-]+$`,
      });

      return z.object({
        branchName: z
          .string()
          .regex(new RegExp(`^(${prefixRegex})/[a-z0-9-]+$`))
          .describe("Branch name following conventional pattern"),
        description: z
          .string()
          .describe("Clear explanation of the branch purpose"),
      });
    }

    if (pattern.style === "feature-dash") {
      const prefixes = Array.from(pattern.prefixes)
        .filter(prefix => !["main", "master"].includes(prefix))
        .filter(prefix => !prefix.includes("/")) // Filter out conventional prefixes
        .filter(prefix => /^[a-z]+$/.test(prefix)); // Only allow simple prefixes

      const prefixRegex = prefixes.length > 0 
        ? prefixes.join("|") 
        : "feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert";

      detailedLogger.verboseLog("Generated feature-dash branch schema:", {
        prefixes: prefixes.join(", "),
        regex: `^(${prefixRegex})-[a-z0-9-]+$`,
      });

      return z.object({
        branchName: z
          .string()
          .regex(new RegExp(`^(${prefixRegex})-[a-z0-9-]+$`))
          .describe("Branch name following feature-dash pattern"),
        description: z
          .string()
          .describe("Clear explanation of the branch purpose"),
      });
    }

    detailedLogger.verboseLog("Generated custom branch schema");
    return z.object({
      branchName: z
        .string()
        .regex(/^[a-z0-9-]+$/)
        .describe("Branch name in kebab-case"),
      description: z
        .string()
        .describe("Clear explanation of the branch purpose"),
    });
  }

  private async initializeSchemas(detailedLogger: DetailedLogger) {
    try {
      const [recentCommits, recentBranches] = await Promise.all([
        this.getRecentCommits(detailedLogger),
        this.getRecentBranches(detailedLogger),
      ]);

      detailedLogger.verboseLog("Analyzing recent commits and branches", {
        commitCount: recentCommits.length,
        branchCount: recentBranches.length,
      });

      const [commitPattern, branchPattern] = await Promise.all([
        this.analyzeCommitPattern(recentCommits, detailedLogger),
        this.analyzeBranchPattern(recentBranches, detailedLogger),
      ]);

      detailedLogger.verboseLog("Detected patterns", {
        commitStyle: commitPattern.style,
        branchStyle: branchPattern.style,
      });

      this.gitCommitPayload = this.generateCommitSchema(commitPattern, detailedLogger);
      this.gitBranchCreatePayload = this.generateBranchSchema(branchPattern, detailedLogger);
    } catch (error) {
      detailedLogger.verboseLog("Error initializing schemas:", error);
      throw error;
    }
  }

  private async checkGpgSigning(detailedLogger: DetailedLogger) {
    const [global, local] = await Promise.all([
      this.checkConfig("global", detailedLogger),
      this.checkConfig("local", detailedLogger),
    ]);

    return { global, local };
  }

  private async checkConfig(scope: "global" | "local", detailedLogger: DetailedLogger) {
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
  }

  private async getCurrentBranch() {
    const { stdout } = await execa("git", ["branch", "--show-current"]);
    return stdout.trim();
  }

  private async handleBranchCreation(userRequest: string, detailedLogger: DetailedLogger) {
    if (!this.gitBranchCreatePayload) {
      throw new Error("Git branch create schema not initialized");
    }

    const branchProgress = spinner();
    branchProgress.start("Generating branch details...");

    const { object: branchPayload } = await generateObject({
      model: anthropic("claude-3-5-haiku-20241022"),
      schema: this.gitBranchCreatePayload,
      messages: [
        {
          role: "system",
          content: dedent`
            You are an AI assistant specialized in generating meaningful git branch names.
            
            ${xml.build({
              rules: {
                branch_rules: {
                  rule: [
                    "Generate branch names that follow the repository's detected naming convention",
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

    const currentBranch = await this.getCurrentBranch();
    detailedLogger.verboseLog("Current branch:", currentBranch);

    let branchName = branchPayload.branchName;
    let attempt = 1;
    const maxAttempts = 10;

    while (attempt <= maxAttempts) {
      try {
        await this.checkoutNewBranch(branchName);
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
  }

  private async checkoutNewBranch(branchName: string) {
    if (await this.branchExists(branchName)) {
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

  private async branchExists(branchName: string) {
    try {
      const { stdout } = await execa("git", ["branch", "--list", branchName]);
      return stdout.trim() !== "";
    } catch (error) {
      return false;
    }
  }

  private async handleCommit(userRequest: string, detailedLogger: DetailedLogger) {
    if (!this.gitCommitPayload) {
      throw new Error("Git commit schema not initialized");
    }

    const commitProgress = spinner();
    commitProgress.start("Generating commit details...");

    const { object: commitPayload } = await generateObject({
      model: anthropic("claude-3-5-haiku-20241022"),
      schema: this.gitCommitPayload,
      messages: [
        {
          role: "system",
          content: dedent`
            You are an AI assistant specialized in generating meaningful git commit messages.
            
            ${xml.build({
              rules: {
                commit_rules: {
                  rule: [
                    "Follow the repository's detected commit message style",
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

    const currentBranch = await this.getCurrentBranch();
    detailedLogger.verboseLog("Current branch:", currentBranch);

    await this.createCommit(commitPayload);
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
  }

  private async createCommit(payload: z.infer<typeof gitCommitPayload>) {
    try {
      const { stdout: status } = await execa("git", [
        "status",
        "--porcelain",
      ]);
      if (!status.trim()) {
        throw new Error("No changes to commit");
      }

      await execa("git", ["add", "."]);

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

// Export only the handler class and necessary types
export type { GitOperation };
