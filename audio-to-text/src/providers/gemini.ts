import {
  FileState,
  GoogleGenAI,
  Type,
  type File,
  type Schema,
} from "@google/genai";
import { buildTranscriptionPrompt } from "../prompts.js";
import { EmptyTranscriptError, parseChunkTranscript, PartialTranscriptError, TranscriptParseError } from "../schema.js";
import { describeFailure, withRetry } from "../retry.js";
import { elapsedSec, formatTimestamp, sleep } from "../time.js";
import { priceGeminiUsage } from "./gemini-pricing.js";
import { completeSegments, type StreamSegment } from "./segment-stream.js";
import type { AudioChunk, ChunkTranscript, TokenUsage, TranscriptionContext, TranscriptionProvider } from "./types.js";

/** Current audio-capable Gemini model (text, image, audio, video). Override with LLM_MODEL. */
export const DEFAULT_GEMINI_MODEL = "gemini-4-hydrogen";

/** Gemini accepts about 9.5 hours of audio in one prompt. */
const GEMINI_MAX_AUDIO_SEC = 9.5 * 60 * 60;
const FILE_READY_TIMEOUT_MS = 3 * 60 * 1000;
const STATUS_INTERVAL_MS = 15_000;

function emptyResponseNote(piece: {
  promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
  candidates?: { finishReason?: string; finishMessage?: string }[];
}): string {
  const block = piece.promptFeedback?.blockReason;
  if (block) {
    const message = piece.promptFeedback?.blockReasonMessage;
    return `prompt blocked (${block}${message ? `: ${message}` : ""})`;
  }
  const candidate = piece.candidates?.[0];
  if (candidate?.finishReason) {
    const message = candidate.finishMessage ? `: ${candidate.finishMessage}` : "";
    return `finish ${candidate.finishReason}${message}`;
  }
  return "";
}

const transcriptResponseSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    speakers: {
      type: Type.ARRAY,
      description: "Distinct speaker names used in this chunk.",
      items: { type: Type.STRING },
    },
    segments: {
      type: Type.ARRAY,
      description: "Speaking turns, in order. Times are seconds from the start of this chunk.",
      items: {
        type: Type.OBJECT,
        properties: {
          speaker: { type: Type.STRING },
          start: { type: Type.NUMBER },
          end: { type: Type.NUMBER },
          text: { type: Type.STRING },
        },
        required: ["speaker", "start", "end", "text"],
      },
    },
  },
  required: ["speakers", "segments"],
  propertyOrdering: ["speakers", "segments"],
};

export interface GeminiProviderOptions {
  apiKey: string;
  model?: string;
}

export class GeminiProvider implements TranscriptionProvider {
  readonly name = "gemini";
  readonly model: string;
  readonly maxChunkSec = GEMINI_MAX_AUDIO_SEC;
  private readonly client: GoogleGenAI;
  private readonly pending = new Set<string>();

  constructor(options: GeminiProviderOptions) {
    if (!options.apiKey.trim()) {
      throw new Error("Missing GEMINI_API_KEY. Add it to .env. It is required when LLM_PROVIDER=gemini.");
    }
    this.model = options.model?.trim() || DEFAULT_GEMINI_MODEL;
    this.client = new GoogleGenAI({ apiKey: options.apiKey });
  }

  async transcribe(chunk: AudioChunk, ctx: TranscriptionContext): Promise<ChunkTranscript> {
    const onRetry = (error: unknown, attempt: number, attempts: number, delayMs: number): void => {
      this.status(
        chunk,
        `request failed (${describeFailure(error)}). Attempt ${attempt} of ${attempts} failed, retrying in ${(delayMs / 1000).toFixed(0)}s.`,
      );
    };
    const uploaded = await withRetry(() => this.upload(chunk), { onRetry });
    try {
      const generated = await withRetry(() => this.generate(uploaded, chunk, ctx), { onRetry });
      try {
        const transcript = parseChunkTranscript(generated.text);
        return { ...transcript, usage: generated.usage };
      } catch (error) {
        if (error instanceof TranscriptParseError) {
          throw new TranscriptParseError(error.message, error.raw, generated.usage);
        }
        throw error;
      }
    } finally {
      await this.deleteUploaded(uploaded.name);
    }
  }

  async dispose(): Promise<void> {
    const names = [...this.pending];
    this.pending.clear();
    await Promise.all(names.map((name) => this.deleteUploaded(name)));
  }

  private status(chunk: AudioChunk, message: string): void {
    console.log(`  chunk ${chunk.index + 1}/${chunk.total}: ${message}`);
  }

