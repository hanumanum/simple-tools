import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createWorkDir,
  detectSilences,
  listInputs,
  probeDuration,
  RESUME_OVERLAP_SEC,
  resolveChunkSec,
  writeChunk,
} from "./audio.js";
import { findExistingOutputs, writeOutputs, type TranscriptDocument } from "./format.js";
import { mergeChunks, unionNames, type ChunkPiece } from "./merge.js";
import type { AudioChunk, Segment, TokenUsage, TranscriptionContext, TranscriptionProvider } from "./providers/types.js";
import { describeFailure } from "./retry.js";
import { EmptyTranscriptError, PartialTranscriptError, TranscriptParseError } from "./schema.js";
import { compressedToOriginal, keptDuration, keptSpans, planChunksOnSilence, removableSilenceSec } from "./silence.js";
import { elapsedSec, formatTimestamp, round3 } from "./time.js";
import { addUsage, emptyUsage, formatTokenCounts, hasUsage } from "./usage.js";

const PREVIOUS_SEGMENT_TAIL = 4;
const PARSE_ATTEMPTS = 2;
const MIN_ADVANCE_SEC = 1;
const MIN_SPLIT_SEC = 30;

interface SavedProgress {
  sourceFile: string;
  coveredUntilSec: number;
  segments: Segment[];
  speakers: string[];
  usage?: TokenUsage;
}

export interface PipelineOptions {
  provider: TranscriptionProvider;
  language: string;
  speakers?: string[];
  hint?: string;
  chunkMinutes: number;
  outDir?: string;
  force: boolean;
  logPath: string;
}

function outputBase(input: string, outDir?: string): string {
  const stem = path.basename(input, path.extname(input));
  return path.join(outDir ?? path.dirname(input), stem);
}

async function appendLog(logPath: string, message: string): Promise<void> {
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, `${new Date().toISOString()} ${message}\n`, "utf8");
}

async function transcribeChunk(
  provider: TranscriptionProvider,
  chunk: AudioChunk,
  ctx: TranscriptionContext,
  record: (usage?: TokenUsage) => void,
  onAttempt?: () => void,
): Promise<Awaited<ReturnType<TranscriptionProvider["transcribe"]>>> {
  let lastParse: TranscriptParseError | undefined;
  for (let attempt = 0; attempt < PARSE_ATTEMPTS; attempt += 1) {
    onAttempt?.();
    try {
      const transcript = await provider.transcribe(chunk, ctx);
      record(transcript.usage);
      return transcript;
    } catch (error) {
      if (!(error instanceof TranscriptParseError)) throw error;
      record(error.usage);
      if (hasUsage(error.usage)) {
        console.log(
          `  chunk ${chunk.index + 1}/${chunk.total} response could not be parsed; tokens still counted: ${formatTokenCounts(error.usage)}`,
        );
      }
      lastParse = error;
    }
  }
  throw lastParse ?? new TranscriptParseError("Provider response failed validation.", "");
}

function printUsage(label: string, usage: TokenUsage): void {
  console.log(`  ${label}: ${formatTokenCounts(usage)}`);
  if (usage.note) console.log(`  ${usage.note}`);
}

function partialPathFor(base: string): string {
  return `${base}.partial.json`;
}

function isSegment(value: unknown): value is Segment {
  if (typeof value !== "object" || value === null) return false;
  const segment = value as Partial<Segment>;
  return (
    typeof segment.speaker === "string" &&
    segment.speaker.trim().length > 0 &&
    typeof segment.start === "number" &&
    Number.isFinite(segment.start) &&
    typeof segment.end === "number" &&
    Number.isFinite(segment.end) &&
    segment.end > segment.start &&
    typeof segment.text === "string" &&
    segment.text.trim().length > 0
  );
}

function isUsage(value: unknown): value is TokenUsage {
  if (typeof value !== "object" || value === null) return false;
  const usage = value as Partial<TokenUsage>;
  return (
    typeof usage.inputTokens === "number" &&
    typeof usage.cachedTokens === "number" &&
    typeof usage.outputTokens === "number" &&
    typeof usage.thoughtsTokens === "number" &&
    typeof usage.totalTokens === "number" &&
    (usage.costUsd === null || typeof usage.costUsd === "number")
  );
}

