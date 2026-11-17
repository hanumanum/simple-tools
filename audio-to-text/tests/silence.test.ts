import { describe, expect, it } from "vitest";
import { planChunks } from "../src/audio.js";
import {
  compressedToOriginal,
  keptSpans,
  parseSilenceLog,
  planChunksOnSilence,
  removableSilenceSec,
} from "../src/silence.js";

describe("parseSilenceLog", () => {
  it("reads silence ranges and closes a pause that runs to the end", () => {
    const log = [
      "[silencedetect @ 0x1] silence_start: 2.0",
      "[silencedetect @ 0x1] silence_end: 6.5 | silence_duration: 4.5",
      "[silencedetect @ 0x1] silence_start: 12",
      "frame= 10",
    ].join("\n");
    expect(parseSilenceLog(log, 14)).toEqual([
      { start: 2, end: 6.5 },
      { start: 12, end: 14 },
    ]);
  });
});

describe("keptSpans", () => {
  it("shortens a long pause and leaves speech untouched", () => {
    expect(keptSpans(0, 300, [{ start: 100, end: 110 }])).toEqual([
      { originalStart: 0, originalEnd: 100.4 },
      { originalStart: 110, originalEnd: 300 },
    ]);
    expect(removableSilenceSec([{ start: 100, end: 110 }])).toBe(9.6);
  });

  it("keeps a short pause intact", () => {
    expect(keptSpans(0, 20, [{ start: 5, end: 5.5 }])).toEqual([{ originalStart: 0, originalEnd: 20 }]);
    expect(removableSilenceSec([{ start: 5, end: 5.5 }])).toBe(0);
  });

  it("maps compressed time back onto the original clock", () => {
    const spans = keptSpans(0, 300, [{ start: 100, end: 110 }]);
    expect(compressedToOriginal(100.4, spans, 0)).toBe(100.4);
    expect(compressedToOriginal(100.5, spans, 0)).toBe(110.1);
    expect(compressedToOriginal(0, spans, 0)).toBe(0);
  });
});

describe("planChunksOnSilence", () => {
  it("matches a fixed cut when there is no pause", () => {
    expect(planChunksOnSilence(40 * 60, 15 * 60, [])).toEqual(planChunks(40 * 60, 15 * 60));
    expect(planChunksOnSilence(90, 15 * 60, [])).toEqual([{ start: 0, duration: 90 }]);
    expect(planChunksOnSilence(100, 30, [], 100)).toEqual([]);
  });

  it("ends a chunk at a pause and skips that pause", () => {
    expect(planChunksOnSilence(400, 300, [{ start: 290, end: 298 }])).toEqual([
      { start: 0, duration: 290 },
      { start: 298, duration: 102 },
    ]);
  });

  it("keeps the overlap when nothing is quiet near the boundary", () => {
    expect(planChunksOnSilence(400, 300, [{ start: 20, end: 21 }])).toEqual(planChunks(400, 300));
  });
});
