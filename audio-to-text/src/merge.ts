import type { ChunkTranscript, Segment } from "./providers/types.js";

export interface ChunkPiece {
  offsetSec: number;
  durationSec: number;
  transcript: ChunkTranscript;
}

const COVERAGE_EPSILON_SEC = 0.3;

export function unionNames(base: string[] | undefined, extra: string[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const name of [...(base ?? []), ...extra]) {
    const trimmed = name.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    names.push(trimmed);
  }
  return names;
}

function speakersInOrder(segments: Segment[]): string[] {
  return unionNames(
    undefined,
    segments.map((segment) => segment.speaker),
  );
}

function mergeConsecutive(segments: Segment[]): Segment[] {
  const merged: Segment[] = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    if (previous && previous.speaker === segment.speaker) {
      previous.end = Math.max(previous.end, segment.end);
      previous.text = `${previous.text} ${segment.text}`.replace(/\s+/g, " ").trim();
      continue;
    }
    merged.push({ ...segment });
  }
  return merged;
}

export function mergeChunks(pieces: ChunkPiece[]): { speakers: string[]; segments: Segment[] } {
  const ordered = [...pieces].sort((a, b) => a.offsetSec - b.offsetSec);
  const kept: Segment[] = [];
  let coverageEnd = 0;
  let hasCoverage = false;

  for (const piece of ordered) {
    const segments = [...piece.transcript.segments]
      .filter(
        (segment) =>
          segment.text.trim().length > 0 &&
          Number.isFinite(segment.start) &&
          Number.isFinite(segment.end) &&
          segment.end > segment.start,
      )
      .sort((a, b) => a.start - b.start);

    for (const segment of segments) {
      const start = segment.start + piece.offsetSec;
      const end = segment.end + piece.offsetSec;
      if (hasCoverage && end <= coverageEnd + COVERAGE_EPSILON_SEC) continue;
      kept.push({
        speaker: segment.speaker.trim(),
        start,
        end,
        text: segment.text.trim(),
      });
    }

    coverageEnd = Math.max(coverageEnd, piece.offsetSec + piece.durationSec);
    hasCoverage = true;
  }

  const segments = mergeConsecutive(kept);
  return { speakers: speakersInOrder(segments), segments };
}
