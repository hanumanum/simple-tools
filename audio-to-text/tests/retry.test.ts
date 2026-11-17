import { describe, expect, it } from "vitest";
import { describeFailure, isRetryableError } from "../src/retry.js";
import { PartialTranscriptError } from "../src/schema.js";

describe("describeFailure", () => {
  it("unwraps a Gemini JSON error into a short status line", () => {
    const error = new Error(
      JSON.stringify({
        error: {
          code: 503,
          message: "This model is currently experiencing high demand. Please try again later.",
          status: "UNAVAILABLE",
        },
      }),
    );
    expect(describeFailure(error)).toBe(
      "503 UNAVAILABLE: This model is currently experiencing high demand. Please try again later.",
    );
  });

  it("keeps a plain error message", () => {
    expect(describeFailure(new Error("ffmpeg failed"))).toBe("ffmpeg failed");
  });

  it("does not retry a partial transcript even when the cause was a 503", () => {
    const error = new PartialTranscriptError("503 UNAVAILABLE: high demand", "", [
      { speaker: "Artak", start: 0, end: 1, text: "Բարև" },
    ]);
    expect(isRetryableError(error)).toBe(false);
    expect(isRetryableError(new Error("fetch failed"))).toBe(true);
  });
});
