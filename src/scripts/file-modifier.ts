import { estimateTokensForClaude } from "../helpers/string";
import {
  type ProjectFiles,
  projectFiles,
  projectFilePath,
  ProjectFilePath,
  ProjectFileModification,
} from "../helpers/project-files";
import * as R from "remeda";
import { z } from "zod";
import { generateObject, generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import dedent from "dedent";
import { xml } from "../helpers/xml";
import { execa } from "execa";
import { applyPatches, createPatch } from "diff";
import { writeFile } from "fs/promises";
import { outro } from "@clack/prompts";
import type { DetailedLogger } from "../helpers/logger";

const projectFilesAnalysisSchema = z.object({
  creation: z
    .object({
      files_to_create: z
        .array(
          z.object({
            path: z.string(),
            why: z.string(),
          })
        )
        .optional(),
      files_to_modify: z
        .array(
          z.object({
            path: z.string(),
            why: z.string(),
          })
        )
        .optional(),
    })
    .optional(),
  removal: z
    .object({
      file_paths_to_remove: z.array(
        z.object({
          path: z.string(),
          why: z.string(),
        })
      ),
    })
    .optional(),
  // TODO: Include this in prompt
  module_dependencies: z.object({
    indirect: z
      .array(
        z.object({
          source_module_path: z.string(),
          dependent_modules: z.array(z.string()),
          why: z.string(),
        })
      )
      .optional(),
  }),
});

type ProjectFilesAnalysis = z.infer<typeof projectFilesAnalysisSchema>;

type ExecuteProjectFileAnalysisParams = Readonly<{
  executionStepRequest: string;
  allProjectFiles: ProjectFiles;
  detailedLogger: DetailedLogger;
}>;

export async function executeProjectFilesAnalysis({
  executionStepRequest,
  allProjectFiles,
  detailedLogger,
}: ExecuteProjectFileAnalysisParams) {
  detailedLogger.verboseLog("Starting project files analysis", {
    executionStepRequest,
  });
  detailedLogger.verboseLog("Files to analyze:", Object.keys(allProjectFiles));

  const analyzedProjectFilesPaths = new Set<ProjectFilePath>();
  const partialAnalysisResults: ProjectFilesAnalysis[] = [];

  {
    let currentBatchProjectFiles = projectFiles({});
    let currentBatchTokens = 0;

    for (;;) {
      // Check if all supplied files were analyzed, break the loop if yes
      if (
        R.pipe(
          [
            Array.from(analyzedProjectFilesPaths.keys()),
            R.keys(allProjectFiles),
          ],
          ([arr1, arr2]) => [
            R.sortBy(arr1, (x) => x.length),
            R.sortBy(arr2, (x) => x.length),
          ],
          ([sorted1, sorted2]) => R.isShallowEqual(sorted1, sorted2)
        )
      ) {
        detailedLogger.verboseLog("All files have been analyzed");
        break;
      }

      detailedLogger.verboseLog("Starting new batch analysis");
      for (const [filePath, fileContent] of Object.entries(allProjectFiles)) {
        if (analyzedProjectFilesPaths.has(projectFilePath(filePath))) {
          detailedLogger.verboseLog(
            `Skipping already analyzed file: ${filePath}`
          );
          continue;
        }

        const approxFileTokens = estimateTokensForClaude(fileContent);
        detailedLogger.verboseLog(
          `Estimated tokens for ${filePath}:`,
          approxFileTokens
        );

        // Check if adding this file would exceed token limit
        if (currentBatchTokens + approxFileTokens > 30000) {
          detailedLogger.verboseLog(
            `Token limit would be exceeded (${currentBatchTokens + approxFileTokens}/30000). Processing current batch.`
          );
          // Current batch is full, yield it
          if (Object.keys(currentBatchProjectFiles).length > 0) {
            break;
          }

          continue;
        }

        // Add file to current batch
        currentBatchTokens += approxFileTokens;
        currentBatchProjectFiles[projectFilePath(filePath)] = fileContent;
        detailedLogger.verboseLog(
          `Added ${filePath} to current batch. Current token count: ${currentBatchTokens}`
        );
      }

      detailedLogger.verboseLog("Generating analysis for current batch", {
        filesInBatch: Object.keys(currentBatchProjectFiles),
        tokenCount: currentBatchTokens,
      });

      const {
        object: partialProjectAnalysis,
        usage,
        experimental_providerMetadata,
      } = await generateObject({
        model: anthropic("claude-3-5-sonnet-latest", {
          cacheControl: true,
        }),
        schema: projectFilesAnalysisSchema,
        messages: [
          {
            role: "system",
            content: dedent`
              You are an experienced software developer specialized in Next.js ecosystem working as assistant that analyzes which source code files need modifications, which ones needs to be created and which needs to be deleted.

              Base on user request specified in <request> section. You follow strict rules, defined in the <rules> section. There are also <good> and <bad> examples and a way of thinking defined in <thinking> and <examples> sections.

              For the files, refer to the <files> section for paths and contents.

              ${xml.build({
                rules: {
                  rule: [
                    "Focus on code and configuration files",
                    "Do not mark files not present in the <files> section as modifications, all files that are meant to be created must not be included in the <files> section",
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
                // TODO: improve
                examples: {
                  good: [
                    {
                      user_request: {
                        "#text":
                          "Add million.js library for better performance",
                      },
                      analysis: {
                        "#text": JSON.stringify(
                          {
                            creation: {
                              file_paths_to_modify: ["next.config.mjs"],
                            },
                          },
                          null,
                          2
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
                            files_to_modify: ["package.json"],
                            reasoning: {
                              "package.json":
                                "Adding build:prod script for production builds",
                            },
                          },
                          null,
                          2
                        ),
                      },
                    },
                  ],
                  bad: [
                    {
                      user_request: {
                        "#text":
                          "Add million.js library for better performance",
                      },
                      analysis: {
                        "#text": JSON.stringify(
                          {
                            modifyFiles: ["package.json", "next.config.mjs"],
                            reasoning: {
                              "package.json": "Adding million.js dependency",
                              "next.config.mjs":
                                "Configure Million.js compiler",
                            },
                          },
                          null,
                          2
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
                              "package.json":
                                "Updating typescript dependency version",
                            },
                          },
                          null,
                          2
                        ),
                      },
                    },
                  ],
                },
              })}
            `,
          },
          {
            role: "user",
            content: dedent`
              Files that you need to work on:
              
              ${xml.build({
                files: {
                  file: Object.entries(projectFiles).map(
                    ([projectFilePath, projectFileContent]) => ({
                      "@_path": projectFilePath,
                      "#text": projectFileContent,
                    })
                  ),
                },
              })}
            `,

            experimental_providerMetadata: {
              anthropic: {
                cacheControl: { type: "ephemeral" },
              },
            },
          },
          {
            role: "user",
            content: dedent`
              User request for you:
              
              ${xml.build({
                request: {
                  "#text": executionStepRequest,
                },
              })}
            `,
          },
        ],
      });

      detailedLogger.usageLog("Analysis generation usage metrics", {
        usage,
        experimental_providerMetadata,
      });
      detailedLogger.verboseLog(
        "Received partial analysis result:",
        partialProjectAnalysis
      );
      partialAnalysisResults.push(partialProjectAnalysis);

      for (const currentBatchProjectFilePath of Object.keys(
        currentBatchProjectFiles
      )) {
        analyzedProjectFilesPaths.add(
          projectFilePath(currentBatchProjectFilePath)
        );
      }

      detailedLogger.verboseLog(
        "Batch completed. Analyzed files count:",
        analyzedProjectFilesPaths.size
      );
      currentBatchProjectFiles = projectFiles({});
      currentBatchTokens = 0;
    }
  }

  const completeProjectFileAnalysis = R.pipe(
    partialAnalysisResults,
    R.reduce((acc, obj) => R.mergeDeep(acc, obj), {})
  );

  detailedLogger.verboseLog(
    "Complete project file analysis:",
    completeProjectFileAnalysis
  );
  return completeProjectFileAnalysis as ProjectFilesAnalysis;
}

type ExecuteSingleFileModificationsParams = Readonly<{
  projectFileModification: ProjectFileModification;
  projectFilesAnalysis: ProjectFilesAnalysis;
  detailedLogger: DetailedLogger;
}>;

export async function executeSingleFileModifications({
  projectFileModification,
  projectFilesAnalysis,
  detailedLogger,
}: ExecuteSingleFileModificationsParams) {
  detailedLogger.verboseLog("Starting single file modification", {
    path: projectFileModification.path,
    operation: projectFileModification.operation,
    why: projectFileModification.why,
    originalContent: projectFileModification.content
  });

  if (projectFileModification.operation === "create") {
    detailedLogger.verboseLog(
      `Creating empty file at: ${projectFileModification.path}`
    );
    await execa("touch", [projectFileModification.path]);
    detailedLogger.verboseLog(
      `Created empty file at: ${projectFileModification.path}`
    );
  }

  detailedLogger.verboseLog("Generating file content modifications");
  const { text, usage, experimental_providerMetadata } = await generateText({
    model: anthropic("claude-3-5-sonnet-latest", {
      cacheControl: true,
    }),
    messages: [
      {
        role: "system",
        content: dedent`
          You are a senior Next.js software developer that creates precise single file modifications basing on user request following the rules specified in <rules> section. You take previous whole codebase analysis into consideration when modifying files, with the goal of making the codebase more efficient and maintainable, the analysis is specified in <analysis> section.
          
          You focus on both direct and indirect dependencies between modules in order to make the file future proof. 
          
          Apart from extensive programming knowledge, base your decisions on the knowledge sections, e.g. for Next.js specific knowledge refer to the <nextjs_general_knowledge> and <nextjs_versions_difference_knowledge> sections.

          ${xml.build({
            rules: {
              rule: [
                "Request regarding file modification is provided inside the <need_for_modification> section",
                "Generate complete, full, valid content for specified file",
                "Generate ONLY the file code content, do not include any other unnecessary information, explanations or comments in the code",
                "If applicable keep changes minimal and focused",
                "Preserve existing code structure and maintain consistent code style when modifying files",
              ],
            },
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
          })}
        `,
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: dedent`
              Whole code base analysis (only for reference and understanding purposes):
              
              ${xml.build({
                analysis: {
                  "#text": JSON.stringify(projectFilesAnalysis, null, 2),
                },
              })}
            `,
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
        content: `
          Specific analysis item basing on which you should create modifications:
          
          ${xml.build({
            need_for_modification: {
              "#text": projectFileModification.why,
            },
          })}

          Original file content (modify the code basing to the request):

          ${xml.build({
            modify_file_content: {
              "#text": projectFileModification.content,
            },
          })}
        `,
      },
    ],
  });

  detailedLogger.usageLog("File modification generation usage metrics", {
    usage,
    experimental_providerMetadata,
  });

  detailedLogger.verboseLog("Generated new file content", {
    path: projectFileModification.path,
    contentLength: text.length,
    content: text,
  });

  const originalFileContent =
    projectFileModification.operation === "create"
      ? ""
      : projectFileModification.content;

  if (projectFileModification.operation === "create") {
    detailedLogger.verboseLog(
      `Writing new file content to: ${projectFileModification.path}`
    );
    await writeFile(projectFileModification.path, text);
    outro(`Created file at: ${projectFileModification.path}`);
    return;
  }

  detailedLogger.verboseLog("Creating patch for file modifications");
  const patch = createPatch(
    projectFileModification.path.slice(
      projectFileModification.path.lastIndexOf("/")
    ),
    originalFileContent,
    text
  );

  detailedLogger.verboseLog("Applying patch to file");
  await new Promise((resolve, reject) => {
    applyPatches(patch, {
      loadFile: (_, callback) => {
        callback(undefined, originalFileContent);
      },
      patched: (_, content, callback) => {
        if (R.isNullish(content) || R.isEmpty(content)) {
          const error = new Error(
            `Failed to apply patch for ${projectFileModification.path}`
          );
          detailedLogger.verboseLog("Patch application failed", error);
          callback(error);
        } else {
          detailedLogger.verboseLog("Writing patched content to file");
          writeFile(projectFileModification.path, content)
            .then(() => {
              detailedLogger.verboseLog(
                "Successfully wrote patched content to file"
              );
              callback(undefined);
            })
            .catch((err) => {
              detailedLogger.verboseLog("Failed to write patched content", err);
              callback(err);
            });
        }
      },
      complete: (err) => {
        if (err) {
          detailedLogger.verboseLog(
            "Patch application completed with error",
            err
          );
          reject(err);
        } else {
          detailedLogger.verboseLog("Patch application completed successfully");
          resolve(void 0);
        }
      },
    });
  });
}
