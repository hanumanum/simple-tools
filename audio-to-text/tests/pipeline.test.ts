import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { planChunks } from "../src/audio.js";
import { buildTranscriptionPrompt } from "../src/prompts.js";
import type { AudioChunk, ChunkTranscript, TokenUsage, TranscriptionContext, TranscriptionProvider } from "../src/providers/types.js";
import { transcribePaths, type PipelineOptions } from "../src/pipeline.js";
import { parseChunkTranscript, PartialTranscriptError, TranscriptParseError } from "../src/schema.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "audio-to-text-test-"));
  tempDirs.push(dir);
  return dir;
}

async function makeTone(destination: string, seconds: number): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-y",
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:duration=${seconds}`,
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "libmp3lame",
    "-q:a",
    "9",
    destination,
  ]);
}

class FakeProvider implements TranscriptionProvider {
  readonly name = "fake";
  readonly model = "fake-1";
  readonly maxChunkSec: number;

  constructor(maxChunkSec = 3) {
    this.maxChunkSec = maxChunkSec;
  }
  readonly chunks: AudioChunk[] = [];
  readonly contexts: TranscriptionContext[] = [];
  disposed = false;
  calls = 0;

  async transcribe(chunk: AudioChunk, ctx: TranscriptionContext): Promise<ChunkTranscript> {
    this.calls += 1;
    this.chunks.push(chunk);
    this.contexts.push(ctx);
    return {
      speakers: ["Artak", "Anna"],
      segments: [
        { speaker: "Artak", start: 0.2, end: 0.8, text: `a${chunk.index}` },
        { speaker: "Anna", start: 1, end: 1.4, text: `b${chunk.index}` },
      ],
      usage: perCallUsage(),
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

function perCallUsage(): TokenUsage {
  return {
    inputTokens: 100,
    cachedTokens: 0,
    outputTokens: 20,
    thoughtsTokens: 5,
    totalTokens: 125,
    costUsd: 0.001,
  };
}

class ParseFailProvider implements TranscriptionProvider {
  readonly name = "fake";
  readonly model = "fake-1";
  readonly maxChunkSec = 3600;
  calls = 0;
  disposed = false;

  async transcribe(): Promise<ChunkTranscript> {
    this.calls += 1;
    throw new TranscriptParseError("not json", "RAW-RESPONSE", perCallUsage());
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

function options(dir: string, provider: TranscriptionProvider, extra: Partial<PipelineOptions> = {}): PipelineOptions {
  return {
    provider,
    language: "hy",
    speakers: ["Artak", "Anna"],
    hint: "Artak speaks first",
    chunkMinutes: 15,
    outDir: dir,
    force: false,
    logPath: path.join(dir, "transcribe.log"),
    ...extra,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("planChunks", () => {
  it("splits a 40 minute file into overlapping 15 minute chunks", () => {
    expect(planChunks(40 * 60, 15 * 60)).toEqual([
      { start: 0, duration: 900 },
      { start: 890, duration: 900 },
      { start: 1780, duration: 620 },
    ]);
  });

  it("returns one chunk when the file is shorter than the chunk length", () => {
    expect(planChunks(90, 15 * 60)).toEqual([{ start: 0, duration: 90 }]);
  });

  it("starts later in the file when earlier audio is already covered", () => {
    expect(planChunks(40 * 60, 15 * 60, 10, 890)).toEqual([
      { start: 890, duration: 900 },
      { start: 1780, duration: 620 },
    ]);
    expect(planChunks(100, 30, 10, 100)).toEqual([]);
  });
});

describe("parseChunkTranscript", () => {
  it("parses fenced JSON", () => {
    const parsed = parseChunkTranscript(
      '```json\n{"speakers":["Artak"],"segments":[{"speaker":"Artak","start":1,"end":2,"text":"Բարև"}]}\n```',
    );
    expect(parsed.segments[0]?.text).toBe("Բարև");
    expect(parsed.raw).toContain("Բարև");
  });
});

describe("buildTranscriptionPrompt", () => {
  it("keeps the shared prompt usable without a provider-specific rewrite", () => {
    const prompt = buildTranscriptionPrompt({
      language: "hy",
      speakers: ["Artak", "Anna"],
      hint: "Artak speaks first",
      previousSegments: [{ speaker: "Artak", start: 1, end: 2, text: "Բարև" }],
    });
    expect(prompt).toContain("hy");
    expect(prompt).toContain("Armenian");
    expect(prompt).toContain("Artak, Anna");
    expect(prompt).toContain("Artak speaks first");
    expect(prompt).toContain("Բարև");
    expect(prompt).toContain('"segments"');
  });
});

describe("transcribePaths", () => {
  it("runs chunking, context passing, merge, and both writers with a fake provider", async () => {
    const dir = await makeTempDir();
    const sourceDir = path.join(dir, "in");
    const outDir = path.join(dir, "out");
    await fs.mkdir(sourceDir);
    await fs.writeFile(path.join(sourceDir, "notes.txt"), "ignore me");
    const audio = path.join(sourceDir, "talk.mp3");
    await makeTone(audio, 8);

    const provider = new FakeProvider();
    const failed = await transcribePaths(sourceDir, options(outDir, provider));

    expect(failed).toBe(0);
    expect(provider.disposed).toBe(true);
    expect(provider.chunks.length).toBeGreaterThan(1);
    expect(provider.chunks.every((chunk) => chunk.durationSec <= 3.05)).toBe(true);
    expect(provider.contexts[0]?.previousSegments).toBeUndefined();
    expect(provider.contexts[0]?.hint).toBe("Artak speaks first");
    expect(provider.contexts[1]?.speakers).toEqual(["Artak", "Anna"]);
    expect(provider.contexts[1]?.previousSegments?.[0]?.speaker).toBe("Artak");
    expect(provider.contexts[1]?.previousSegments?.[0]?.text).toBe("a0");

    const jsonPath = path.join(outDir, "talk.json");
    const mdPath = path.join(outDir, "talk.md");
    const doc = JSON.parse(await fs.readFile(jsonPath, "utf8")) as {
      sourceFile: string;
      provider: string;
      model: string;
      durationSec: number;
      createdAt: string;
      speakers: string[];
      segments: { speaker: string; text: string }[];
      usage?: TokenUsage;
    };
    expect(doc.sourceFile).toBe(audio);
    expect(doc.provider).toBe("fake");
    expect(doc.model).toBe("fake-1");
    expect(doc.durationSec).toBeGreaterThan(7);
    expect(doc.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(doc.speakers).toEqual(["Artak", "Anna"]);
    expect(doc.segments.length).toBeGreaterThan(0);
    const calls = provider.chunks.length;
    expect(doc).toMatchObject({
      usage: {
        inputTokens: calls * 100,
        cachedTokens: 0,
        outputTokens: calls * 20,
        thoughtsTokens: calls * 5,
        totalTokens: calls * 125,
        costUsd: calls * 0.001,
      },
    });

    const markdown = await fs.readFile(mdPath, "utf8");
    expect(markdown).toContain("# talk");
    expect(markdown).toContain("Speakers: Artak, Anna");
    expect(markdown).toContain("Model: fake/fake-1");
    expect(markdown).toContain(`Tokens: ${(provider.chunks.length * 100).toLocaleString("en-US")} in`);
    expect(markdown).toMatch(/\*\*\[00:00:\d\d\] Artak:\*\*/);
    expect(markdown).toContain("Anna:");
    await expect(fs.access(path.join(outDir, "notes.json"))).rejects.toThrow();
  });

  it("does not overwrite an existing transcript unless force is set", async () => {
    const dir = await makeTempDir();
    const audio = path.join(dir, "talk.mp3");
    await makeTone(audio, 1);
    const provider = new FakeProvider(3600);
    expect(await transcribePaths(audio, options(dir, provider))).toBe(0);
    const original = await fs.readFile(path.join(dir, "talk.md"), "utf8");

    const blocked = new FakeProvider(3600);
    const failed = await transcribePaths(audio, options(dir, blocked));
    expect(failed).toBe(1);
    expect(blocked.calls).toBe(0);
    expect(await fs.readFile(path.join(dir, "talk.md"), "utf8")).toBe(original);
    expect(blocked.disposed).toBe(true);

    const again = new FakeProvider(3600);
    expect(await transcribePaths(audio, options(dir, again, { force: true }))).toBe(0);
    expect(again.calls).toBeGreaterThan(0);
  });

  it("retries a bad parse once, then saves the raw response and continues", async () => {
    const dir = await makeTempDir();
    const audio = path.join(dir, "talk.mp3");
    await makeTone(audio, 1);
    const provider = new ParseFailProvider();
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      logs.push(String(message));
    });
    let failed = 0;
    try {
      failed = await transcribePaths(audio, options(dir, provider));
    } finally {
      spy.mockRestore();
    }

    expect(failed).toBe(1);
    expect(provider.calls).toBe(2);
    expect(provider.disposed).toBe(true);
    expect(await fs.readFile(path.join(dir, "talk.raw.txt"), "utf8")).toContain("RAW-RESPONSE");
    await expect(fs.access(path.join(dir, "talk.md"))).rejects.toThrow();
    const log = await fs.readFile(path.join(dir, "transcribe.log"), "utf8");
    expect(log).toContain("ERROR");
    expect(log).toContain("talk.mp3");
    expect(logs.join("\n")).toContain("tokens before failure: 200 in, 40 out (10 thinking), 250 total, est. $0.002");
  });

  it("continues from the last finished turn when a request stops mid-stream", async () => {
    const dir = await makeTempDir();
    const audio = path.join(dir, "talk.mp3");
    await makeTone(audio, 8);
    const provider = new PartialThenDoneProvider();
    expect(await transcribePaths(audio, options(dir, provider))).toBe(0);
    expect(provider.offsets).toEqual([0, 1]);

    const markdown = await fs.readFile(path.join(dir, "talk.md"), "utf8");
    expect(markdown).toContain("first");
    expect(markdown).toContain("second");
    await expect(fs.access(path.join(dir, "talk.partial.json"))).rejects.toThrow();
  });

  it("resumes a later run from the saved progress file", async () => {
    const dir = await makeTempDir();
    const audio = path.join(dir, "talk.mp3");
    await makeTone(audio, 8);
    await fs.writeFile(
      path.join(dir, "talk.partial.json"),
      `${JSON.stringify(
        {
          sourceFile: path.resolve(audio),
          coveredUntilSec: 5,
          speakers: ["Artak"],
          segments: [{ speaker: "Artak", start: 0.2, end: 5, text: "kept" }],
          usage: perCallUsage(),
        },
        null,
        2,
      )}\n`,
    );

    const provider = new TailProvider();
    expect(await transcribePaths(audio, options(dir, provider))).toBe(0);
    expect(provider.offsets).toEqual([3]);
    expect(provider.contexts[0]?.previousSegments?.[0]?.text).toBe("kept");

    const markdown = await fs.readFile(path.join(dir, "talk.md"), "utf8");
    expect(markdown).toContain("kept");
    expect(markdown).toContain("second");
    const doc = JSON.parse(await fs.readFile(path.join(dir, "talk.json"), "utf8")) as { usage?: TokenUsage };
    expect(doc.usage?.inputTokens).toBe(200);
    await expect(fs.access(path.join(dir, "talk.partial.json"))).rejects.toThrow();
  });

  it("starts over when force is set, even if progress was saved", async () => {
    const dir = await makeTempDir();
    const audio = path.join(dir, "talk.mp3");
    await makeTone(audio, 1);
    await fs.writeFile(
      path.join(dir, "talk.partial.json"),
      `${JSON.stringify({
        sourceFile: path.resolve(audio),
        coveredUntilSec: 0.8,
        segments: [{ speaker: "Artak", start: 0.1, end: 0.8, text: "kept" }],
      })}\n`,
    );
    const provider = new FakeProvider(3600);
    expect(await transcribePaths(audio, options(dir, provider, { force: true }))).toBe(0);
    expect(provider.chunks[0]?.offsetSec).toBe(0);
    expect(await fs.readFile(path.join(dir, "talk.md"), "utf8")).not.toContain("kept");
  });
});

class PartialThenDoneProvider implements TranscriptionProvider {
  readonly name = "fake";
  readonly model = "fake-1";
  readonly maxChunkSec = 3600;
  readonly offsets: number[] = [];
  calls = 0;

  async transcribe(chunk: AudioChunk): Promise<ChunkTranscript> {
    this.calls += 1;
    this.offsets.push(chunk.offsetSec);
    if (this.calls === 1) {
      throw new PartialTranscriptError("503 UNAVAILABLE: high demand", "", [
        { speaker: "Artak", start: 0.2, end: 3, text: "first" },
      ]);
    }
    return {
      speakers: ["Anna"],
      segments: [{ speaker: "Anna", start: 2.5, end: 6, text: "second" }],
    };
  }
}

class TailProvider implements TranscriptionProvider {
  readonly name = "fake";
  readonly model = "fake-1";
  readonly maxChunkSec = 3600;
  readonly offsets: number[] = [];
  readonly contexts: TranscriptionContext[] = [];

  async transcribe(chunk: AudioChunk, ctx: TranscriptionContext): Promise<ChunkTranscript> {
    this.offsets.push(chunk.offsetSec);
    this.contexts.push(ctx);
    return {
      speakers: ["Anna"],
      segments: [{ speaker: "Anna", start: 0.5, end: Math.max(1, chunk.durationSec - 0.2), text: "second" }],
      usage: perCallUsage(),
    };
  }
}
