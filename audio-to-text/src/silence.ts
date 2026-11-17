import { round3 } from "./time.js";

/** Pauses quieter than this are treated as silence. */
export const SILENCE_NOISE_DB = -35;
/** Ignore gaps shorter than this when looking for a place to split. */
export const SILENCE_MIN_SEC = 0.4;
/** Pauses at least this long are shortened before the audio is sent. */
export const LONG_SILENCE_SEC = 2;
/** How much of a long pause to leave, so two turns do not slam together. */
export const KEPT_SILENCE_SEC = 0.4;

export interface SilenceSpan {
  start: number;
  end: number;
}

export interface KeptSpan {
  originalStart: number;
  originalEnd: number;
}

export function parseSilenceLog(log: string, durationSec: number): SilenceSpan[] {
  const spans: SilenceSpan[] = [];
  let open: number | null = null;
  for (const line of log.split(/\r?\n/)) {
    const startMatch = /silence_start:\s*([0-9.]+)/.exec(line);
    const startText = startMatch?.[1];
    if (startText) {
      const start = Number(startText);
      if (Number.isFinite(start)) open = start;
      continue;
    }
    const endMatch = /silence_end:\s*([0-9.]+)/.exec(line);
    const endText = endMatch?.[1];
    if (endText && open !== null) {
      const end = Number(endText);
      if (Number.isFinite(end) && end > open) spans.push({ start: open, end });
      open = null;
    }
  }
  if (open !== null && durationSec > open) spans.push({ start: open, end: durationSec });
  return mergeSilences(spans);
}

export function mergeSilences(silences: SilenceSpan[]): SilenceSpan[] {
  const ordered = silences.filter((span) => span.end > span.start).sort((a, b) => a.start - b.start);
  const merged: SilenceSpan[] = [];
  for (const span of ordered) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end + 0.02) {
      last.end = round3(Math.max(last.end, span.end));
      continue;
    }
    merged.push({ start: round3(span.start), end: round3(span.end) });
  }
  return merged;
}

export function removableSilenceSec(silences: SilenceSpan[]): number {
  const removed = silences.reduce((sum, span) => {
    const length = span.end - span.start;
    if (length < LONG_SILENCE_SEC) return sum;
    return sum + (length - KEPT_SILENCE_SEC);
  }, 0);
  return round3(removed);
}

/**
 * Speech plus a short breath where a long pause was.
 * Times stay on the original file clock.
 */
export function keptSpans(rangeStart: number, rangeEnd: number, silences: SilenceSpan[]): KeptSpan[] {
  if (!(rangeEnd > rangeStart)) return [];
  const clips = mergeSilences(silences)
    .map((span) => ({
      start: Math.max(span.start, rangeStart),
      end: Math.min(span.end, rangeEnd),
      full: span.end - span.start,
    }))
    .filter((span) => span.end - span.start > 0.02 && span.full >= LONG_SILENCE_SEC)
    .sort((a, b) => a.start - b.start);

  const kept: KeptSpan[] = [];
  let cursor = rangeStart;
  for (const span of clips) {
    if (span.start > cursor + 0.001) {
      const keepEnd = Math.min(span.end, span.start + KEPT_SILENCE_SEC);
      kept.push({ originalStart: round3(cursor), originalEnd: round3(keepEnd) });
    } else {
      const breathEnd = Math.min(span.end, cursor + KEPT_SILENCE_SEC);
      if (breathEnd > cursor + 0.001) {
        kept.push({ originalStart: round3(cursor), originalEnd: round3(breathEnd) });
      }
    }
    cursor = Math.max(cursor, span.end);
  }
  if (rangeEnd > cursor + 0.001) {
    kept.push({ originalStart: round3(cursor), originalEnd: round3(rangeEnd) });
  }
  return joinTouching(kept);
}

export function keptDuration(spans: KeptSpan[]): number {
  const total = spans.reduce((sum, span) => sum + (span.originalEnd - span.originalStart), 0);
  return round3(total);
}

