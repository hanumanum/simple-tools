import { describe, expect, it } from "vitest";
import { mergeChunks, unionNames } from "../src/merge.js";
import type { ChunkTranscript } from "../src/providers/types.js";

function piece(offsetSec: number, durationSec: number, transcript: ChunkTranscript) {
  return { offsetSec, durationSec, transcript };
}

describe("mergeChunks", () => {
  it("shifts timestamps, drops overlap, and joins consecutive turns from the same speaker", () => {
    const merged = mergeChunks([
      piece(0, 10, {
        speakers: ["Artak", "Anna"],
        segments: [
          { speaker: "Artak", start: 1, end: 4, text: "hello" },
          { speaker: "Artak", start: 4.2, end: 6, text: "there" },
          { speaker: "Anna", start: 6.5, end: 9, text: "ok" },
        ],
      }),
      piece(8, 10, {
        speakers: ["Anna", "Artak"],
        segments: [
          { speaker: "Anna", start: 0.5, end: 1.5, text: "ok again" },
          { speaker: "Artak", start: 2.5, end: 5, text: "next" },
        ],
      }),
    ]);

    expect(merged.segments).toEqual([
      { speaker: "Artak", start: 1, end: 6, text: "hello there" },
      { speaker: "Anna", start: 6.5, end: 9, text: "ok" },
      { speaker: "Artak", start: 10.5, end: 13, text: "next" },
    ]);
    expect(merged.speakers).toEqual(["Artak", "Anna"]);
  });

  it("keeps a speaker label when the same person continues after the overlap", () => {
    const merged = mergeChunks([
      piece(0, 10, {
        speakers: ["Artak"],
        segments: [{ speaker: "Artak", start: 0, end: 8, text: "one" }],
      }),
      piece(8, 10, {
        speakers: ["Artak"],
        segments: [
          { speaker: "Artak", start: 0, end: 1.5, text: "dup" },
          { speaker: "Artak", start: 3, end: 6, text: "two" },
        ],
      }),
    ]);

    expect(merged.segments).toEqual([{ speaker: "Artak", start: 0, end: 14, text: "one two" }]);
  });

  it("drops blank text and zero-length segments", () => {
    const merged = mergeChunks([
      piece(0, 5, {
        speakers: ["Anna"],
        segments: [
          { speaker: "Anna", start: 0, end: 1, text: "   " },
          { speaker: "Anna", start: 1, end: 1, text: "no" },
          { speaker: "Anna", start: 1.2, end: 2, text: "yes" },
        ],
      }),
    ]);

    expect(merged.segments).toEqual([{ speaker: "Anna", start: 1.2, end: 2, text: "yes" }]);
  });
});

describe("unionNames", () => {
  it("keeps the first spelling and ignores blanks", () => {
    expect(unionNames(["Artak", " Anna "], ["artak", "", "Karen"])).toEqual(["Artak", "Anna", "Karen"]);
  });
});
