import { anthropic } from "@ai-sdk/anthropic";
import { spinner } from "@clack/prompts";
import { generateObject, generateText } from "ai";
import { deleteAsync } from "del";
import { createPatch, applyPatch } from "diff";
import { execa } from "execa";
import { readFile, writeFile } from "fs/promises";
import { dirname } from "path";
import { z } from "zod";
import { verboseLog } from "../helpers/logger";
import { XMLBuilder } from "fast-xml-parser";
import { existsSync } from "fs";

// Constants
const MAX_FILE_SIZE = 100 * 1024; // 100KB
const EXCLUDED_PATTERNS = [
  "**/node_modules/**",
  "**/*.tsbuildinfo",
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
];

// Types
export interface SourceFile {
  path: string;
  content: string;
}

export interface FileOperation {
  type: "modify" | "create" | "delete";
  path: string;
  content?: string;
  description: string;
}

// XML Builder Configuration
const xmlBuilder = new XMLBuilder({
  format: true,
  indentBy: "  ",
  ignoreAttributes: false,
  suppressUnpairedNode: false,
  suppressBooleanAttributes: false,
  cdataPropName: "__cdata",
});

function createAnalysisPrompt(
  request: string,
  sourceFiles: SourceFile[]
): string {
  const xmlObj = {
    "file-analyzer": {
      role: {
        "#text":
          "You are an AI assistant specialized in analyzing source code files to identify which ones need modification.",
      },
      rules: {
        rule: [
          "Identify files that need to be modified or created",
          "Consider file relationships and dependencies",
          "Never select system files, build artifacts, or package management files",
          "Explain your reasoning for each selected file",
          "Include paths for new files that need to be created",
          "Prefer external configuration files over package.json modifications",
        ],
      },
      "source-files": {
        "@_count": sourceFiles.length,
        file: sourceFiles.map((f) => ({
          "@_path": f.path,
          content: {
            "#cdata": f.content,
          },
        })),
      },
    },
  };

  return xmlBuilder.build(xmlObj);
}

function createModificationPrompt(
  request: string,
  filesToModify: SourceFile[],
  newFilePaths: string[]
): string {
  const xmlObj = {
    "file-modifier": {
      role: {
        "#text":
          "You are a file modification expert that helps users modify their codebase.",
      },
      rules: {
        critical_rules: {
          rule: [
            "Always provide complete file content for modifications and new files",
            "Never try to generate diffs or patches manually",
            "Keep file content as plain text, even for JSON files",
            "Include all necessary imports and dependencies",
            "Maintain consistent code style",
            "Consider file relationships and dependencies",
            "Prefer external configuration over package.json modifications",
          ],
        },
        output_rules: {
          rule: [
            "Always return complete file contents, not partial changes",
            "Preserve important formatting and whitespace",
            "Include clear descriptions of changes",
            "Keep JSON files as stringified content",
            "Return one operation at a time",
          ],
        },
      },
      context: {
        request: {
          "#text": request,
        },
        "existing-files": {
          file: filesToModify.map((f) => ({
            path: f.path,
            content: {
              "#cdata": f.content,
            },
          })),
        },
        "new-files": {
          path: newFilePaths,
        },
      },
    },
  };

  return xmlBuilder.build(xmlObj);
}

// Schema for file analysis
const fileAnalysisSchema = z.object({
  modifyFiles: z.array(z.string()),
  createFiles: z.array(z.string()),
  deleteFiles: z.array(z.string()),
  reasoning: z.string(),
});

// Schema for file operation metadata
const fileOperationMetadataSchema = z.object({
  type: z.enum(["modify", "create", "delete"]),
  path: z.string(),
  description: z.string(),
});

// Schema for a single file operation
const fileOperationSchema = z.object({
  type: z.enum(["modify", "create", "delete"]),
  path: z.string(),
  content: z.string(),
  description: z.string(),
});

// Schema for file operations array
const fileOperationsSchema = z.array(fileOperationMetadataSchema);

export type FileOperationResult = z.infer<typeof fileOperationSchema>;

/**
 * Analyze which files need to be modified or created
 */
