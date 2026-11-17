import { describe, expect, it } from "vitest";
import { completeSegments } from "../src/providers/segment-stream.js";

describe("completeSegments", () => {
  it("returns only turns whose JSON object has closed", () => {
    const partial =
      '{"speakers":["Artak","Anna"],"segments":[{"speaker":"Artak","start":1.2,"end":4,"text":"Բարև"},{"speaker":"Anna","start":4,"end":6,"text":"he';
    expect(completeSegments(partial)).toEqual([
      { speaker: "Artak", start: 1.2, end: 4, text: "Բարև" },
    ]);
  });

  it("keeps quotes and braces that are inside the spoken text", () => {
    const raw =
      '{"segments":[{"speaker":"Artak","start":0,"end":1,"text":"he said \\"hi\\" } and left"}]}';
    expect(completeSegments(raw)).toEqual([
      { speaker: "Artak", start: 0, end: 1, text: 'he said "hi" } and left' },
    ]);
  });

  it("returns nothing before the segments array starts", () => {
    expect(completeSegments('{"speakers":["Artak"]')).toEqual([]);
  });
});
