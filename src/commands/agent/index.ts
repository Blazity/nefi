import { Command, Option } from "clipanion";

export class AgentCommand extends Command {
  static paths = [Command.Default];

  static usage = Command.Usage({
    description: "Run AI agent to analyze and execute scripts in optimal order",
    examples: [["Analyze scripts and execute them in optimal order", "agent"]],
  });

  async execute() {
    const { agentCommand } = await import("./impl");
    return agentCommand({});
  }
}
