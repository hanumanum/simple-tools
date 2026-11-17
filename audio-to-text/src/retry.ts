import { sleep } from "./time.js";

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  isRetryable?: (error: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number, attempts: number, delayMs: number) => void;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isExplicitlyNonRetryable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "retryable" in error &&
    (error as { retryable?: unknown }).retryable === false
  );
}

function readStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as Record<string, unknown>;
  if (typeof record.status === "number") return record.status;
  if (typeof record.statusCode === "number") return record.statusCode;
  const nested = record.error;
  if (typeof nested === "object" && nested !== null) {
    const code = (nested as Record<string, unknown>).code;
    if (typeof code === "number") return code;
  }
  return undefined;
}

export function describeFailure(error: unknown): string {
  const message = errorMessage(error);
  const unwrapped = unwrapGoogleError(message);
  const status = readStatus(error) ?? unwrapped.code;
  const text = unwrapped.message ?? message;
  if (status !== undefined && !text.startsWith(String(status))) return `${status} ${text}`;
  return text;
}

function unwrapGoogleError(message: string): { code?: number; message?: string } {
  const trimmed = message.trim();
  if (!trimmed.startsWith("{")) return {};
  try {
    const parsed = JSON.parse(trimmed) as {
      error?: { code?: number; message?: string; status?: string };
    };
    if (!parsed.error?.message) return {};
    const status = parsed.error.status ? `${parsed.error.status}: ` : "";
    return { code: parsed.error.code, message: `${status}${parsed.error.message}` };
  } catch {
    return {};
  }
}

export function isRetryableError(error: unknown): boolean {
  if (isExplicitlyNonRetryable(error)) return false;
  const status = readStatus(error);
  if (status === 429 || (status !== undefined && status >= 500 && status < 600)) return true;
  const message = errorMessage(error);
  return /RESOURCE_EXHAUSTED|UNAVAILABLE|DEADLINE_EXCEEDED|\bINTERNAL\b|overloaded|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed/i.test(
    message,
  );
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const isRetryable = options.isRetryable ?? isRetryableError;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const canRetry = attempt < attempts - 1 && isRetryable(error);
      if (!canRetry) throw error;
      const delayMs = baseDelayMs * 2 ** attempt;
      options.onRetry?.(error, attempt + 1, attempts, delayMs);
      await sleep(delayMs);
    }
  }

  throw lastError;
}
