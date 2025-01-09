import { anthropic } from "@ai-sdk/anthropic";
import { spinner } from "@clack/prompts";
import { generateObject } from "ai";
import { createHash } from "crypto";
import { deleteAsync } from "del";
import { mkdir, writeFile } from "fs/promises";
import { dirname } from "path";
import { z } from "zod";
import { verboseLog } from "../helpers/logger";
import { xml } from "../helpers/xml";
import { writeHistory } from "../helpers/history";
import { XMLBuilder } from "fast-xml-parser";

export interface SourceFile {
  path: string;
  content: string;
}

export interface FileOperation {
  type: "modify" | "create" | "delete";
  path: string;
  content?: string;
}

function createAnalysisPrompt() {
  const xmlObj = {
    analyzer: {
      role: {
        "#text":
          "You are an AI assistant that analyzes which source code files need modifications. You understand that package.json is special - it should only be modified for script changes, never for dependencies.",
      },
      rules: {
        general: {
          rule: [
            "Focus on code and configuration files",
            "Include files that need direct modifications",
            "Include related configuration files",
            "Skip binary files (.svg, .png)",
            "Consider import/export dependencies",
          ],
        },
        packageJson: {
          rule: [
            "Only include package.json if npm/yarn scripts need changes",
            "Never include package.json for dependency changes",
            "Never mention dependency changes in output",
          ],
        },
      },
      examples: {
        good: [
          {
            request: {
              "#text": "Add million.js library for better performance",
            },
            analysis: {
              "#text": JSON.stringify(
                {
                  modifyFiles: ["next.config.mjs", "app/layout.tsx"],
                  reasoning: {
                    "next.config.mjs": "Configure Million.js compiler",
                    "app/layout.tsx": "Add Million.js block wrapper",
                  },
                },
                null,
                2,
              ),
            },
          },
          {
            request: {
              "#text":
                "Add a new build command called 'build:prod' that uses production configuration",
            },
            analysis: {
              "#text": JSON.stringify(
                {
                  modifyFiles: ["package.json"],
                  reasoning: {
                    "package.json":
                      "Adding build:prod script for production builds",
                  },
                },
                null,
                2,
              ),
            },
          },
        ],
        bad: [
          {
            request: {
              "#text": "Add million.js library for better performance",
            },
            analysis: {
              "#text": JSON.stringify(
                {
                  modifyFiles: ["package.json", "next.config.mjs"],
                  reasoning: {
                    "package.json": "Adding million.js dependency",
                    "next.config.mjs": "Configure Million.js compiler",
                  },
                },
                null,
                2,
              ),
            },
          },
          {
            request: {
              "#text": "Update TypeScript version",
            },
            analysis: {
              "#text": JSON.stringify(
                {
                  modifyFiles: ["package.json"],
                  reasoning: {
                    "package.json": "Updating typescript dependency version",
                  },
                },
                null,
                2,
              ),
            },
          },
        ],
      },
    },
  };

  return xml.build(xmlObj);
}

function createBulkModificationPrompt(
  request: string,
  filesToModify: SourceFile[],
  contextFiles: SourceFile[],
  newFilePaths: string[],
  analysis: z.infer<typeof fileAnalysisSchema>,
) {
  const xmlObj = {
    modifier: {
      role: {
        "#text":
          "You are an AI assistant that generates precise file modifications. You understand that package.json modifications are only for script changes. Your response must be a valid JSON object with 'modifications' and 'newFiles' arrays.",
      },
      rules: {
        general: {
          rule: [
            "Generate complete, valid content for each file",
            "Keep changes minimal and focused",
            "Preserve existing code structure",
            "Maintain consistent style",
            "Always return modifications as an array of objects, never as a string",
            "Each modification must have path, content, and description fields",
            "Content can be a string or an object (for package.json)",
            "Only modify files listed in the analysis.modifyFiles",
            "Only create files listed in the analysis.createFiles",
          ],
        },
        packageJson: {
          rule: [
            "Only modify the scripts field",
            "Preserve all other fields exactly",
            "Never modify dependencies",
            "Never add package.json to newFiles array",
          ],
        },
      },
      examples: {
        good: {
          modifications: {
            "#text": JSON.stringify(
              {
                modifications: [
                  {
                    path: "package.json",
                    content: {
                      scripts: {
                        "build:prod":
                          "cross-env NODE_ENV=production next build",
                      },
                    },
                    description: "Added production build script",
                  },
                ],
                newFiles: [],
              },
              null,
              2,
            ),
          },
        },
        bad: {
          modifications: {
            "#text": JSON.stringify(
              {
                modifications: "[]", // Wrong: string instead of array
                newFiles: null, // Wrong: null instead of array
              },
              null,
              2,
            ),
          },
        },
      },
      request: {
        "#text": request,
      },
      analysis: {
        modifyFiles: analysis.modifyFiles,
        createFiles: analysis.createFiles,
        reasoning: analysis.reasoning,
      },
      filesToModify: {
        file: filesToModify.map((f) => ({
          "@_path": f.path,
          content: {
            "#text": f.content,
          },
        })),
      },
      contextFiles: {
        file: contextFiles.map((f) => ({
          "@_path": f.path,
          content: {
            "#text": f.content,
          },
        })),
      },
      newFiles: {
        path: newFilePaths,
      },
    },
  };

  const xmlString = xml.build(xmlObj);
  verboseLog("Generated XML for bulk modifications:", xmlString);

  return xmlString;
}

