import { anthropic } from "@ai-sdk/anthropic";
import { spinner } from "@clack/prompts";
import { generateObject } from "ai";
import { deleteAsync } from "del";
import { mkdir, writeFile } from "fs/promises";
import { dirname } from "path";
import { z } from "zod";
import { verboseLog } from "../helpers/logger";
import { xml } from "../helpers/xml";
import { writeHistory } from "../helpers/history";
import { applyPatches, createPatch } from "diff";
import { isEmpty, isNullish } from "remeda";
import {
  type ProjectFiles,
  type projectFilePath,
  projectFiles,
} from "../helpers/project-files";

export interface FileOperation {
  type: "modify" | "create" | "delete";
  path: string;
  content?: string;
}

function createAnalysisPrompt() {
  const xmlObj = {
    role: {
      "#text":
        "You are an experienced software developer working as assistant that analyzes which source code files need modifications basing on user request.",
    },
    rules: {
      rule: [
        "Focus on code and configuration files",
        "Include files that need both direct and indirect modifications",
        "Analyze the coupling between various modules",
        "Include related configuration files",
        "Consider import/export dependencies",
        "Consider obsolete functionality basing on your knowledge",
        "ONLY include package.json if npm/yarn 'scripts' field need changes",
        "NEVER include package.json for dependency changes",
        "NEVER mention dependency changes in output",
      ],
    },
    examples: {
      good: [
        {
          user_request: {
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
          user_request: {
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
          user_request: {
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
          user_request: {
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
  };

  return xml.build(xmlObj);
}

function createBulkModificationPrompt() {
  const xmlObj = {
    role: {
      "#text":
        "You are a senior Next.js software developer that creates precise file modifications basing on user request. You strictly follow the rules specified in <rules> section. Apart from extensive programming knowledge, base your decisions on the knowledge provided inside the <knowledge_base> section",
    },
    rules: {
      general: {
        rule: [
          "User request regarding file modifications is provided inside the <user_request> section",
          "Generate complete, full, valid content for each file",
          "If applicable keep changes minimal and focused",
          "Preserve existing code structure and maintain consistent code style",
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

    knowledge_base: {
      nextjs_general_knowledge: {
        knowledge: [
          "Next.js 15 key identifiers: Server Actions are default, no 'use server' needed; Parallel Routes with @parallel directory convention; Partial Prerendering enabled by default",

          "React 19 markers: useOptimistic hook replaces experimental version; use hook for promises (use server); Document API for SSR optimization; useFormStatus for form state management",

          "Legacy detection: follow the <nextjs_versions_difference_knowledge> section. React <18 lacks automatic batching and Suspense SSR",

          "Version-specific file patterns: Next.js 15 uses middleware.ts with expanded matcher support; React 19 enables <use> directive in client components",

          "Dependency requirements: Next.js 15 requires React 19 as peer dependency; incompatible with React <18",
        ],
      },
      nextjs_versions_difference_knowledge: {
        knowledge: [
          "Routing differences: Next.js 15.x and 14.x supports both app/ and pages/, <13 pages/ only, <12 no middleware.ts file",

          "File structure evolution: Modern uses app/layout.tsx, middleware.ts, error.tsx; Legacy uses _app.tsx, _document.tsx, pages/_error.tsx",

          "API implementation: Modern uses Response/Request object handlers from the Web API; Legacy relies on res.json() pattern and Connect/express like Request and Response objects",

          "React version compatibility: 19 (use hooks, Document API), 18 (batching, Suspense), <18 (no concurrent), <17 (manual JSX)",

          "TypeScript integration: Modern has built-in types and strict mode; Legacy requires @types/react with loose checking",

          "Performance tooling: Next.js 15 adds Turbopack by default, partial prerendering stable support, expanded Suspense; Earlier versions use webpack, lack streaming",
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
                      "build:prod": "cross-env NODE_ENV=production next build",
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
  };

  const xmlString = xml.build(xmlObj);
  verboseLog("Generated XML for bulk modifications:", xmlString);

  return xmlString;
}

async function generateBulkModifications(
  userRequest: string,
  filesToModify: ProjectFiles,
  contextFiles: ProjectFiles,
  filesAnalysis: z.infer<typeof fileAnalysisSchema>,
) {
  try {
    const { object } = await generateObject({
      model: anthropic("claude-3-5-sonnet-20241022", {
        cacheControl: true,
      }),
      schema: bulkModificationSchema,
      messages: [
        {
          role: "system",
          content: createBulkModificationPrompt(),
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: xml.build({
                analysis: {
                  reasoning: {
                    "#text": filesAnalysis.reasoning,
                  },
                },
                files_to_modify: {
                  file: Object.entries(filesToModify).map(
                    ([filePath, fileContent]) => ({
                      "@_path": filePath,
                      content: {
                        "#text": fileContent,
                      },
                    }),
                  ),
                },
                context_knowledge_files: {
                  file: Object.entries(contextFiles).map(
                    ([contextFilePath, contextFileContent]) => ({
                      "@_path": contextFilePath,
                      content: {
                        "#text": contextFileContent,
                      },
                    }),
                  ),
                },
                // TODO: ?
                new_files: {
                  file: filesAnalysis.createFiles.map((fileToCreate) => ({
                    "@_path": fileToCreate,
                  })),
                },
              }),
            },
          ],
          experimental_providerMetadata: {
            anthropic: { cacheControl: { type: "ephemeral" } },
          },
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: xml.build({
                user_request: {
                  "#text": userRequest,
                },
              }),
            },
          ],
        },
      ],
    });

    verboseLog("Object after schema processing:", object);

    // TODO: improve
    // For package.json modifications, only allow changes to scripts
    if (object.modifications) {
      object.modifications = object.modifications.map((modification) => {
        if (modification.path === "package.json") {
          try {
            const currentContent =
              typeof modification.content === "string"
                ? JSON.parse(modification.content)
                : modification.content;

            const existingPackageJson = Object.entries(filesToModify).find(
              ([filePath]) => filePath === "package.json",
            );

            if (existingPackageJson) {
              const [, existingPackageJsonContent] = existingPackageJson;
              const existing = JSON.parse(existingPackageJsonContent);
              return {
                ...modification,
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
          } catch (error) {
            verboseLog("Failed to process package.json modification", error);
          }
        }
        return modification;
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

// const fileOperationMetadataSchema = z.object({
//   type: z.enum(["modify", "create", "delete"]),
//   path: z.string(),
//   content: z.string().optional(),
// });

// const fileOperationSchema = z.object({
//   type: z.enum(["modify", "create", "delete"]),
//   path: z.string(),
//   content: z.string().optional(),
// });

// const fileOperationsSchema = z.object({
//   operations: z.array(fileOperationMetadataSchema),
// });

async function analyzeFiles(
  request: string,
  sourceFiles: ProjectFiles,
): Promise<z.infer<typeof fileAnalysisSchema>> {
  const spin = spinner();
  spin.start("Analyzing files");

  const { object } = await generateObject({
    model: anthropic("claude-3-5-haiku-20241022", {
      cacheControl: true,
    }),
    schema: fileAnalysisSchema,
    messages: [
      {
        role: "system",
        content: createAnalysisPrompt(),
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: xml.build({
              files: Object.keys(sourceFiles).map(
                ([filePath, fileContent]) => ({
                  "@_path": filePath,
                  content: {
                    "#text": fileContent,
                  },
                }),
              ),
            }),
          },
        ],
        experimental_providerMetadata: {
          anthropic: { cacheControl: { type: "ephemeral" } },
        },
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: xml.build({
              user_request: {
                "#text": request,
              },
            }),
          },
        ],
      },
    ],
  });

  spin.stop("File analysis complete");

  return object;
}

export async function generateFileOperations(
  request: string,
  sourceFiles: ProjectFiles,
) {
  const operations: FileOperation[] = [];
  verboseLog("Starting file operations generation for request:", request);
  verboseLog("Source files:", Object.keys(sourceFiles));

  const analysis = await analyzeFiles(request, sourceFiles);
  verboseLog("File analysis completed:", analysis);

  // Get files to modify based on analysis
  const filesToModify = projectFiles.filter(sourceFiles, ([filePath]) =>
    analysis.modifyFiles.includes(filePath),
  );

  verboseLog(
    "Files to modify:",
    Object.keys(filesToModify),
  );

  const contextFiles = projectFiles.filter(sourceFiles,
    ([filePath]) =>
      analysis.contextFiles.includes(filePath) &&
      !analysis.modifyFiles.includes(filePath),
  );
  
  verboseLog(
    "Context files:",
    Object.keys(contextFiles),
  );

  const spin = spinner();
  spin.start("Generating file modifications");

  try {
    const modifications = await generateBulkModifications(
      request,
      filesToModify,
      contextFiles,
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
        contextFiles,
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
  originalFiles: ProjectFiles,
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

      const specificOriginalFile = Object.entries(originalFiles).find(
        ([originalFilePath, originalFileContent]) => originalFilePath === operation.path,
      );

      if (isNullish(specificOriginalFile)) {
        throw new Error(
          `Could not find original file for operation ${operation.path}`,
        );
      }

      const
[[specificOriginalFilePath, specificOriginalFileContent]] = specificOriginalFile

      const patch = createPatch(
        operation.path.slice(operation.path.lastIndexOf("/")),
        specificOriginalFileContent,
        operation.content,
      );

      await new Promise((resolve, reject) => {
        applyPatches(patch, {
          loadFile: (_, callback) => {
            callback(undefined, specificOriginalFileContent);
          },
          patched: (_, content, callback) => {
            if (isNullish(content) || isEmpty(content)) {
              callback(
                new Error(`Failed to apply patch for ${operation.path}`),
              );
            } else {
              writeFile(operation.path, content)
                .then(() => callback(undefined))
                .catch((err) => callback(err));
            }
          },
          complete: (err) => {
            if (err) reject(err);
            else resolve(void 0);
          },
        });
      });

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
