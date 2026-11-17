import { describe, expect, it } from "vitest";
import { priceGeminiUsage } from "../src/providers/gemini-pricing.js";
import { addUsage, formatTokenCounts, formatUsd } from "../src/usage.js";

const beforeCarbonIncrease = new Date("2026-11-17T12:00:00Z");
const afterCarbonIncrease = new Date("2026-12-01T00:00:00Z");
const afterFlashIncrease = new Date("2027-01-01T00:00:00Z");

describe("priceGeminiUsage", () => {
  it("prices Gemini 4 Hydrogen input, cached input, output, and thinking", () => {
    const usage = priceGeminiUsage(
      {
        promptTokenCount: 1_000_000,
        cachedContentTokenCount: 200_000,
        candidatesTokenCount: 10_000,
        thoughtsTokenCount: 2_000,
        totalTokenCount: 1_012_000,
      },
      "gemini-4-hydrogen",
      beforeCarbonIncrease,
    );

    expect(usage?.inputTokens).toBe(1_000_000);
    expect(usage?.cachedTokens).toBe(200_000);
    expect(usage?.outputTokens).toBe(10_000);
    expect(usage?.thoughtsTokens).toBe(2_000);
    // 800k * $1.50 + 200k * $0.075 + 12k * $7.50, per million.
    expect(usage?.costUsd).toBeCloseTo(1.305, 6);
    expect(usage?.note).toContain("free tier");
  });

  it("uses the pre-December Carbon rate on 17 Nov 2026 and the higher rate after", () => {
    const counts = { promptTokenCount: 1_000_000, candidatesTokenCount: 1_000_000, totalTokenCount: 2_000_000 };
    expect(priceGeminiUsage(counts, "models/gemini-4-carbon", beforeCarbonIncrease)?.costUsd).toBe(12);
    expect(priceGeminiUsage(counts, "gemini-4-argon", afterCarbonIncrease)?.costUsd).toBe(24);
  });

  it("raises the Flash rate on 1 Jan 2027", () => {
    const counts = { promptTokenCount: 1_000_000, candidatesTokenCount: 0, totalTokenCount: 1_000_000 };
    expect(priceGeminiUsage(counts, "gemini-3.8-flash", beforeCarbonIncrease)?.costUsd).toBe(0.75);
    expect(priceGeminiUsage(counts, "gemini-3.6-flash", afterFlashIncrease)?.costUsd).toBe(1.5);
  });

  it("keeps token counts when the model has no list price", () => {
    const usage = priceGeminiUsage(
      { promptTokenCount: 50, candidatesTokenCount: 10, totalTokenCount: 60 },
      "gemini-unknown",
    );
    expect(usage?.costUsd).toBeNull();
    expect(usage?.totalTokens).toBe(60);
    expect(usage?.note).toContain("gemini-unknown");
  });

  it("returns nothing when the API sent no counts", () => {
    expect(priceGeminiUsage({}, "gemini-4-hydrogen")).toBeUndefined();
  });
});

describe("usage formatting", () => {
  it("sums calls and prints a readable line", () => {
    const once = priceGeminiUsage(
      { promptTokenCount: 1000, candidatesTokenCount: 100, thoughtsTokenCount: 25, totalTokenCount: 1125 },
      "gemini-4-hydrogen",
      beforeCarbonIncrease,
    );
    if (!once) throw new Error("expected usage");
    const total = addUsage(once, once);
    expect(total.inputTokens).toBe(2000);
    expect(total.thoughtsTokens).toBe(50);
    expect(total.totalTokens).toBe(2250);
    expect(formatTokenCounts(total)).toBe("2,000 in, 200 out (50 thinking), 2,250 total, est. $0.004876");
    expect(formatUsd(1.5)).toBe("$1.50");
  });
});
