import { Command, Option } from "clipanion";

export class AgentCommand extends Command {
  static paths = [Command.Default];

  static usage = Command.Usage({
    description: "Run AI agent to analyze and execute scripts in optimal order",
    examples: [["Analyze scripts and execute them in optimal order", "agent"]],
  });

  force = Option.Boolean("--force-write", false, {
    description: "Force overwrite of the dirty working tree"
  })

  usage = Option.Boolean("--usage", false, {
    description: "Print the usage of LLM calls",
  });

  verbose = Option.Boolean("--verbose", false, {
    description: "Enable verbose logging including LLM calls usage",
  });

  async execute() {
    const { agentCommand } = await import("./impl");

    return agentCommand({
      clipanionContext: {
        usage: this.usage,
        verbose: this.verbose,
        force: this.force,
      },
    });
  }
}
