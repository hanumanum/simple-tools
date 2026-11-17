import type { TokenUsage } from "./providers/types.js";

export function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    thoughtsTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
}

export function roundMoney(amount: number): number {
  return Math.round(amount * 1_000_000) / 1_000_000;
}

export function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  const costUsd =
    left.costUsd === null || right.costUsd === null ? null : roundMoney(left.costUsd + right.costUsd);
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedTokens: left.cachedTokens + right.cachedTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    thoughtsTokens: left.thoughtsTokens + right.thoughtsTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    costUsd,
    note: joinNotes(left.note, right.note),
  };
}

export function hasUsage(usage: TokenUsage | undefined): usage is TokenUsage {
  if (!usage) return false;
  return usage.totalTokens > 0 || usage.inputTokens > 0 || usage.outputTokens > 0 || usage.thoughtsTokens > 0;
}

export function formatUsd(amount: number): string {
  if (amount === 0) return "$0.00";
  const trimmed = amount.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  const decimals = trimmed.split(".")[1] ?? "";
  if (decimals.length < 2) return `$${amount.toFixed(2)}`;
  return `$${trimmed}`;
}

export function formatTokenCounts(usage: TokenUsage): string {
  const input = usage.inputTokens.toLocaleString("en-US");
  const output = usage.outputTokens.toLocaleString("en-US");
  const total = usage.totalTokens.toLocaleString("en-US");
  const cached = usage.cachedTokens > 0 ? `, ${usage.cachedTokens.toLocaleString("en-US")} cached` : "";
  const thoughts = usage.thoughtsTokens > 0 ? ` (${usage.thoughtsTokens.toLocaleString("en-US")} thinking)` : "";
  const cost = usage.costUsd === null ? "est. cost unavailable" : `est. ${formatUsd(usage.costUsd)}`;
  return `${input} in${cached}, ${output} out${thoughts}, ${total} total, ${cost}`;
}

function joinNotes(left?: string, right?: string): string | undefined {
  if (!left) return right;
  if (!right || left === right) return left;
  return `${left} ${right}`;
}
