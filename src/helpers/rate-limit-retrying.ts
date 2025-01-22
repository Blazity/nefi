import { APICallError, RetryError } from "ai";
import { parseISO, differenceInMilliseconds } from "date-fns";
import { DetailedLogger } from "./logger";
import { log, spinner } from "@clack/prompts";

type WithAsyncAnthropicRateLimitRetryParams<T> = Readonly<{
  fn: () => Promise<T>;
  detailedLogger: DetailedLogger;
}>;

export const withAsyncAnthropicRateLimitRetry = async <T>({
  fn,
  detailedLogger,
}: WithAsyncAnthropicRateLimitRetryParams<T>): Promise<T> => {
  let attempts = 0;
  const MAX_ATTEMPTS = 5;

  const handleRateLimit = async (headers: Record<string, string>) => {
    const resetDateTime = headers["anthropic-ratelimit-input-tokens-reset"];
    const spinnerInstance = spinner();
    if (!resetDateTime) return false;

    detailedLogger.verboseLog("Rate limit reached (40k tokens per minute)");
    log.info("Anthropic's API rate limit reached.");
    log.info(
      "Do not be alarmed - this is a normal part of analysing the big code bases."
    );
    spinnerInstance.start("Retrying in...");

    const countdownInterval = setInterval(() => {
      const now = new Date();
      const remainingMs = differenceInMilliseconds(resetDate, now);
      if (remainingMs <= 0) {
        clearInterval(countdownInterval);
        return;
      }
      const remainingSecs = Math.ceil(remainingMs / 1000);
      spinnerInstance.message(`Retrying in ${remainingSecs} seconds`);
    }, 1000);

    const resetDate = parseISO(resetDateTime);
    detailedLogger.verboseLog(`Reset date time: ${resetDate}`);
    const now = new Date();
    const waitTime = differenceInMilliseconds(resetDate, now);

    if (waitTime <= 0) return false;

    detailedLogger.verboseLog(
      `Waiting for ${waitTime}ms before next invocation`
    );

    await new Promise((r) => setTimeout(r, waitTime));
    spinnerInstance.stop("Retrying the request...");
    return true;
  };

  while (attempts < MAX_ATTEMPTS) {
    try {
      const result = await fn();
      return result;
    } catch (error: unknown) {
      attempts++;
      detailedLogger.verboseLog(
        `Attempt ${attempts} of ${MAX_ATTEMPTS} failed`
      );

      if (attempts === MAX_ATTEMPTS) {
        console.error("Max attempts reached, throwing error");
        throw error;
      }

      // Check if it's one of our known error types
      if (APICallError.isInstance(error)) {
        detailedLogger.verboseLog("Caught APICallError");

        if (!error.isRetryable) {
          detailedLogger.verboseLog("Error is not retryable, throwing");
          throw error;
        }

        if (error.responseHeaders) {
          const wasRateLimited = await handleRateLimit(error.responseHeaders);
          if (wasRateLimited) continue;
        }
      } else if (RetryError.isInstance(error)) {
        detailedLogger.verboseLog("Caught RetryError");

        // RetryError might contain headers in its lastError if it was an API error
        const lastError = error.lastError;
        if (APICallError.isInstance(lastError) && lastError.responseHeaders) {
          const wasRateLimited = await handleRateLimit(
            lastError.responseHeaders
          );
          if (wasRateLimited) continue;
        }
      } else {
        detailedLogger.verboseLog(
          "Unknown error type:",
          error instanceof Error ? error.name : typeof error
        );
        throw error;
      }

      // If we get here, we need to do exponential backoff
      const backoffTime = Math.min(1000 * Math.pow(2, attempts), 60000);
      detailedLogger.verboseLog(
        `No rate limit info, using exponential backoff: ${backoffTime}ms`
      );
      await new Promise((r) => setTimeout(r, backoffTime));
    }
  }

  throw new Error("Max retry attempts reached");
};
