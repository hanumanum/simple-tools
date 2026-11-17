import type { AudioChunk, ChunkTranscript, TranscriptionContext, TranscriptionProvider } from "./types.js";

const DEFAULT_OPENAI_MODEL = "gpt-4o-transcribe";

/**
 * Stub showing how a second provider plugs in.
 *
 * TODO: Implement OpenAI audio transcription:
 * - Send the mp3 chunk (Files API upload, or inline input_audio, depending on the model).
 * - Call an audio-capable model with the shared prompt from src/prompts.ts.
 * - If the model has no response-schema equivalent, the shared prompt already asks for JSON.
 *   Parse that text with parseChunkTranscript from src/schema.ts.
 * - Wrap the HTTP call in withRetry from src/retry.ts so 429 and 5xx responses back off.
 * - Delete any uploaded file when the call finishes, and again from dispose().
 * - Copy token counts from the API response onto ChunkTranscript.usage, and set costUsd from that provider's price card.
 * - Keep the SDK import inside this file only.
 */
export class OpenAIProvider implements TranscriptionProvider {
  readonly name = "openai";
  readonly model: string;
  /** Placeholder until the real per-request audio limit is confirmed. */
  readonly maxChunkSec = 25 * 60;
  private readonly apiKey: string;

  constructor(options: { apiKey: string; model?: string }) {
    this.apiKey = options.apiKey;
    this.model = options.model?.trim() || DEFAULT_OPENAI_MODEL;
    if (!this.apiKey.trim()) {
      throw new Error("Missing OPENAI_API_KEY. Add it to .env. It is required when LLM_PROVIDER=openai.");
    }
    throw new Error(
      "OpenAI provider is not implemented. Set LLM_PROVIDER=gemini, or implement src/providers/openai.ts.",
    );
  }

  transcribe(_chunk: AudioChunk, _ctx: TranscriptionContext): Promise<ChunkTranscript> {
    return Promise.reject(
      new Error("OpenAI provider is not implemented. Set LLM_PROVIDER=gemini, or implement src/providers/openai.ts."),
    );
  }
}
