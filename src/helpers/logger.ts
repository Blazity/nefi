import { log } from "@clack/prompts";

export const isVerbose = process.env.VERBOSE === "1";

export function verboseLog(message: string, data?: unknown) {
  if (!isVerbose) return;
  if (data) {
    log.info(`${message}:\n${JSON.stringify(data, null, 2)}`);
  } else {
    log.info(message);
  }
}