async function generateBulkModifications(
  request: string,
  filesToModify: SourceFile[],
  contextFiles: SourceFile[],
  newFilePaths: string[],
  analysis: z.infer<typeof fileAnalysisSchema>,
) {
  const prompt = createBulkModificationPrompt(
    request,
    filesToModify,
    contextFiles,
    newFilePaths,
    analysis,
  );

  verboseLog("Generating bulk modifications with prompt:", prompt);

  try {
    const { object } = await generateObject({
      model: anthropic("claude-3-5-sonnet-20241022"),
      schema: bulkModificationSchema,
      maxRetries: 2,
      messages: [
        {
          role: "system",
          content: prompt,
        },
        {
          role: "user",
          content: `Generate complete content for all files that need to be modified or created based on the request: ${request}. Return a JSON object with 'modifications' and 'newFiles' arrays. Each modification should have 'path', 'content', and 'description' fields.`,
        },
      ],
    });

    verboseLog("Object after schema processing:", object);

    // For package.json modifications, only allow changes to scripts
    if (object.modifications) {
      object.modifications = object.modifications.map((mod) => {
        if (mod.path === "package.json") {
          try {
            const currentContent =
              typeof mod.content === "string"
                ? JSON.parse(mod.content)
                : mod.content;
            const existingPackageJson = filesToModify.find(
              (f) => f.path === "package.json",
            );
            if (existingPackageJson) {
              const existing = JSON.parse(existingPackageJson.content);
              return {
                ...mod,
                content: JSON.stringify(
                  {
                    ...existing,
                    scripts: currentContent.scripts || existing.scripts,
                  },
                  null,
                  2,
                ),
              };
            }
          } catch (e) {
            verboseLog("Failed to process package.json modification", e);
          }
        }
        return mod;
      });
    }

    return object;
  } catch (error) {
    verboseLog("Error in generateBulkModifications:", error);
    if (error instanceof Error) {
      verboseLog("Error message:", error.message);
      verboseLog("Error stack:", error.stack);
    }
    throw error;
  }
}

// Analysis response schema
const fileAnalysisSchema = z.object({
  modifyFiles: z.array(z.string()),
  createFiles: z.array(z.string()),
  contextFiles: z.array(z.string()),
  reasoning: z.object({
    modifications: z.record(z.string()),
    newFiles: z.record(z.string()),
    context: z.record(z.string()),
  }),
});

// Bulk modification response schema
const bulkModificationSchema = z.object({
  modifications: z
    .array(
      z.object({
        path: z.string(),
        content: z.union([z.string(), z.record(z.any())]).transform((val) => {
          verboseLog("Transforming content value:", val);
          const result =
            typeof val === "string" ? val : JSON.stringify(val, null, 2);
          verboseLog("Transformed content result:", result);
          return result;
        }),
      }),
    )
    .default([]),
  newFiles: z
    .array(
      z.object({
        path: z.string(),
        content: z.string(),
      }),
    )
    .default([]),
});

const fileOperationMetadataSchema = z.object({
  type: z.enum(["modify", "create", "delete"]),
  path: z.string(),
  content: z.string().optional(),
});

const fileOperationSchema = z.object({
  type: z.enum(["modify", "create", "delete"]),
  path: z.string(),
  content: z.string().optional(),
});

const fileOperationsSchema = z.object({
  operations: z.array(fileOperationMetadataSchema),
});

interface AnalysisCache {
  key: string;
  result: z.infer<typeof fileAnalysisSchema>;
  timestamp: number;
}

const analysisCache = new Map<string, AnalysisCache>();
const CACHE_TTL = 5 * 60 * 1000;

function generateCacheKey(request: string, sourceFiles: SourceFile[]) {
  const content = JSON.stringify({ request, sourceFiles });
  return createHash("md5").update(content).digest("hex");
}

function getCachedAnalysis(key: string) {
  const cached = analysisCache.get(key);
  if (!cached) return null;

  const now = Date.now();
  if (now - cached.timestamp > CACHE_TTL) {
    analysisCache.delete(key);
    return null;
  }

  return cached.result;
}

