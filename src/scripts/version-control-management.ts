import { generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { spinner } from "@clack/prompts";
import { execa } from "execa";
import { XMLBuilder } from 'fast-xml-parser';
import { verboseLog } from "../helpers/logger";

// Constants
const BRANCH_PREFIX = 'feature';

// Types
export interface GitNaming {
  branchName: string;
  commitMessage: string;
  description: string;
}

// XML Builder Configuration
const xmlBuilder = new XMLBuilder({
  format: true,
  indentBy: '  ',
  ignoreAttributes: false,
  suppressUnpairedNode: false,
  suppressBooleanAttributes: false,
  cdataPropName: '__cdata',
});

function createGitPrompt(request: string): string {
  const xmlObj = {
    'git-manager': {
      role: {
        '#text': 'You are an AI assistant specialized in generating meaningful git branch names and commit messages.'
      },
      rules: {
        rule: [
          'Generate branch names that follow conventional naming (feature/fix/chore)',
          'Use kebab-case for branch names',
          'Follow conventional commits specification for commit messages',
          'Keep branch names concise but descriptive',
          'Ensure commit messages clearly describe the changes',
          'Never include special characters in branch names except hyphens'
        ]
      },
      'output-format': {
        operation: {
          branchName: {
            '@_format': 'kebab-case',
            '#text': 'Branch name starting with feature/, fix/, or chore/'
          },
          commitMessage: {
            '@_format': 'conventional-commits',
            '#text': 'Commit message following conventional commits spec'
          },
          description: {
            '@_format': 'text',
            '#text': 'Clear explanation of the branch and commit purpose'
          }
        }
      },
      'request-context': {
        request: {
          __cdata: request
        }
      }
    }
  };

  return xmlBuilder.build(xmlObj);
}

// Schemas
export const gitNamingSchema = z.object({
  branchName: z.string().regex(/^(feature|fix|chore)\/[a-z0-9-]+$/),
  commitMessage: z.string().regex(/^(feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)(\([a-z-]+\))?: .+$/),
  description: z.string()
});

async function getCurrentBranch(): Promise<string> {
  const { stdout } = await execa('git', ['branch', '--show-current']);
  return stdout.trim();
}

async function checkoutNewBranch(branchName: string): Promise<void> {
  await execa('git', ['checkout', '-b', branchName]);
  verboseLog(`Created and checked out new branch: ${branchName}`);
}

export async function generateGitNaming(request: string): Promise<GitNaming> {
  const spin = spinner();
  spin.start("Generating git branch and commit details...");

  try {
    const prompt = createGitPrompt(request);
    
    const { object } = await generateObject({
      model: anthropic("claude-3-5-haiku-20241022"),
      schema: gitNamingSchema,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: prompt
        },
        {
          role: "user",
          content: request
        }
      ]
    });

    spin.stop("Generated git naming");
    return object;
  } catch (error) {
    spin.stop("Failed to generate git naming");
    throw error;
  }
}

export async function executeGitBranching(naming: GitNaming): Promise<void> {
  const spin = spinner();
  spin.start("Creating new git branch...");

  try {
    const currentBranch = await getCurrentBranch();
    verboseLog(`Current branch: ${currentBranch}`);

    // Create and checkout new branch
    await checkoutNewBranch(naming.branchName);
    
    spin.stop("Git branch created successfully");
  } catch (error) {
    spin.stop("Git branch creation failed");
    verboseLog("Error in git branching:", error);
    throw error;
  }
}
