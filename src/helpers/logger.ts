import { log } from "@clack/prompts";
import type { LanguageModelUsage } from "ai";
import type { PartialDeep } from "type-fest";

export const isVerbose = process.env.VERBOSE === "1";

export function verboseLog(message: string, data?: unknown) {
  if (!isVerbose) return;
  if (data) {
    log.info(`${message}:\n${JSON.stringify(data, null, 2)}`);
  } else {
    log.info(message);
  }
}

type AIUsageMetrics = Readonly<PartialDeep<{
  usage: LanguageModelUsage;
  experimental_providerMetadata: {
    anthropic: {
      cacheControl: {
        type: string;
      };
      cacheCreationInputTokens: number;
      cacheReadInputTokens: number;
    };
  };
}>>;

export function verboseAIUsage(message: string, metrics: AIUsageMetrics) {
  if (!isVerbose) return;
  
  const { usage, experimental_providerMetadata, ...otherMetrics } = metrics;
  
  verboseLog(message, {
    usage: {
      prompt_tokens: usage?.promptTokens ?? 0,
      completion_tokens: usage?.completionTokens ?? 0,
      total_tokens: usage?.totalTokens ?? 0,
    },
    anthropic: {
      cache_type: experimental_providerMetadata?.anthropic?.cacheControl?.type ?? "none",
      cache_creation_input_tokens: experimental_providerMetadata?.anthropic?.cacheCreationInputTokens ?? 0,
      cache_read_input_tokens: experimental_providerMetadata?.anthropic?.cacheReadInputTokens ?? 0
    },
    ...otherMetrics
  });
}
