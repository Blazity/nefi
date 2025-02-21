import { 
  BaseScriptInterceptor, 
  ScriptsInterception, 
  ExecutionHooks,
  InterceptorConfirmationHooks
} from "../../scripts-registry";
import dedent from "dedent";
import { confirm, isCancel } from "@clack/prompts";

@ScriptsInterception({
  name: "hello",
  description: "Adds a simple hello.txt file to the project",
  hooks: [
    {
      script: "file-modifier",
      function: "executeProjectFilesAnalysis",
      messageTarget: { role: "system" },
      priority: 1
    }
  ]
})
export class HelloInterceptor extends BaseScriptInterceptor {
  protected interceptorConfirmationHooks: InterceptorConfirmationHooks = {
    confirmInterceptorUsage: async () => {
      const shouldUseHelloIntegration = await confirm({
        message: "I noticed an opportunity to add a hello.txt file to your project. Would you like to include this?",
      });

      // Handle cancellation
      if (isCancel(shouldUseHelloIntegration)) {
        return {
          shouldUseInterceptor: false,
          message: "Okay, I'll remove the hello.txt file creation from the plan."
        };
      }

      return {
        shouldUseInterceptor: shouldUseHelloIntegration,
        message: shouldUseHelloIntegration 
          ? "Great! I'll keep the hello.txt file creation in the plan."
          : "Okay, I'll remove the hello.txt file creation from the plan."
      };
    }
  };

  readonly context = {
    "file-modifier": {
      executeProjectFilesAnalysis: {
        transforms: () => ({
          rules: [
            {
              transform: this.transform.appendAtTheBottomOfTag("rules"),
              content: dedent`
                - Create hello.txt file in the root directory
                - Add a friendly greeting message
              `
            }
          ],
          example: [
            {
              transform: this.transform.replaceBetweenTagBounds("example"),
              content: dedent`
                Final analysis for execution step "Add hello.txt file"
                {
                  "creation": {
                    "files_to_create": [
                      {
                        "path": "hello.txt",
                        "why": "Add a friendly greeting message",
                        "content": "Hello! Welcome to the project! 👋\n"
                      }
                    ]
                  }
                }
              `
            }
          ]
        })
      }
    }
  };
} 