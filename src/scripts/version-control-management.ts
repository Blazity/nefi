import { generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { spinner } from "@clack/prompts";
import { execa } from "execa";
import type { DetailedLogger } from "../helpers/logger";
import { xml } from "../helpers/xml";
import { writeHistory } from "../helpers/history";

// Schemas
export const gitNamingSchema = z.object({
  branchName: z.string().regex(/^(feature|fix|chore)\/[a-z0-9-]+$/),
  commitMessage: z
    .string()
    .regex(
      /^(feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)(\([a-z-]+\))?: .+$/
    ),
  description: z.string(),
});

type GitNaming = z.infer<typeof gitNamingSchema>

type GenerateGitNamingParams = Readonly<{
  userRequest: string;
  detailedLogger: DetailedLogger;
}>;

export async function generateGitNaming({
  userRequest,
  detailedLogger,
}: GenerateGitNamingParams): Promise<GitNaming> {
  const spin = spinner();
  spin.start("Generating git branch and commit details...");

  try {
    const prompt = createGitPrompt(userRequest);

    const { object } = await generateObject({
      model: anthropic("claude-3-5-haiku-20241022"),
      schema: gitNamingSchema,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: prompt,
        },
        {
          role: "user",
          content: userRequest,
        },
      ],
    });

    spin.stop("Generated git naming");
    return object;
  } catch (error) {
    spin.stop("Failed to generate git naming");
    throw error;
  }

  function createGitPrompt(request: string) {
    const xmlObj = {
      "git-manager": {
        role: {
          "#text":
            "You are an AI assistant specialized in generating meaningful git branch names and commit messages.",
        },
        rules: {
          rule: [
            "Generate branch names that follow conventional naming (feature/fix/chore)",
            "Use kebab-case for branch names",
            "Follow conventional commits specification for commit messages",
            "Keep branch names concise but descriptive",
            "Ensure commit messages clearly describe the changes",
            "Never include special characters in branch names except hyphens",
          ],
        },
        "output-format": {
          operation: {
            branchName: {
              "@_format": "kebab-case",
              "#text": "Branch name starting with feature/, fix/, or chore/",
            },
            commitMessage: {
              "@_format": "conventional-commits",
              "#text": "Commit message following conventional commits spec",
            },
            description: {
              "@_format": "text",
              "#text": "Clear explanation of the branch and commit purpose",
            },
          },
        },
        "request-context": {
          request: {
            __cdata: request,
          },
        },
      },
    };

    return xml.build(xmlObj);
  }
}

type ExecuteGitBranchingParams = Readonly<{
  naming: GitNaming;
  detailedLogger: DetailedLogger;
}>;

export async function executeGitBranching({
  naming,
  detailedLogger,
}: ExecuteGitBranchingParams) {
  const progress = spinner();
  try {
    progress.start("Generating git naming");

    // Get current branch
    const currentBranch = await getCurrentBranch();
    detailedLogger.verboseLog("Current branch:", currentBranch);

    let branchName = naming.branchName;
    let attempt = 1;
    const maxAttempts = 10; // Prevent infinite loop

    // Try to create branch with incremental suffix if it exists
    while (attempt <= maxAttempts) {
      try {
        await checkoutNewBranch(branchName);
        detailedLogger.verboseLog(`Successfully created branch: ${branchName}`);
        writeHistory({
          op: "branch-create",
          d: "Created a new branch",
          dt: {
            branch: branchName,
            description: naming.description,
            baseBranch: currentBranch,
          },
        });
        return;
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("already exists")
        ) {
          attempt++;
          branchName = `${naming.branchName}-${attempt}`;
          detailedLogger.verboseLog(`Branch exists, trying: ${branchName}`);
        } else {
          throw error;
        }
      }
    }

    throw new Error(`Failed to create branch after ${maxAttempts} attempts`);
  } catch (error) {
    detailedLogger.verboseLog("Error in git branching:", error);
    throw error;
  } finally {
    progress.stop("Git branch creation completed");
  }

  async function getCurrentBranch(): Promise<string> {
    const { stdout } = await execa("git", ["branch", "--show-current"]);
    return stdout.trim();
  }

  async function branchExists(branchName: string): Promise<boolean> {
    try {
      const { stdout } = await execa("git", ["branch", "--list", branchName]);
      return stdout.trim() !== "";
    } catch (error) {
      detailedLogger.verboseLog("Error checking branch existence:", error);
      return false;
    }
  }

  async function checkoutNewBranch(branchName: string): Promise<void> {
    if (await branchExists(branchName)) {
      throw new Error(`Branch '${branchName}' already exists`);
    }

    try {
      await execa("git", ["checkout", "-b", branchName]);
      detailedLogger.verboseLog(`Created and checked out new branch: ${branchName}`);
    } catch (error: any) {
      detailedLogger.verboseLog("Error creating branch:", error);
      throw new Error(
        `Failed to create branch '${branchName}': ${error?.message || "Unknown error"}`
      );
    }
  }
}
