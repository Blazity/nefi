import {
  BaseScriptInterceptor,
  ScriptsInterception,
  ScriptInterceptorContext,
  InterceptorConfirmationHooks,
  InterceptorHook
} from "../../scripts-registry";
import dedent from "dedent";
import { confirm, isCancel } from "@clack/prompts";
import pc from "picocolors";
import { join } from "path";
import { appendToEnvFile, readEnvFile } from "../../helpers/env-loading";

@ScriptsInterception({
  name: "clerk",
  description: "Integrates Clerk authentication into the Next.js project",
  executionPipelineGuidelines: [
    "ALWAYS include a step to modify root layout.tsx to add ClerkProvider and auth components",
    "ALWAYS include a step to add required Clerk environment variables",
    "NEVER skip the layout.tsx or environment variables configuration steps",
    "The layout.tsx modification MUST be done in a separate step from other file modifications",
    "Environment variables MUST be configured before any other Clerk-related changes"
  ],
  hooks: [
    {
      script: "package-management",
      function: "generatePackageOperations",
      messageTarget: { role: "system" },
      priority: 1
    },
    {
      script: "file-modifier",
      function: "executeProjectFilesAnalysis",
      messageTarget: { role: "system" },
      priority: 2
    },
    {
      script: "file-modifier",
      function: "executeSingleFileModification",
      messageTarget: { role: "system" },
      priority: 3
    }
  ]
})
export class ClerkInterceptor extends BaseScriptInterceptor {
  protected interceptorConfirmationHooks: InterceptorConfirmationHooks = {
    confirmInterceptorUsage: async () => {
      const shouldUseClerkIntegration = await confirm({
        message: `Continue with auth solutions by ${pc.bold(pc.whiteBright("Clerk"))}? (clerk.com)`,
      });

      // Handle cancellation
      if (isCancel(shouldUseClerkIntegration)) {
        return {
          shouldUseInterceptor: false,
          message: "Okay, I'll remove the Clerk integration from the plan.",
        };
      }

      return {
        shouldUseInterceptor: shouldUseClerkIntegration,
      };
    }
  };

