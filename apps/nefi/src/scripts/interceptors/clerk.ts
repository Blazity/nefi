import {
  BaseScriptInterceptor,
  ScriptsInterception,
  ScriptInterceptorContext,
  ExecutionPlanHooks,
  InterceptorHook
} from "../../scripts-registry";
import dedent from "dedent";
import { confirm, isCancel } from "@clack/prompts";

@ScriptsInterception({
  name: "clerk",
  description: "Integrates Clerk authentication into the Next.js project",
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
    }
  ]
})
export class ClerkInterceptor extends BaseScriptInterceptor {
  protected executionPlanHooks: ExecutionPlanHooks = {
    afterPlanDetermination: async (plan) => {
      const stepsUsingClerk = plan.steps.filter((step) =>
        step.interceptors?.some((int) => int.name === "clerk"),
      );

      if (stepsUsingClerk.length > 0) {
        const shouldUseClerkIntegration = await confirm({
          message:
            "I noticed an opportunity to integrate auth using Clerk (clerk.com). Would you like to include this?",
        });

        // Handle cancellation
        if (isCancel(shouldUseClerkIntegration)) {
          return {
            shouldKeepInterceptor: false,
            message: "Okay, I'll remove the Clerk integration from the plan.",
          };
        }

        return {
          shouldKeepInterceptor: shouldUseClerkIntegration,
          message: shouldUseClerkIntegration
            ? "Great! I'll keep the Clerk integration in the plan."
            : "Okay, I'll remove the Clerk integration from the plan.",
        };
      }

      return {
        shouldKeepInterceptor: true,
      };
    },
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
          - Create src/middleware.ts with Clerk middleware configuration
          - Wrap root layout with <ClerkProvider>
          - Add authentication components to layout header
          - Configure middleware matcher to protect all routes except static files
          - Ensure proper font variable integration in layout
        `,
        customExample: dedent`
          Final analysis for execution step "Add Clerk integration"
          {
            "creation": {
              "files_to_modify": [
                {
                  "path": "app/layout.tsx",
                  "why": "Integrate Clerk provider and auth components into root layout"
                }
              ],
              "files_to_create": [
                {
                  "path": "src/middleware.ts",
                  "why": "Add Clerk middleware with route protection rules",
                  "content": "import { clerkMiddleware } from '@clerk/nextjs/server';\n\nexport default clerkMiddleware();\n\nexport const config = {\n  matcher: [\n    '/((?!_next|[^?]*\\\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',\n    '/(api|trpc)(.*)',\n  ],\n};"
                }
              ]
            },
            "module_dependencies": {
              "indirect": []
            }
          }
        `,
      },
      executeProjectFilesAnalysis: {
        executionHooks: {
          beforeExecution: () => {
            console.log("Before execution");
          },
          afterExecution: () => {
            console.log("After execution");
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
