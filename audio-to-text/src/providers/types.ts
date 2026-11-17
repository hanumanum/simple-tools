export interface AudioChunk {
  path: string;
  index: number;
  total: number;
  offsetSec: number;
  /** Length of this piece on the original recording. */
  durationSec: number;
  /** Maps a time on the audio sent to the model back to seconds from this piece's original start. */
  toOriginal?: (compressedSec: number) => number;
}

export interface Segment {
  speaker: string;
  start: number;
  end: number;
  text: string;
}

export interface TranscriptionContext {
  language: string;
  speakers?: string[];
  hint?: string;
  previousSegments?: Segment[];
  /** Called with each speaking turn as soon as its JSON object is complete. Times are relative to this chunk. */
  onSegment?: (segment: Segment) => void;
}

/** Token counts for one model call, plus a list-price estimate when the provider knows the rate. */
export interface TokenUsage {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  thoughtsTokens: number;
  totalTokens: number;
  /** Paid-tier list price in USD. Null when this model has no rate in the provider's table. */
  costUsd: number | null;
  note?: string;
}

export interface ChunkTranscript {
  speakers: string[];
  segments: Segment[];
  raw?: string;
  usage?: TokenUsage;
}

export interface TranscriptionProvider {
  readonly name: string;
  readonly model: string;
  readonly maxChunkSec?: number;
  transcribe(chunk: AudioChunk, ctx: TranscriptionContext): Promise<ChunkTranscript>;
  dispose?(): Promise<void>;
}
