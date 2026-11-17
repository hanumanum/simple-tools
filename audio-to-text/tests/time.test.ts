import { describe, expect, it } from "vitest";
import { formatTimestamp } from "../src/time.js";

describe("formatTimestamp", () => {
  it("formats zero as clock time", () => {
    expect(formatTimestamp(0)).toBe("00:00:00");
  });

  it("zero-pads seconds", () => {
    expect(formatTimestamp(3)).toBe("00:00:03");
  });

  it("carries seconds into minutes", () => {
    expect(formatTimestamp(65)).toBe("00:01:05");
  });

  it("carries minutes into hours", () => {
    expect(formatTimestamp(3661)).toBe("01:01:01");
  });

  it("truncates fractional seconds", () => {
    expect(formatTimestamp(3.9)).toBe("00:00:03");
  });

  it("clamps negative values", () => {
    expect(formatTimestamp(-4)).toBe("00:00:00");
  });
});
