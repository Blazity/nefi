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
import { log, outro } from "@clack/prompts";
import type { DetailedLogger } from "../helpers/logger";
import { BaseScriptHandler, ScriptHandler, PromptFunction, type ScriptContext, type LLMMessage } from "../scripts-registry";
import { deleteAsync } from "del";

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

@ScriptHandler({
  requirements: {
    requiredFilesByPathWildcard: ["**/*"],
    excludedFilesByPathWildcard: [
      "**/node_modules/**",
      "**/*.tsbuildinfo",
      "**/.git/**",
      "**/package-lock.json",
      "**/LICENSE",
      "**/README.md",
      "**/yarn-error.log",
      "**/pnpm-error.log",
      "**/bun-error.log",
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
    ],
  }
})
export class FileModifierHandler extends BaseScriptHandler {
  constructor() {
    super();
  }

  async execute({
    files,
    executionStepDescription,
    detailedLogger,
  }: ScriptContext): Promise<void> {
    const projectFilesAnalysis = await this.executeProjectFilesAnalysis({
      executionStepRequest: executionStepDescription,
      allProjectFiles: files,
      detailedLogger,
    });

    const filesToProcess = R.pipe(
      [
        (projectFilesAnalysis.creation?.files_to_modify ?? []).map(
          ({ path, why }) => ({
            path: projectFilePath(path),
            why,
            operation: "modify" as const,
            content: files[projectFilePath(path)],
          })
        ),
        (projectFilesAnalysis.creation?.files_to_create ?? []).map(
          ({ path, why }) => ({
            path: projectFilePath(path),
            operation: "create" as const,
            why,
          })
        ),
      ],
      R.flat(),
      R.filter(R.isNonNullish)
    ) as ProjectFileModification[];

    detailedLogger.verboseLog(
      `Files to process: ${JSON.stringify(filesToProcess, null, 2)}`
    );

    for (const projectFileModification of filesToProcess) {
      await this.executeSingleFileModifications({
        detailedLogger,
        projectFileModification,
        projectFilesAnalysis,
      });
    }

    if (projectFilesAnalysis.removal?.file_paths_to_remove) {
      for (const { path } of projectFilesAnalysis.removal.file_paths_to_remove) {
        await deleteAsync(path);
        detailedLogger.verboseLog(`Safely deleted project file: ${path}`);
      }
    }
  }