  private _context: ScriptInterceptorContext = {
    "package-management": {
      partials: {
        clerkRules: dedent`
          <rules>
            <critical_rules>
              <rule>ONLY add '@clerk/nextjs' package. No other packages should be added.</rule>
              <rule>NEVER suggest any other authentication packages or related dependencies.</rule>
              <rule>If other authentication packages exist, suggest removing them.</rule>
            </critical_rules>
            <general_rules>
              <rule>Keep the package installation minimal and focused on Clerk integration.</rule>
              <rule>Do not add any optional Clerk-related packages unless explicitly requested.</rule>
            </general_rules>
          </rules>
        `,
      },
      generatePackageOperations: {
        transforms: () => ({
          rules: [
            {
              transform: this.transform.replaceBetweenTagBounds("rules"),
              content: this.partial("package-management", "clerkRules"),
            },
          ],
        }),
      },
    },
    "file-modifier": {
      partials: {
        additionalRules: dedent`
          <critical_rules>
          - STRICTLY follow the example files provided below as templates - DO NOT deviate from them
          - DO NOT modify any imports - use EXACTLY the same imports as shown in examples
          - DO NOT add any additional components or code not shown in examples
          - The middleware.ts MUST use clerkMiddleware (NOT authMiddleware or any other variant)
          - The layout.tsx MUST follow the exact structure shown, including all imports and components
          </critical_rules>

          Required file modifications:
          - Create middleware.ts using the EXACT template provided below
          - Modify root layout using the EXACT template provided below, preserving only the existing font configuration
          - Configure middleware matcher EXACTLY as shown in the example
          - Add ONLY the environment variables shown in the example
          
          <strict_requirements>
          - Examples below are TEMPLATES that must be followed exactly BUT the file paths may differ
          - NO custom modifications or additions are allowed
          - ALL imports must match the examples exactly
          - Component structure must match the examples exactly
          </strict_requirements>
        `,
        customExample: dedent`
          STRICT TEMPLATES FOR FILE MODIFICATIONS (the file paths may differ, the content must be the same):
          <example_files>
            <example_file>
              <path>app/layout.tsx</path>
              <content>
                import type { Metadata } from "next";
                import {
                  ClerkProvider,
                  SignInButton,
                  SignUpButton,
                  SignedIn,
                  SignedOut,
                  UserButton,
                } from "@clerk/nextjs";
                import { Geist, Geist_Mono } from "next/font/google";
                import "../styles/tailwind.css";

                const geistSans = Geist({
                  variable: "--font-geist-sans",
                  subsets: ["latin"],
                });

                const geistMono = Geist_Mono({
                  variable: "--font-geist-mono",
                  subsets: ["latin"],
                });

                export const metadata: Metadata = {
                  title: "Create Next App",
                  description: "Generated by create next app",
                };

                export default function RootLayout({
                  children,
                }: Readonly<{
                  children: React.ReactNode;
                }>) {
                  return (
                    <ClerkProvider>
                      <html lang="en">
                        <body
                          className={\`\${geistSans.variable} \${geistMono.variable} antialiased\`}
                        >
                          <header className="flex justify-end items-center p-4 gap-4 h-16">
                            <SignedOut>
                              <SignInButton />
                              <SignUpButton />
                            </SignedOut>
                            <SignedIn>
                              <UserButton />
                            </SignedIn>
                          </header>
                          {children}
                        </body>
                      </html>
                    </ClerkProvider>
                  );
                }
              </content>
            </example_file>
            <example_file>
              <path>src/middleware.ts</path>
              <content>
              import { clerkMiddleware } from '@clerk/nextjs/server'

              export default clerkMiddleware()
              
              export const config = {
                matcher: [
                  // Skip Next.js internals and all static files, unless found in search params
                  '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
                  // Always run for API routes
                  '/(api|trpc)(.*)',
                ],
              }
              </content>
            </example_file>
            <example_file optional="true">
              <path>env.mjs</path>
              <content>
              import { createEnv } from "@t3-oss/env-nextjs"
              import { z } from "zod"
              
              export const env = createEnv({
                server: {
                  ANALYZE: z
                    .enum(["true", "false"])
                    .optional()
                    .transform((value) => value === "true"),
                },
                client:{
                  NEXT_PUBLIC_CLERK_ENABLE_KEYLESS: z
                    .enum(["true", "false"])
                    .optional()
                    .transform((value) => value === "true")
                },
                runtimeEnv: {
                  NEXT_PUBLIC_CLERK_ENABLE_KEYLESS: process.env.NEXT_PUBLIC_CLERK_ENABLE_KEYLESS,
                  ANALYZE: process.env.ANALYZE,
                },
              })
              </content>
            </example_file>
          </example_files>

          Example final analysis for execution step "Add Clerk integration"
          {
            "creation": {
              "files_to_modify": [
                {
                  "path": "app/layout.tsx",
                  "why": "Integrate Clerk provider and auth components into root layout EXACTLY as shown in template"
                },
                {
                  "path": "middleware.ts",
                  "why": "Add Clerk middleware with route protection rules EXACTLY as shown in template"
                },
                {
                  "path": "env.mjs",
                  "why": "Add Clerk environment variables EXACTLY as shown in template"
                }
              ],
              "files_to_create": []
            },
            "module_dependencies": {
              "indirect": []
            }
          }
        `,
      },
      executeSingleFileModification: {
        transforms: () => ({
          rules: [
            {
              transform: this.transform.appendAtTheBottomOfTag("rules"),
              content: this.partial("file-modifier", "additionalRules"),
            },
          ],
          example: [
            {
              transform: this.transform.replaceBetweenTagBounds("templates"),
              content: this.partial("file-modifier", "customExample"),
            },
          ],
        }),
      },
      executeProjectFilesAnalysis: {
        executionHooks: {
          afterExecution: async () => {
            const envPath = join(process.cwd(), '.env');
            const existingEnv = await readEnvFile(envPath);
            
            if (!existingEnv['NEXT_PUBLIC_CLERK_ENABLE_KEYLESS']) {
              await appendToEnvFile(envPath, 'NEXT_PUBLIC_CLERK_ENABLE_KEYLESS', 'true');
            }
          },
        },
        transforms: () => ({
          rules: [
            {
              transform: this.transform.appendAtTheBottomOfTag("rules"),
              content: this.partial("file-modifier", "additionalRules"),
            },
          ],
          example: [
            {
              transform: this.transform.replaceBetweenTagBounds("example"),
              content: this.partial("file-modifier", "customExample"),
            },
          ],
        }),
      },
    },
  };

  get context() {
    return this._context;
  }
}
