import { CommandContext } from "@stricli/core";

export type ScriptContext = {
  path: string;
  packages?: string[];
}

export interface CustomContext extends CommandContext {
  readonly process: NodeJS.Process;
}