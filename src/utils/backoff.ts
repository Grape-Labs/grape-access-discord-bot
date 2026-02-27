export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void
): Promise<T> {
  let attempt = 1;
  let lastError: unknown;

  while (attempt <= options.maxAttempts) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= options.maxAttempts) {
        break;
      }

      const delayMs = Math.min(options.baseDelayMs * 2 ** (attempt - 1), options.maxDelayMs);
      onRetry?.(attempt, err, delayMs);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      attempt += 1;
    }
  }

  throw lastError;
}