async function analyzeFiles(
  request: string,
  sourceFiles: SourceFile[]
): Promise<z.infer<typeof fileAnalysisSchema>> {
  const spin = spinner();
  spin.start("Analyzing files...");

  try {
    const { object } = await generateObject({
      model: anthropic("claude-3-5-haiku-20241022"),
      schema: fileAnalysisSchema,
      maxRetries: 0,
      messages: [
        {
          role: "system",
          content: createAnalysisPrompt(request, sourceFiles),
        },
        {
          role: "user",
          content: request,
        },
      ],
    });

    spin.stop("File analysis complete");
    verboseLog("File analysis result:", object);
    return object;
  } catch (error) {
    spin.stop("File analysis failed");
    verboseLog("Error analyzing files:", error);
    throw error;
  }
}

/**
 * Apply a single file operation using diffs
 */
async function applyOperation(operation: FileOperationResult): Promise<void> {
  try {
    if (operation.type === "create" && operation.content) {
      // Ensure directory exists
      const dirPath = dirname(operation.path);
      if (dirPath !== "." && !existsSync(dirPath)) {
        await execa("mkdir", ["-p", dirPath]);
      }
      await writeFile(operation.path, operation.content);
      verboseLog(`Created file: ${operation.path}`);
    } else if (operation.type === "modify" && operation.content) {
      // Read existing content
      const oldContent = await readFile(operation.path, "utf-8");

      // Generate patch
      const patch = createPatch(operation.path, oldContent, operation.content);

      // Apply patch
      const newContent = applyPatch(oldContent, patch);
      if (typeof newContent !== "string") {
        throw new Error(`Failed to apply patch to ${operation.path}`);
      }

      // Write new content
      await writeFile(operation.path, newContent);
      verboseLog(`Modified file: ${operation.path}`);
    } else if (operation.type === "delete") {
      await deleteAsync(operation.path, { force: true });
      verboseLog(`Deleted file: ${operation.path}`);
    }
  } catch (error) {
    verboseLog("Error during file operation:", error);
    throw error;
  }
}

/**
 * Generate file operations based on the request
 */
export async function generateFileOperations(
  request: string,
  sourceFiles: SourceFile[]
): Promise<FileOperationResult[]> {
  const spin = spinner();

  try {
    // Stage 1: Analyze files with Claude 3 Haiku
    spin.start("Analyzing codebase...");
    const analysis = await analyzeFiles(request, sourceFiles);
    spin.stop(
      `Identified ${analysis.modifyFiles.length + analysis.createFiles.length} files to modify/create`
    );

    // Prepare files for modification prompt
    const filesToModify = sourceFiles.filter((f) =>
      analysis.modifyFiles.includes(f.path)
    );
    const existingFiles = new Set(sourceFiles.map((f) => f.path));
    const newFilePaths = analysis.createFiles.filter(
      (path) => !existingFiles.has(path)
    );

    // Stage 2: Generate modifications with Claude 3 Sonnet
    spin.start("Generating file modifications...");

    // First get operation metadata
    const { object: operationsMetadata } = await generateObject({
      model: anthropic("claude-3-5-sonnet-20241022"),
      schema: fileOperationsSchema,
      maxRetries: 3,
      messages: [
        {
          role: "system",
          content: createModificationPrompt(
            request,
            filesToModify,
            newFilePaths
          ),
        },
        {
          role: "user",
          content: request,
        },
      ],
    });

    // Then generate content for each operation
    const operations = await Promise.all(
      operationsMetadata.map(async (op): Promise<FileOperationResult> => {
        if (op.type === "delete") {
          return {
            ...op,
            content: "", // Empty content for delete operations
          };
        }

        const content = await generateText({
          model: anthropic("claude-3-5-sonnet-20241022"),
          messages: [
            {
              role: "system",
              content: `Generate the complete content for the file ${op.path}. Return only the file content, no explanations.`,
            },
            {
              role: "user",
              content: `Generate the content for ${op.path} based on this request: ${request}`,
            },
          ],
        });

        return {
          ...op,
          content: content.toString(),
        };
      })
    );

    spin.stop("Generated file modifications");
    return operations;
  } catch (error) {
    spin.stop("Failed to generate file operations");
    verboseLog("Error generating file operations:", error);
    throw error;
  }
}

/**
 * Execute file operations
 */
export async function executeFileOperations(
  operations: FileOperationResult[]
): Promise<void> {
  const spin = spinner();
  spin.start("Applying file changes...");

  try {
    // Apply operations sequentially
    for (const operation of operations) {
      await applyOperation(operation);
    }
    spin.stop("File changes applied successfully");
  } catch (error) {
    spin.stop("Failed to apply file changes");
    throw error;
  }
}
