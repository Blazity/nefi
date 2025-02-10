import { BaseScriptInterceptor, ScriptsInterception } from "../../scripts-registry";
import dedent from "dedent";
import { confirm, isCancel } from "@clack/prompts";
import type { ExecutionPlanHooks } from "../../scripts-registry";

@ScriptsInterception({
  name: "hello",
  description: "Adds a simple hello.txt file to the project",
  meta: {
    "file-modifier": [
      {
        hookedFunctionName: "executeProjectFilesAnalysis",
        messageTarget: { role: "system" },
      },
    ],
  },
})
export class HelloInterceptor extends BaseScriptInterceptor {
  protected executionPlanHooks: ExecutionPlanHooks = {
    afterPlanDetermination: async (plan) => {
      // Find steps that use this interceptor
      const stepsUsingHello = plan.steps.filter(
        step => step.interceptors?.some(int => int.name === "hello")
      );

      if (stepsUsingHello.length > 0) {
        const shouldUseHelloIntegration = await confirm({
          message: "I noticed an opportunity to add a hello.txt file to your project. Would you like to include this?",
        });

        // Handle cancellation
        if (isCancel(shouldUseHelloIntegration)) {
          return {
            shouldKeepInterceptor: false,
            message: "Okay, I'll remove the hello.txt file creation from the plan."
          };
        }

        return {
          shouldKeepInterceptor: shouldUseHelloIntegration,
          message: shouldUseHelloIntegration 
            ? "Great! I'll keep the hello.txt file creation in the plan."
            : "Okay, I'll remove the hello.txt file creation from the plan."
        };
      }

      return {
        shouldKeepInterceptor: true
      };
    }
  };

  readonly context = {
    "file-modifier": {
      partials: {
        additionalRules: dedent`
          - Create a hello.txt file in the root directory
        `,
        customExample: dedent`
          Final analysis for execution step "Add hello.txt file"
          {
            "creation": {
              "files_to_create": [
                {
                  "path": "hello.txt",
                  "why": "Add a simple hello.txt file with greeting content"
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
} 