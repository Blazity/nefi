import { Command, Option } from 'clipanion';
import { agentCommand as runAgent } from './impl';

export class AgentCommand extends Command {
  static paths = [['agent']];

  hidden = Option.Boolean('--hidden', false, {
    description: 'Hidden flag',
  });

  static usage = Command.Usage({
    description: 'Run AI agent to analyze and execute scripts in optimal order',
    examples: [['Analyze scripts and execute them in optimal order', 'agent']],
  });

  async execute() {
    return runAgent({ flags: { hidden: this.hidden } });
  }
}