  private async upload(chunk: AudioChunk): Promise<File> {
    this.status(chunk, `uploading ${chunk.durationSec.toFixed(0)}s of audio to Gemini...`);
    const uploaded = await this.client.files.upload({
      file: chunk.path,
      config: {
        mimeType: "audio/mpeg",
        displayName: `chunk-${chunk.index + 1}`,
      },
    });
    if (uploaded.name) this.pending.add(uploaded.name);
    this.status(chunk, "upload accepted");
    return this.waitUntilActive(uploaded, chunk);
  }

  private needsProcessing(file: File): boolean {
    if (file.state === FileState.FAILED) return false;
    if (file.state === FileState.PROCESSING) return true;
    return !file.uri;
  }

  private async waitUntilActive(file: File, chunk: AudioChunk): Promise<File> {
    let current = file;
    if (!this.needsProcessing(current)) return current;

    const started = Date.now();
    const deadline = started + FILE_READY_TIMEOUT_MS;
    this.status(chunk, `file is ${current.state ?? "PROCESSING"}, waiting for it to be ready`);
    while (this.needsProcessing(current)) {
      if (!current.name) break;
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for Gemini file ${current.name} to become ACTIVE.`);
      }
      await sleep(5000);
      current = await this.client.files.get({ name: current.name });
      if (this.needsProcessing(current)) {
        this.status(chunk, `still waiting for the file (${elapsedSec(started)}s)`);
      }
    }
    if (current.state === FileState.FAILED) {
      const detail = current.error?.message ? `: ${current.error.message}` : ".";
      throw new Error(`Gemini failed to process the uploaded audio${detail}`);
    }
    this.status(chunk, "file is ready");
    return current;
  }

  private async generate(
    file: File,
    chunk: AudioChunk,
    ctx: TranscriptionContext,
  ): Promise<{ text: string; usage?: TokenUsage }> {
    if (!file.uri) throw new Error("Gemini file upload did not return a URI.");
    this.status(chunk, `transcribing with ${this.model}. Lines appear as each turn finishes...`);
    const started = Date.now();
    const timer = setInterval(() => {
      this.status(chunk, `still transcribing (${elapsedSec(started)}s)`);
    }, STATUS_INTERVAL_MS);
    timer.unref();
    const request = {
      model: this.model,
      contents: [
        {
          role: "user",
          parts: [
            { text: buildTranscriptionPrompt(ctx) },
            {
              fileData: {
                fileUri: file.uri,
                mimeType: file.mimeType ?? "audio/mpeg",
              },
            },
          ],
        },
      ],
      config: {
        temperature: 0,
        maxOutputTokens: 65536,
        responseMimeType: "application/json",
        responseSchema: transcriptResponseSchema,
      },
    };
    let raw = "";
    let shown = 0;
    let usage: TokenUsage | undefined;
    let stopNote = "";
    try {
      const stream = await this.client.models.generateContentStream(request);
      for await (const piece of stream) {
        if (piece.usageMetadata) {
          const priced = priceGeminiUsage(piece.usageMetadata, this.model);
          if (priced) usage = priced;
        }
        const note = emptyResponseNote(piece);
        if (note) stopNote = note;
        const delta = piece.text ?? "";
        if (!delta) continue;
        raw += delta;
        const ready = completeSegments(raw);
        if (ready.length > shown) {
          clearInterval(timer);
          for (const segment of ready.slice(shown)) {
            this.printSegment(chunk, segment);
            ctx.onSegment?.(segment);
          }
          shown = ready.length;
        }
      }
      if (!raw) {
        const why = stopNote ? `: ${stopNote}` : " (0 output tokens)";
        throw new EmptyTranscriptError(`Gemini returned an empty response${why}.`, usage);
      }
      return { text: raw, usage };
    } catch (error) {
      const ready = completeSegments(raw);
      if (ready.length > 0 && !(error instanceof TranscriptParseError) && !(error instanceof PartialTranscriptError)) {
        this.status(
          chunk,
          `stream stopped (${describeFailure(error)}) after ${ready.length} turn(s). The next piece starts from the last finished line.`,
        );
        throw new PartialTranscriptError(describeFailure(error), raw, ready, usage);
      }
      throw error;
    } finally {
      clearInterval(timer);
    }
  }

  private printSegment(chunk: AudioChunk, segment: StreamSegment): void {
    const local = chunk.toOriginal ? chunk.toOriginal(segment.start) : segment.start;
    const at = formatTimestamp(chunk.offsetSec + local);
    const text = segment.text.replace(/\s+/g, " ").trim();
    console.log(`    [${at}] ${segment.speaker}: ${text}`);
  }

  private async deleteUploaded(name: string | undefined): Promise<void> {
    if (!name) return;
    this.pending.delete(name);
    try {
      await this.client.files.delete({ name });
    } catch {
      this.pending.add(name);
    }
  }
}