async function analyzeFiles(
  request: string,
  sourceFiles: SourceFile[],
): Promise<z.infer<typeof fileAnalysisSchema>> {
  const cacheKey = generateCacheKey(request, sourceFiles);
  const cachedResult = getCachedAnalysis(cacheKey);
  if (cachedResult) {
    verboseLog("Using cached analysis result");
    return cachedResult;
  }

  const spin = spinner();
  spin.start("Analyzing files");

  const { object } = await generateObject({
    model: anthropic("claude-3-5-haiku-20241022", {
      cacheControl: true,
    }),
    schema: fileAnalysisSchema,
    maxRetries: 2,
    messages: [
      {
        role: "system",
        content: createAnalysisPrompt(),
        experimental_providerMetadata: {
          anthropic: { cacheControl: { type: "ephemeral" } },
        },
      },
      {
        role: "user",
        content: xml.build({
          userRequest: {
            "#text": request,
          },
          files: sourceFiles.map((f) => ({
            "@_path": f.path,
            content: {
              "#text": f.content,
            },
          })),
        }),
      },
    ],
  });

  spin.stop("File analysis complete");

  // Cache the result
  analysisCache.set(cacheKey, {
    key: cacheKey,
    result: object,
    timestamp: Date.now(),
  });

  return object;
}

export async function generateFileOperations(
  request: string,
  sourceFiles: SourceFile[],
) {
  const operations: FileOperation[] = [];
  verboseLog("Starting file operations generation for request:", request);
  verboseLog(
    "Source files:",
    sourceFiles.map((f) => f.path),
  );

  const analysis = await analyzeFiles(request, sourceFiles);
  verboseLog("File analysis completed:", analysis);

  // Get files to modify based on analysis
  const filesToModify = sourceFiles.filter((f) =>
    analysis.modifyFiles.includes(f.path),
  );
  verboseLog(
    "Files to modify:",
    filesToModify.map((f) => f.path),
  );

  const contextFiles = sourceFiles.filter(
    (f) =>
      analysis.contextFiles.includes(f.path) &&
      !analysis.modifyFiles.includes(f.path),
  );
  verboseLog(
    "Context files:",
    contextFiles.map((f) => f.path),
  );

  const spin = spinner();
  spin.start("Generating file modifications");

  try {
    const modifications = await generateBulkModifications(
      request,
      filesToModify,
      contextFiles,
      analysis.createFiles,
      analysis,
    );
    verboseLog("Generated modifications:", modifications);

    // Handle modifications
    if (modifications.modifications && modifications.modifications.length > 0) {
      verboseLog(
        `Processing ${modifications.modifications.length} modifications`,
      );
      for (const mod of modifications.modifications) {
        verboseLog(`Adding modification operation for ${mod.path}`);
        verboseLog(`Content length: ${mod.content?.length || 0} characters`);
        operations.push({
          type: "modify",
          path: mod.path,
          content: mod.content,
        });
      }
    } else {
      verboseLog("No modifications were generated");
    }

    // Handle new files
    if (modifications.newFiles && modifications.newFiles.length > 0) {
      verboseLog(`Processing ${modifications.newFiles.length} new files`);
      for (const file of modifications.newFiles) {
        verboseLog(`Adding create operation for ${file.path}`);
        verboseLog(`Content length: ${file.content?.length || 0} characters`);
        operations.push({
          type: "create",
          path: file.path,
          content: file.content,
        });
      }
    } else {
      verboseLog("No new files were generated");
    }

    spin.stop("File modifications generated");
    verboseLog(`Total operations generated: ${operations.length}`);
    verboseLog("Operations:", operations);

    writeHistory({
      op: "file-operation",
      d: request,
      dt: {
        modifications: operations,
        contextFiles: contextFiles.map((f) => ({
          path: f.path,
          content: f.content,
        })),
      },
    });

    return operations;
  } catch (error) {
    spin.stop("Failed to generate file modifications");
    verboseLog("Error generating modifications:", error);
    throw error;
  }
}

/**
 * Execute file operations
 */
export async function executeFileOperations(
  operations: FileOperation[],
): Promise<void> {
  verboseLog(`Starting execution of ${operations.length} file operations`);

  for (const operation of operations) {
    verboseLog(`Processing operation: ${operation.type} for ${operation.path}`);
    verboseLog(`Operation type: ${operation.type}`);
    verboseLog(`Operation path: ${operation.path}`);

    if (operation.type === "create") {
      const dir = dirname(operation.path);
      verboseLog(`Creating directory: ${dir}`);
      await mkdir(dir, { recursive: true });
      if (!operation.content) {
        throw new Error(
          `No content provided for create operation on ${operation.path}`,
        );
      }
      verboseLog(`Writing new file: ${operation.path}`);
      await writeFile(operation.path, operation.content);
      verboseLog(`Created file: ${operation.path}`);
    } else if (operation.type === "modify" && operation.content) {
      try {
        verboseLog(`Modifying file: ${operation.path}`);
        verboseLog(`Content length: ${operation.content.length} characters`);
        await writeFile(operation.path, operation.content);
        verboseLog(`Successfully modified file: ${operation.path}`);
      } catch (error) {
        verboseLog("Error details:");
        verboseLog(`File: ${operation.path}`);
        verboseLog(
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
    } else if (operation.type === "delete") {
      verboseLog(`Deleting file: ${operation.path}`);
      await deleteAsync(operation.path, { force: true });
      verboseLog(`Deleted file: ${operation.path}`);
    }
  }

  verboseLog("All file operations completed successfully");
}
