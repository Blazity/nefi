import { Command } from "clipanion";
import { xml } from "../../helpers/xml";
import { log } from "@clack/prompts";

interface TestFile {
  path: string;
  content: string;
  type: string;
  size: number;
  lastModified: string;
}

export class TestXmlCommand extends Command {
  static paths = [["test-xml"]];
  static usage = Command.Usage({
    description: "Test XML building functionality",
  });

  async execute() {
    // Test basic XML building
    const basicXml = xml.build({
      test: {
        "#text": "Hello World",
      },
    });
    log.info("Basic XML:");
    log.info(basicXml);

    // Test with attributes
    const withAttributes = xml.build({
      test: {
        "@_path": "/some/path",
        "@_type": "file",
        content: {
          "#text": "Content with attributes",
        },
      },
    });
    log.info("\nXML with attributes:");
    log.info(withAttributes);

    // Test nested structure
    const nested = xml.build({
      root: {
        parent: {
          child: [
            {
              "@_name": "first",
              "#text": "First child",
            },
            {
              "@_name": "second",
              "#text": "Second child",
            },
          ],
        },
      },
    });
    log.info("\nNested XML:");
    log.info(nested);

    // Test with all allowed attributes
    const allAttributes = xml.build({
      document: {
        "@_path": "/path/to/file",
        "@_required": "true",
        "@_type": "document",
        "@_dependencies": "react,next",
        "@_description": "Test document",
        "@_name": "test",
        "@_version": "1.0.0",
        "@_count": "42",
        "@_total": "100",
        "@_timestamp": new Date().toISOString(),
        "@_format": "json",
        "@_key": "test-key",
        content: {
          "#text": "Testing all allowed attributes",
        },
      },
    });
    log.info("\nXML with all allowed attributes:");
    log.info(allAttributes);

    // Test array-based file analysis XML
    const testFiles: TestFile[] = [
      {
        path: "/src/components/Button.tsx",
        content: "export const Button = () => <button>Click me</button>",
        type: "component",
        size: 1024,
        lastModified: new Date().toISOString(),
      },
      {
        path: "/src/styles/button.css",
        content: ".button { color: blue; }",
        type: "styles",
        size: 512,
        lastModified: new Date().toISOString(),
      },
      {
        path: "/src/tests/Button.test.tsx",
        content: "test('button renders', () => {})",
        type: "test",
        size: 768,
        lastModified: new Date().toISOString(),
      },
    ];

    const fileAnalysis = xml.build({
      analyzer: {
        role: {
          "#text":
            "You are an expert in analyzing and modifying source code files.",
        },
        rules: {
          rule: [
            "Only suggest necessary file modifications",
            "Preserve code style and formatting",
            "Consider project structure and dependencies",
            "Maintain code readability",
          ],
        },
        files: {
          file: testFiles.map((file) => ({
            "@_path": file.path,
            "@_type": file.type,
            "@_size": String(file.size),
            "@_timestamp": file.lastModified,
            content: {
              "#text": file.content,
            },
          })),
        },
        metadata: {
          "@_total": String(testFiles.length),
          "@_types": testFiles.map((f) => f.type).join(","),
          summary: {
            "#text": `Analyzing ${testFiles.length} files for modifications`,
          },
        },
      },
    });

    log.info("\nFile Analysis XML:");
    log.info(fileAnalysis);

    log.info(
      createSystemPrompt(),
    );
  }
}

function createSystemPrompt() {
  return xml.build({
    role: {
      "#text":
        "You are a high-level execution planner that determines which scripts should handle different aspects of the request. You strictly follow defined rules with no exceptions. Do not hallucinate",
    },
    "available_scripts": {
      script: [
        {
          "@_name": "version-management.ts",
          "specific_rule": "This script should be the first priority in most of the cases"
        },
        {
          "@_name": "file-management.ts",
          "specific_rule": "When predicting which files or parts of the codebase should be modified prefer to not split the file modification into multiple script calls. It is way better to do everything at once."
        },
        {
          "@_name": "version-control-management.ts",
          "specific_rule": "This script should ALWAYS be the last one."
        }
      ],
    },
    rules: [
      "Break down complex requests into logical steps",
      "ONLY use scripts from <available_scripts> section, respecting their rules specified as child section called <specific_rule>",
      "Consider dependencies between steps when setting priorities",
      "Provide clear description for each step",
      "As a helper information, refer to further provided <history> section. It contains explanation what was done in the past along with explanation of the schema (the way history is written), under child section <schema>, for the LLM"
    ],
    knowledge: [
      "Most packages require configuration changes in addition to installation",
      "Package installations should be paired with corresponding file changes",
      "Always consider both direct and indirect configuration needs."
    ]
  });
}
