import { z } from "zod";
import type { ChunkTranscript, Segment, TokenUsage } from "./providers/types.js";

export const segmentSchema = z.object({
  speaker: z.string().trim().min(1),
  start: z.number().finite().nonnegative(),
  end: z.number().finite().nonnegative(),
  text: z.string(),
});

export const chunkTranscriptSchema = z.object({
  speakers: z.array(z.string().trim().min(1)).default([]),
  segments: z.array(segmentSchema),
});

export class TranscriptParseError extends Error {
  readonly raw: string;
  readonly usage?: TokenUsage;

  constructor(message: string, raw: string, usage?: TokenUsage) {
    super(message);
    this.name = "TranscriptParseError";
    this.raw = raw;
    this.usage = usage;
  }
}

/** The model accepted the audio and returned no transcript text. Do not retry the same span. */
export class EmptyTranscriptError extends Error {
  readonly retryable = false;
  readonly usage?: TokenUsage;

  constructor(message: string, usage?: TokenUsage) {
    super(message);
    this.name = "EmptyTranscriptError";
    this.usage = usage;
  }
}

/** The stream died after one or more turns were already complete. Do not retry the same span. */
export class PartialTranscriptError extends Error {
  readonly retryable = false;
  readonly raw: string;
  readonly segments: Segment[];
  readonly usage?: TokenUsage;

  constructor(reason: string, raw: string, segments: Segment[], usage?: TokenUsage) {
    super(reason);
    this.name = "PartialTranscriptError";
    this.raw = raw;
    this.segments = segments;
    this.usage = usage;
  }
}

function extractJson(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const body = fenced?.[1]?.trim() ?? trimmed;
  if (body.startsWith("{") || body.startsWith("[")) return body;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start >= 0 && end > start) return body.slice(start, end + 1);
  return body;
}

export function parseChunkTranscript(raw: string): ChunkTranscript {
  let data: unknown;
  try {
    data = JSON.parse(extractJson(raw));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TranscriptParseError(`Provider response was not valid JSON: ${detail}`, raw);
  }

  const parsed = chunkTranscriptSchema.safeParse(data);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new TranscriptParseError(`Provider response failed validation: ${detail}`, raw);
  }

  return {
    speakers: parsed.data.speakers,
    segments: parsed.data.segments.map((segment) => ({
      speaker: segment.speaker,
      start: segment.start,
      end: segment.end,
      text: segment.text.trim(),
    })),
    raw,
  };
}
