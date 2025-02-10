import { BaseScriptInterceptor, ScriptsInterception } from "../../scripts-registry";
import dedent from "dedent";

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