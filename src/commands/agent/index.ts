import { buildCommand } from "@stricli/core";

export const agentCommand = buildCommand({
  loader: () => import("./impl"),
  docs: {
    brief: "Run AI agent to analyze and execute scripts in optimal order",
    customUsage: [
      {
        input: "",
        brief: "Analyze scripts in the scripts/ directory and execute them in the optimal order",
      },
    ],
  },
  parameters: {
    flags: {
      hidden: {
        kind: "boolean",
        brief: "Hidden flag",
        optional: true,
        hidden: true,
      },
    },
  },
});