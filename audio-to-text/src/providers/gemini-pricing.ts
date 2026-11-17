import type { TokenUsage } from "./types.js";
import { roundMoney } from "../usage.js";

/** Counts copied from a Gemini generateContent usageMetadata object. */
export interface GeminiTokenCounts {
  promptTokenCount?: number;
  cachedContentTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  toolUsePromptTokenCount?: number;
  totalTokenCount?: number;
}

interface ModelRate {
  inputPerMillion: number;
  outputPerMillion: number;
  cachePerMillion: number;
  note: string;
}

const FREE_TIER_NOTE =
  "Estimated from the paid-tier list price. On the free tier this model is $0 until that quota is used.";
const PAID_NOTE = "Estimated from the paid-tier list price. This model is billed on every request.";

const CARBON_ARGON_INCREASE = Date.parse("2026-12-01T00:00:00Z");
const FLASH_INCREASE = Date.parse("2027-01-01T00:00:00Z");

function normalizeModel(model: string): string {
  return model.trim().toLowerCase().replace(/^models\//, "");
}

function rateFor(model: string, now: Date): ModelRate | null {
  const id = normalizeModel(model);
  const at = now.getTime();

  if (id === "gemini-4-hydrogen" || id.startsWith("gemini-4-hydrogen-")) {
    return { inputPerMillion: 1.5, outputPerMillion: 7.5, cachePerMillion: 0.075, note: FREE_TIER_NOTE };
  }

  if (
    id === "gemini-4-carbon" ||
    id.startsWith("gemini-4-carbon-") ||
    id === "gemini-4-argon" ||
    id.startsWith("gemini-4-argon-")
  ) {
    const later = at >= CARBON_ARGON_INCREASE;
    return {
      inputPerMillion: later ? 4 : 2,
      outputPerMillion: later ? 20 : 10,
      cachePerMillion: later ? 0.2 : 0.1,
      note: PAID_NOTE,
    };
  }

  if (id === "gemini-3.8-flash" || id === "gemini-3.6-flash") {
    const later = at >= FLASH_INCREASE;
    return {
      inputPerMillion: later ? 1.5 : 0.75,
      outputPerMillion: later ? 7.5 : 3.75,
      cachePerMillion: later ? 0.15 : 0.075,
      note: FREE_TIER_NOTE,
    };
  }

  return null;
}

/**
 * Turn Gemini usage metadata into token totals and a USD estimate.
 * Input price applies to uncached prompt tokens. Cached prompt tokens use the cache rate.
 * Output price applies to response tokens and thinking tokens.
 * Returns undefined when the response carried no counts.
 */
export function priceGeminiUsage(counts: GeminiTokenCounts, model: string, now = new Date()): TokenUsage | undefined {
  const prompt = counts.promptTokenCount ?? 0;
  const cached = Math.min(counts.cachedContentTokenCount ?? 0, prompt);
  const candidates = counts.candidatesTokenCount ?? 0;
  const thoughts = counts.thoughtsTokenCount ?? 0;
  const tool = counts.toolUsePromptTokenCount ?? 0;
  const total = counts.totalTokenCount ?? prompt + candidates + thoughts + tool;
  if (prompt === 0 && candidates === 0 && thoughts === 0 && tool === 0 && total === 0) return undefined;

  const rate = rateFor(model, now);
  const uncached = Math.max(0, prompt - cached);
  const costUsd = rate
    ? roundMoney(
        (uncached * rate.inputPerMillion +
          cached * rate.cachePerMillion +
          tool * rate.inputPerMillion +
          (candidates + thoughts) * rate.outputPerMillion) /
          1_000_000,
      )
    : null;

  return {
    inputTokens: prompt + tool,
    cachedTokens: cached,
    outputTokens: candidates,
    thoughtsTokens: thoughts,
    totalTokens: total,
    costUsd,
    note: rate?.note ?? `No published list price for ${model}. Token counts are from the API.`,
  };
}