function loadPartial(filePath: string, sourceFile: string): SavedProgress | undefined {
  if (!fsSync.existsSync(filePath)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fsSync.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    console.log(`  ignoring unreadable progress file ${filePath}`);
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Partial<SavedProgress>;
  if (record.sourceFile !== sourceFile) {
    console.log("  ignoring progress file for a different recording");
    return undefined;
  }
  if (!Array.isArray(record.segments)) return undefined;
  const segments = record.segments.filter(isSegment).map((segment) => ({
    speaker: segment.speaker.trim(),
    start: segment.start,
    end: segment.end,
    text: segment.text.trim(),
  }));
  if (segments.length === 0) return undefined;
  const coveredUntilSec = round3(
    Math.max(
      typeof record.coveredUntilSec === "number" ? record.coveredUntilSec : 0,
      ...segments.map((segment) => segment.end),
    ),
  );
  const speakers = Array.isArray(record.speakers)
    ? record.speakers.filter((name): name is string => typeof name === "string")
    : [];
  return {
    sourceFile,
    coveredUntilSec,
    segments,
    speakers: unionNames(
      speakers,
      segments.map((segment) => segment.speaker),
    ),
    usage: isUsage(record.usage) ? record.usage : undefined,
  };
}

function savePartial(filePath: string, progress: SavedProgress): void {
  fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fsSync.writeFileSync(tmp, `${JSON.stringify(progress, null, 2)}\n`, "utf8");
  fsSync.renameSync(tmp, filePath);
}

function shiftSegments(segments: Segment[], offsetSec: number): Segment[] {
  return segments.map((segment) => ({
    ...segment,
    start: round3(segment.start + offsetSec),
    end: round3(segment.end + offsetSec),
  }));
}

function absoluteSegments(pieces: ChunkPiece[], live: Segment[]): Segment[] {
  return [...pieces.flatMap((piece) => shiftSegments(piece.transcript.segments, piece.offsetSec)), ...live];
}

function coverageEnd(pieces: ChunkPiece[], live: Segment[]): number {
  let end = 0;
  for (const piece of pieces) end = Math.max(end, piece.offsetSec + piece.durationSec);
  for (const segment of live) end = Math.max(end, segment.end);
  return round3(end);
}

function originalSegments(segments: Segment[], chunk: AudioChunk): Segment[] {
  const toOriginal = chunk.toOriginal ?? ((value: number) => value);
  return segments.map((segment) => ({
    ...segment,
    start: round3(toOriginal(segment.start)),
    end: round3(toOriginal(segment.end)),
  }));
}

function usableSegments(segments: Segment[]): Segment[] {
  return segments.filter(
    (segment) => segment.text.trim().length > 0 && Number.isFinite(segment.start) && segment.end > segment.start,
  );
}

async function transcribeOne(input: string, options: PipelineOptions, runUsage: { current: TokenUsage }): Promise<void> {
  const base = outputBase(input, options.outDir);
  const resolvedSource = path.resolve(input);
  const partialPath = partialPathFor(base);
  if (!options.force) {
    const existing = await findExistingOutputs(base);
    const first = existing[0];
    if (first) {
      throw new Error(`Output already exists: ${first}. Pass --force to overwrite.`);
    }
  } else {
    fsSync.rmSync(partialPath, { force: true });
  }

  const started = Date.now();
  const workDir = await createWorkDir();
  let fileUsage = emptyUsage();

  try {
    const chunkSec = resolveChunkSec(options.chunkMinutes, options.provider.maxChunkSec);
    const durationSec = await probeDuration(input);
    const label = path.basename(input);
    console.log(`${label} — scanning for pauses...`);
    const silences = await detectSilences(input, durationSec);
    const removable = removableSilenceSec(silences);
    console.log(
      removable >= 0.5
        ? `${label} — ${silences.length} pauses, about ${removable.toFixed(0)}s will be shortened`
        : `${label} — no long pauses`,
    );
    const saved = options.force ? undefined : loadPartial(partialPath, resolvedSource);
    const pieces: ChunkPiece[] = [];
    let speakers = options.speakers?.filter((name) => name.trim()) ?? [];
    let previous: Segment[] | undefined;

    if (saved) {
      if (hasUsage(saved.usage)) {
        fileUsage = saved.usage;
        runUsage.current = addUsage(runUsage.current, saved.usage);
      }
      speakers = unionNames(speakers, saved.speakers);
      pieces.push({
        offsetSec: 0,
        durationSec: saved.coveredUntilSec,
        transcript: { speakers: saved.speakers, segments: saved.segments },
      });
      previous = saved.segments.slice(-PREVIOUS_SEGMENT_TAIL);
      console.log(
        `${label} — resuming from ${formatTimestamp(saved.coveredUntilSec)} (${saved.segments.length} turns already saved)`,
      );
    }

    const resumeStart = saved ? round3(Math.max(0, saved.coveredUntilSec - RESUME_OVERLAP_SEC)) : 0;
    let plans = planChunksOnSilence(durationSec, chunkSec, silences, resumeStart);
    const from = resumeStart > 0 ? ` from ${formatTimestamp(resumeStart)}` : "";
    console.log(
      `${label} — ${durationSec.toFixed(1)}s, ${plans.length} chunk${plans.length === 1 ? "" : "s"} of up to ${Math.round(chunkSec)}s${from}`,
    );

    const record = (usage?: TokenUsage): void => {
      if (!hasUsage(usage)) return;
      fileUsage = addUsage(fileUsage, usage);
      runUsage.current = addUsage(runUsage.current, usage);
    };
    const rawPath = `${base}.raw.txt`;
    await fs.rm(rawPath, { force: true });

    let live: Segment[] = [];
    const persist = (): void => {
      const segments = absoluteSegments(pieces, live);
      if (segments.length === 0) return;
      try {
        savePartial(partialPath, {
          sourceFile: resolvedSource,
          coveredUntilSec: coverageEnd(pieces, live),
          segments,
          speakers: unionNames(
            speakers,
            segments.map((segment) => segment.speaker),
          ),
          usage: hasUsage(fileUsage) ? fileUsage : undefined,
        });
      } catch (error) {
        console.log(`  could not save progress: ${describeFailure(error)}`);
      }
    };

    for (let index = 0; index < plans.length; index += 1) {
      const plan = plans[index];
      if (!plan) continue;
      const destination = path.join(workDir, `chunk-${String(index).padStart(3, "0")}.mp3`);
      const preview = keptSpans(plan.start, round3(plan.start + plan.duration), silences);
      const removed = round3(Math.max(0, plan.duration - keptDuration(preview)));
      const silenceNote = removed >= 0.5 ? `, leaving out ${removed.toFixed(0)}s of silence` : "";
      console.log(
        `  cutting chunk ${index + 1}/${plans.length} (${formatTimestamp(plan.start)}–${formatTimestamp(plan.start + plan.duration)}${silenceNote})`,
      );
      const spans = await writeChunk(input, plan, destination, silences);
      const chunk: AudioChunk = {
        path: destination,
        index,
        total: plans.length,
        offsetSec: plan.start,
        durationSec: plan.duration,
        toOriginal: (compressedSec) => compressedToOriginal(compressedSec, spans, plan.start),
      };
      const ctx: TranscriptionContext = {
        language: options.language,
        speakers: speakers.length > 0 ? speakers : undefined,
        hint: options.hint,
        previousSegments: previous && previous.length > 0 ? previous.slice(-PREVIOUS_SEGMENT_TAIL) : undefined,
        onSegment: (segment) => {
          const [placed] = originalSegments([segment], chunk);
          if (!placed) return;
          live.push({
            speaker: placed.speaker,
            start: round3(placed.start + chunk.offsetSec),
            end: round3(placed.end + chunk.offsetSec),
            text: placed.text,
          });
          persist();
        },
      };
      console.log(`  chunk ${chunk.index + 1}/${chunk.total}`);
      const chunkStarted = Date.now();
      let transcript;
      try {
        transcript = await transcribeChunk(options.provider, chunk, ctx, record, () => {
          live = [];
        });
      } catch (error) {
        if (error instanceof EmptyTranscriptError) {
          record(error.usage);
          const shorter = round3(plan.duration / 2);
          const rest =
            plan.duration > MIN_SPLIT_SEC
              ? planChunksOnSilence(durationSec, shorter, silences, plan.start)
              : [];
          const nextPlan = rest[0];
          if (!nextPlan || nextPlan.duration >= plan.duration - 1) {
            throw new Error(
              `${error.message} The piece at ${formatTimestamp(plan.start)} is ${plan.duration.toFixed(0)}s and was not split.`,
            );
          }
          console.log(
            `  ${error.message} Splitting ${formatTimestamp(plan.start)} (${plan.duration.toFixed(0)}s) into shorter pieces.`,
          );
          plans = [...plans.slice(0, index), ...rest];
          index -= 1;
          continue;
        }
        if (error instanceof PartialTranscriptError) {
          record(error.usage);
          const kept = usableSegments(originalSegments(error.segments, chunk));
          if (kept.length === 0) throw error;
          const lastRel = Math.max(...kept.map((segment) => segment.end));
          const lastAbs = round3(plan.start + lastRel);
          const next = round3(Math.max(plan.start, lastAbs - RESUME_OVERLAP_SEC));
          live = [];
          speakers = unionNames(
            speakers,
            kept.map((segment) => segment.speaker),
          );
          pieces.push({
            offsetSec: plan.start,
            durationSec: round3(lastRel),
            transcript: {
              speakers: unionNames(
                undefined,
                kept.map((segment) => segment.speaker),
              ),
              segments: kept,
              usage: error.usage,
            },
          });
          previous = kept;
          persist();
          const rest = planChunksOnSilence(durationSec, chunkSec, silences, next);
          const nextPlan = rest[0];
          if (rest.length === 0) {
            console.log(
              `  stopped at ${formatTimestamp(lastAbs)} (${describeFailure(error)}). That covers the rest of the file.`,
            );
            break;
          }
          if (next - plan.start < MIN_ADVANCE_SEC || !nextPlan || nextPlan.start <= plan.start + 0.5) {
            throw new Error(
              `${describeFailure(error)} Progress is saved in ${partialPath}. Run the same command again to continue from ${formatTimestamp(lastAbs)}.`,
            );
          }
          console.log(
            `  stopped at ${formatTimestamp(lastAbs)} (${describeFailure(error)}). Continuing from ${formatTimestamp(next)}.`,
          );
          plans = [...plans.slice(0, index + 1), ...rest];
          continue;
        }
        if (error instanceof TranscriptParseError) {
          await fs.mkdir(path.dirname(base), { recursive: true });
          await fs.appendFile(rawPath, `--- chunk ${chunk.index + 1}/${chunk.total} ---\n${error.raw}\n`, "utf8");
          throw new Error(
            `Could not parse the transcript for chunk ${chunk.index + 1}/${chunk.total}. Raw response saved to ${rawPath}.`,
          );
        }
        throw error;
      }
      live = [];
      const usageLabel = hasUsage(transcript.usage) ? `, ${formatTokenCounts(transcript.usage)}` : "";
      console.log(
        `  chunk ${chunk.index + 1}/${chunk.total} done in ${elapsedSec(chunkStarted)}s (elapsed ${elapsedSec(started)}s)${usageLabel}`,
      );
      const placed = { ...transcript, segments: originalSegments(transcript.segments, chunk) };
      speakers = unionNames(speakers, placed.speakers);
      previous = placed.segments;
      pieces.push({ offsetSec: chunk.offsetSec, durationSec: chunk.durationSec, transcript: placed });
      persist();
    }

    if (pieces.length === 0) {
      throw new Error(`No transcript was produced for ${input}.`);
    }

    const merged = mergeChunks(pieces);
    const doc: TranscriptDocument = {
      sourceFile: input,
      provider: options.provider.name,
      model: options.provider.model,
      durationSec: round3(durationSec),
      createdAt: new Date().toISOString(),
      language: options.language,
      speakers: unionNames(speakers, merged.speakers),
      segments: merged.segments,
      usage: hasUsage(fileUsage) ? fileUsage : undefined,
    };
    const written = await writeOutputs(base, doc, options.force);
    await fs.rm(rawPath, { force: true });
    await fs.rm(partialPath, { force: true });
    console.log(`  wrote ${written.mdPath} and ${written.jsonPath}`);
    if (hasUsage(fileUsage)) printUsage("tokens", fileUsage);
  } catch (error) {
    if (hasUsage(fileUsage)) printUsage("tokens before failure", fileUsage);
    throw error;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

export async function transcribePaths(input: string, options: PipelineOptions): Promise<number> {
  let failed = 0;
  const runUsage = { current: emptyUsage() };
  try {
    const files = await listInputs(input);
    for (const file of files) {
      try {
        await transcribeOne(file, options, runUsage);
      } catch (error) {
        failed += 1;
        const message = describeFailure(error);
        console.error(`Failed: ${file}: ${message}`);
        await appendLog(options.logPath, `ERROR ${file}: ${message}`);
      }
    }
    if (files.length > 1 && hasUsage(runUsage.current)) {
      console.log(`Run tokens: ${formatTokenCounts(runUsage.current)}`);
    }
  } finally {
    await options.provider.dispose?.();
  }
  return failed;
}