  @PromptFunction()
  private async executeProjectFilesAnalysis({
    executionStepRequest,
    allProjectFiles,
    detailedLogger,
  }: {
    executionStepRequest: string;
    allProjectFiles: ProjectFiles;
    detailedLogger: DetailedLogger;
  }): Promise<ProjectFilesAnalysis> {
    detailedLogger.verboseLog("Starting project files analysis", {
      executionStepRequest,
    });
    detailedLogger.verboseLog(
      "Files to analyze:",
      Object.keys(allProjectFiles)
    );

    const analyzedProjectFilesPaths = new Set<ProjectFilePath>();
    const partialAnalysisResults: ProjectFilesAnalysis[] = [];

    {
      let currentBatchProjectFiles = projectFiles({});
      let currentBatchTokens = 0;

      for (;;) {
        detailedLogger.verboseLog("=== Loop iteration start ===");
        detailedLogger.verboseLog("Current analyzed files:", {
          analyzedCount: analyzedProjectFilesPaths.size,
          analyzedPaths: Array.from(analyzedProjectFilesPaths),
        });
        detailedLogger.verboseLog("Total files to analyze:", {
          totalCount: Object.keys(allProjectFiles).length,
          allPaths: Object.keys(allProjectFiles),
        });

        // Check if all supplied files were analyzed, break the loop if yes
        const analyzedPaths = Array.from(analyzedProjectFilesPaths);
        const allPaths = Object.keys(allProjectFiles).map((p) =>
          projectFilePath(p)
        );
        const sortedAnalyzed = R.sortBy(analyzedPaths, (x) => x.length);
        const sortedAll = R.sortBy(allPaths, (x) => x.length);

        detailedLogger.verboseLog("Comparing paths:", {
          sortedAnalyzed,
          sortedAnalyzedLength: sortedAnalyzed.length,
          sortedAll,
          sortedAllLength: sortedAll.length,
          isEqual: R.isDeepEqual(sortedAnalyzed, sortedAll),
          difference: R.difference(sortedAnalyzed, sortedAll),
        });

        if (sortedAnalyzed.length === sortedAll.length) {
          detailedLogger.verboseLog("All files have been analyzed");
          break;
        }

        detailedLogger.verboseLog("Starting new batch analysis", {
          currentBatchSize: Object.keys(currentBatchProjectFiles).length,
          currentBatchTokens,
        });

        for (const [filePath, fileContent] of Object.entries(allProjectFiles)) {
          const currentFilePath = projectFilePath(filePath);
          detailedLogger.verboseLog(`Processing file: ${filePath}`, {
            isAlreadyAnalyzed: analyzedProjectFilesPaths.has(currentFilePath),
            currentBatchSize: Object.keys(currentBatchProjectFiles).length,
            currentBatchTokens,
          });

          if (analyzedProjectFilesPaths.has(currentFilePath)) {
            detailedLogger.verboseLog(
              `Skipping already analyzed file: ${filePath}`
            );
            continue;
          }

          const approxFileTokens = estimateTokensForClaude(fileContent);
          detailedLogger.verboseLog(`Token estimation for ${filePath}:`, {
            approxFileTokens,
            currentBatchTokens,
            wouldExceedLimit: currentBatchTokens + approxFileTokens > 30000,
          });

          // Check if adding this file would exceed token limit
          if (currentBatchTokens + approxFileTokens > 30000) {
            // If this is a single large file that exceeds the token limit, skip it entirely
            if (approxFileTokens > 30000) {
              detailedLogger.verboseLog(
                `File ${filePath} is too large (${approxFileTokens} tokens). Skipping analysis.`,
                { currentFilePath }
              );
              // Mark the file as analyzed without processing it
              analyzedProjectFilesPaths.add(currentFilePath);
              detailedLogger.verboseLog("Added large file to analyzed paths", {
                analyzedCount: analyzedProjectFilesPaths.size,
                analyzedPaths: Array.from(analyzedProjectFilesPaths),
              });
              continue;
            }

            detailedLogger.verboseLog(
              `Token limit would be exceeded (${currentBatchTokens + approxFileTokens}/30000). Processing current batch.`,
              {
                currentBatchFiles: Object.keys(currentBatchProjectFiles),
              }
            );

            // Current batch is full, yield it
            if (Object.keys(currentBatchProjectFiles).length > 0) {
              detailedLogger.verboseLog("Breaking to process current batch", {
                batchSize: Object.keys(currentBatchProjectFiles).length,
                batchFiles: Object.keys(currentBatchProjectFiles),
              });
              break;
            }

            detailedLogger.verboseLog("Continuing to next file (batch empty)");
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

        const baseMessages: LLMMessage[] = [
          {
            role: "system",
            content: dedent`
              You are an experienced software developer specialized in Next.js ecosystem working as assistant that analyzes which source code files need modifications, which ones needs to be created and which needs to be deleted. You work in iterations (in other words - you analyze files in batch and base on the previous results of the analysis). Your outputs are being saved to an array and if the whole codebase analysis is complete it gets deeply merged into one object.

              Base on user request specified in <request> section. You follow strict rules.              

              You will be supplied with previous iteration analysis results deeply merged into one object (if this is not the first iteration). IT should be treated as decision helper (but not as a strict path) for you.

              <rules>
                - 'creation' and 'removal' sections and its children -> CRUCIAL SECTIONS for further tools, 'module_dependencies' section and its children -> INFORMATIVE SECTION for helping YOU with the analysis.
                - Focus on code and configuration changes
                - Does the file exist in <files>? If YES -> MUST use 'files_to_modify', If NO -> MUST use 'files_to_create' in output 
                - Include files that need both direct and indirect modifications in 'module_dependencies' section. If file is explicitly exported/imported or required using CJS/ESM -> classify as direct dependency, If NO -> search for other files for code composition, If FOUND, classify as indirect, If NOT FOUND, skip and proceed.
                - When determining which files to remove, focus on files that are not needed in the project anymore.
                - ALWAYS analyze the 'package.json' but following strict rules:
                  - Consider changes in the scripts and running the project, If 'package.json' 'scripts' json field needs changes -> include it in the analysis, If NO -> skip the package.json
                  - If any other field in 'package.json' such as 'dependencies' needs change -> completely SKIP it in the analysis. 
              </rules>

              <example>
                Final analysis for execution step "Remove Storybook-related files and directories"

                ${JSON.stringify({
                  creation: {
                    files_to_create: [],
                    files_to_modify: [
                      {
                        path: "package.json",
                        why: "Remove Storybook-related scripts (from 'start-storybook', 'build-storybook')",
                      },
                    ],
                  },
                  removal: {
                    file_paths_to_remove: [
                      {
                        path: ".storybook/",
                        why: "This is a storybook output directory, it needs to be removed as user requested.",
                      },
                      {
                        path: "components/Button/Button.stories.tsx",
                        why: "This is a Storybook story file used for component documentation and testing in Storybook",
                      },
                    ],
                  },
                  module_dependencies: {
                    indirect: [{}],
                  },
                })}
              </example>
            `,
          },
          {
            role: "user",
            content: dedent`
              Files that you need to work on:
              
              ${xml.build({
                files: {
                  file: Object.entries(currentBatchProjectFiles).map(
                    ([projectFilePath, projectFileContent]) => ({
                      "@_path": projectFilePath,
                      "#text": projectFileContent,
                    })
                  ),
                },
              })}
            `
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
            `
          },
        ];

        const processedMessages = this.processLLMMessages(baseMessages, "executeProjectFilesAnalysis");

        detailedLogger.verboseLog("Project analysis prompt after processing:", processedMessages);

        const {
          object: partialProjectAnalysis,
          usage,
        } = await generateObject({
          model: anthropic("claude-3-5-sonnet-20241022", {
            cacheControl: true,
          }),
          maxRetries: 0,
          schema: projectFilesAnalysisSchema,
          messages: processedMessages,
        });

        detailedLogger.usageLog("Analysis generation usage metrics", {
          usage,
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

  @PromptFunction()
  private async executeSingleFileModifications({
    projectFileModification,
    projectFilesAnalysis,
    detailedLogger,
  }: {
    projectFileModification: ProjectFileModification;
    projectFilesAnalysis: ProjectFilesAnalysis;
    detailedLogger: DetailedLogger;
  }): Promise<void> {
    detailedLogger.verboseLog("Starting single file modification", {
      path: projectFileModification.path,
      operation: projectFileModification.operation,
      why: projectFileModification.why,
      originalContent: projectFileModification.content,
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
    const { text, usage } = await generateText({
      model: anthropic("claude-3-5-sonnet-20241022", {
        cacheControl: true,
      }),
      maxRetries: 0,
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
        autoConvertLineEndings: true,
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
                detailedLogger.verboseLog(
                  "Failed to write patched content",
                  err
                );
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
            detailedLogger.verboseLog(
              "Patch application completed successfully"
            );
            resolve(void 0);
          }
        },
      });
    });
  }
}

// Export types and the handler class
export type { ProjectFilesAnalysis };