/** Seconds from the start of this chunk on the original clock. */
export function compressedToOriginal(compressedSec: number, spans: KeptSpan[], rangeStart: number): number {
  if (!(compressedSec > 0) || spans.length === 0) {
    const first = spans[0];
    return round3((first?.originalStart ?? rangeStart) - rangeStart);
  }
  let cursor = 0;
  for (const span of spans) {
    const duration = span.originalEnd - span.originalStart;
    const endCursor = cursor + duration;
    if (compressedSec <= endCursor + 1e-6) {
      const into = Math.min(Math.max(0, compressedSec - cursor), duration);
      return round3(span.originalStart + into - rangeStart);
    }
    cursor = endCursor;
  }
  const last = spans[spans.length - 1];
  return round3((last?.originalEnd ?? rangeStart) - rangeStart);
}

export interface SilenceChunkPlan {
  start: number;
  duration: number;
}

/**
 * Aim for `chunkSec`, but end on a pause when one is near the boundary.
 * With no usable pause, chunks overlap by `overlapSec` the way a fixed cut does.
 */
export function planChunksOnSilence(
  durationSec: number,
  chunkSec: number,
  silences: SilenceSpan[],
  startSec = 0,
  overlapSec = 10,
): SilenceChunkPlan[] {
  if (!(durationSec > 0)) throw new Error("Audio duration must be greater than zero.");
  if (!(chunkSec > 0)) throw new Error("Chunk length must be greater than zero.");

  const origin = round3(Math.min(Math.max(0, startSec), durationSec));
  if (origin >= durationSec - 0.05) return [];

  const pauses = mergeSilences(silences).filter((span) => span.end - span.start >= SILENCE_MIN_SEC);
  const searchBefore = Math.min(45, chunkSec * 0.5);
  const searchAfter = Math.min(20, Math.max(0.25, chunkSec * 0.15));
  const minChunk = Math.min(20, chunkSec * 0.5);
  const plans: SilenceChunkPlan[] = [];
  let start = origin;
  const limit = Math.ceil(durationSec / Math.max(1, Math.min(chunkSec * 0.5, 30))) + 5;

  for (let index = 0; index < limit && start < durationSec - 0.05; index += 1) {
    const remaining = durationSec - start;
    if (remaining <= chunkSec) {
      plans.push({ start: round3(start), duration: round3(remaining) });
      break;
    }

    const target = start + chunkSec;
    const split = findSplit(start, target, durationSec, pauses, searchBefore, searchAfter, minChunk);
    if (split) {
      plans.push({ start: round3(start), duration: round3(split.chunkEnd - start) });
      if (split.nextStart <= start + 0.05) break;
      start = split.nextStart;
      continue;
    }

    const duration = round3(Math.min(chunkSec, remaining));
    const overlap = Math.min(Math.max(overlapSec, 0), duration / 2);
    plans.push({ start: round3(start), duration });
    const next = round3(start + duration - overlap);
    if (next <= start + 0.05) break;
    start = next;
  }

  return plans;
}

function findSplit(
  start: number,
  target: number,
  durationSec: number,
  pauses: SilenceSpan[],
  searchBefore: number,
  searchAfter: number,
  minChunk: number,
): { chunkEnd: number; nextStart: number } | null {
  const windowStart = target - searchBefore;
  const windowEnd = Math.min(durationSec, target + searchAfter);
  let best: { chunkEnd: number; nextStart: number; distance: number } | null = null;

  for (const pause of pauses) {
    if (pause.start <= start + 0.05) continue;
    const point = (pause.start + pause.end) / 2;
    if (point < windowStart || point > windowEnd) continue;
    const chunkEnd = round3(Math.min(durationSec, Math.max(start, pause.start)));
    const nextStart = round3(Math.min(durationSec, pause.end));
    if (chunkEnd - start < minChunk) continue;
    if (nextStart <= start + 0.5) continue;
    const distance = Math.abs(point - target);
    if (!best || distance < best.distance) best = { chunkEnd, nextStart, distance };
  }

  if (!best) return null;
  return { chunkEnd: best.chunkEnd, nextStart: best.nextStart };
}

function joinTouching(spans: KeptSpan[]): KeptSpan[] {
  const joined: KeptSpan[] = [];
  for (const span of spans) {
    if (!(span.originalEnd > span.originalStart)) continue;
    const last = joined[joined.length - 1];
    if (last && span.originalStart <= last.originalEnd + 0.02) {
      last.originalEnd = round3(Math.max(last.originalEnd, span.originalEnd));
      continue;
    }
    joined.push({ originalStart: span.originalStart, originalEnd: span.originalEnd });
  }
  return joined;
}
