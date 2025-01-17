import { log } from "@clack/prompts";
import type { LanguageModelUsage } from "ai";
import type { PartialDeep } from "type-fest";

type CreateLoggerParams = Readonly<
  Partial<{
    usage: boolean;
    verbose: boolean;
  }>
>;

type AIUsageMetrics = Readonly<
  PartialDeep<{
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
  }>
>;

export function createDetailedLogger({ usage, verbose }: CreateLoggerParams) {
  const verboseLog = (message: string, data?: unknown) => {
    if (!verbose) return;
    if (data) {
      log.info(`${message}:\n${JSON.stringify(data, null, 2)}`);
    } else {
      log.info(message);
    }
  };

  const usageLog = (message: string, metrics: AIUsageMetrics) => {
    if (!verbose && !usage) return;

    const {
      usage: usageMetrics,
      experimental_providerMetadata,
      ...otherMetrics
    } = metrics;

    log.info(
      `${message}\n${JSON.stringify(
        {
          usage: {
            prompt_tokens: usageMetrics?.promptTokens ?? 0,
            completion_tokens: usageMetrics?.completionTokens ?? 0,
            total_tokens: usageMetrics?.totalTokens ?? 0,
          },
          anthropic: {
            cache_type:
              experimental_providerMetadata?.anthropic?.cacheControl?.type ??
              "none",
            cache_creation_input_tokens:
              experimental_providerMetadata?.anthropic
                ?.cacheCreationInputTokens ?? 0,
            cache_read_input_tokens:
              experimental_providerMetadata?.anthropic?.cacheReadInputTokens ??
              0,
          },
          ...otherMetrics,
        },
        null,
        2
      )}`
    );
  };

  return {
    verboseLog,
    usageLog,
  };
}

export type DetailedLogger = ReturnType<typeof createDetailedLogger>
