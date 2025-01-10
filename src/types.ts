import { CommandContext } from "@stricli/core";
import { Tagged } from "type-fest";

// TODO: ?
export type ScriptContext = {
  path: string;
  packages?: string[];
}

export interface CustomContext extends CommandContext {
  readonly process: NodeJS.Process;
}
