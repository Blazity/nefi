import { anthropic } from "@ai-sdk/anthropic";
import { spinner } from "@clack/prompts";
import { generateObject } from "ai";
import { applyPatch, parsePatch } from 'diff';
import { execa } from "execa";
import { XMLBuilder } from 'fast-xml-parser';
import { writeFile } from 'fs/promises';
import { dirname } from "path";
import { z } from "zod";
import { verboseLog } from "../helpers/logger";

// Constants
const MAX_FILE_SIZE = 100 * 1024; // 100KB
const EXCLUDED_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/bun.lockb',
  '**/.DS_Store',
  '**/*.lock',
  '**/*.log',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/coverage/**'
];

// Types
export interface SourceFile {
  path: string;
  content: string;
}

export interface FileOperation {
  operations: Array<{
    type: 'modify' | 'create' | 'delete';
    path: string;
    diff?: string;
    description: string;
  }>;
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

function createAnalysisPrompt(request: string, sourceFiles: SourceFile[]): string {
  const xmlObj = {
    'file-analyzer': {
      role: {
        '#text': 'You are an AI assistant specialized in analyzing source code files to identify which ones need modification.'
      },
      rules: {
        rule: [
          'Only select files that are directly relevant to the requested changes',
          'Never select system files, build artifacts, or package management files',
          'Consider file relationships and dependencies',
          'Explain your reasoning for each selected file'
        ]
      },
      'output-format': {
        analysis: {
          'relevant-files': {
            '#text': 'Array of file paths that need modification'
          },
          reasoning: {
            '#text': 'Clear explanation of why each file was selected'
          }
        }
      },
      'source-files': {
        '@_count': sourceFiles.length,
        file: sourceFiles.map(f => ({
          '@_path': f.path,
          content: {
            __cdata: f.content
          }
        }))
      }
    }
  };

  return xmlBuilder.build(xmlObj);
}

function createModificationPrompt(request: string, sourceFiles: SourceFile[], relevantPaths: string[]): string {
  const relevantFiles = sourceFiles.filter(f => relevantPaths.includes(f.path));
  
  const xmlObj = {
    'file-modifier': {
      role: {
        '#text': 'You are an AI assistant specialized in generating precise git-style diffs for file modifications.'
      },
      rules: {
        rule: [
          'Generate changes as git-style unified diffs',
          'Always include 3 lines of context around changes',
          'Use proper diff headers with a/ and b/ prefixes',
          'Use + for additions and - for removals',
          'Ensure line numbers in @@ notation are correct',
          'Keep changes minimal and focused',
          'Preserve existing code style',
          'For new files, create a complete diff from empty file'
        ]
      },
      'output-format': {
        operation: {
          type: {
            '@_enum': 'modify,create,delete',
            '#text': 'Type of file operation'
          },
          path: {
            '@_format': 'relative-path',
            '#text': 'Path to the target file'
          },
          diff: {
            '@_format': 'git-diff',
            '#text': 'Changes in unified diff format'
          },
          description: {
            '@_format': 'text',
            '#text': 'Clear explanation of changes'
          }
        }
      },
      'diff-format': {
        template: {
          '#text': `diff --git a/[path] b/[path]
--- a/[path]
+++ b/[path]
@@ -[start],[lines] +[start],[lines] @@
[unchanged line]
-[removed line]
+[added line]
[unchanged line]`
        }
      },
      'source-files': {
        '@_count': relevantFiles.length,
        file: relevantFiles.map(f => ({
          '@_path': f.path,
          content: {
            __cdata: f.content
          }
        }))
      }
    }
  };

  return xmlBuilder.build(xmlObj);
}

// Schemas
export const fileOperationSchema = z.object({
  operations: z.array(
    z.object({
      type: z.enum(['modify', 'create', 'delete']),
      path: z.string(),
      diff: z.string().optional(),
      description: z.string()
    })
  )
});

// File Analysis Functions
async function analyzeRelevantFiles(request: string, sourceFiles: SourceFile[]) {
  const prompt = createAnalysisPrompt(request, sourceFiles);
  
  const { object: analysis } = await generateObject({
    model: anthropic("claude-3-5-haiku-20241022"),
    schema: z.object({
      relevantFiles: z.array(z.string()),
      reasoning: z.string()
    }),
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

  return analysis;
}

// File Operation Functions
async function applyModification(operation: FileOperation['operations'][number], sourceFiles: SourceFile[]) {
  if (!operation.diff) {
    throw new Error('Diff is required for modification');
  }

  const sourceFile = sourceFiles.find(f => f.path === operation.path);
  const oldContent = sourceFile ? sourceFile.content : '';

  try {
    // Parse and apply the diff
    const patches = parsePatch(operation.diff);
    if (patches.length !== 1) {
      throw new Error('Expected exactly one patch per file');
    }

    const patch = patches[0];
    const newContent = applyPatch(oldContent, patch);
    
    if (newContent === false) {
      throw new Error('Failed to apply patch');
    }

    // Create directory if needed
    const dirPath = dirname(operation.path);
    if (dirPath !== '.') {
      await execa('mkdir', ['-p', dirPath]);
    }

    // Write the modified content
    await writeFile(operation.path, newContent, 'utf-8');
    verboseLog(`Modified file: ${operation.path}`);

  } catch (error: unknown) {
    verboseLog('Error applying patch:', error);
    if (error instanceof Error) {
      throw new Error(`Failed to apply changes to ${operation.path}: ${error.message}`);
    }
    throw new Error(`Failed to apply changes to ${operation.path}: Unknown error`);
  }
}

export async function generateFileOperations(request: string, sourceFiles: SourceFile[]): Promise<FileOperation> {
  const spin = spinner();
  spin.start("Analyzing codebase for relevant files...");

  try {
    // Stage 1: Analyze files with Claude 3 Haiku
    const analysis = await analyzeRelevantFiles(request, sourceFiles);
    spin.stop(`Identified ${analysis.relevantFiles.length} relevant files`);
    verboseLog("File analysis reasoning", analysis.reasoning);

    // Stage 2: Generate modifications with Claude 3 Sonnet
    spin.start("Generating file modifications...");
    const prompt = createModificationPrompt(request, sourceFiles, analysis.relevantFiles);
    
    const { object } = await generateObject({
      model: anthropic("claude-3-5-sonnet-20241022"),
      schema: fileOperationSchema,
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

    spin.stop("Generated file modifications");
    return object;
  } catch (error) {
    spin.stop("Error generating file operations");
    throw error;
  }
}

export async function executeFileOperations(operations: FileOperation['operations'], sourceFiles: SourceFile[]) {
  const spin = spinner();
  spin.start("Executing file operations...");

  try {
    for (const operation of operations) {
      spin.message(`Executing operation: ${operation.type}`);
      verboseLog("Executing operation:", operation);

      switch (operation.type) {
        case 'modify':
        case 'create':
          await applyModification(operation, sourceFiles);
          break;
        case 'delete':
          await execa('rm', ['-f', operation.path]);
          verboseLog(`Deleted file: ${operation.path}`);
          break;
        default:
          throw new Error(`Unknown operation type: ${operation.type}`);
      }
    }

    spin.stop("File operations completed successfully");
    return operations;
  } catch (error) {
    spin.stop("File operations failed");
    verboseLog("Error in file operations:", error);
    throw error;
  }
}
