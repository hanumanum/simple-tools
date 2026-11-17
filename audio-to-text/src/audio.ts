import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AudioChunk } from "./providers/types.js";
import { formatTimestamp, round3 } from "./time.js";

const execFileAsync = promisify(execFile);

export const SUPPORTED_EXTENSIONS = [".mp3", ".m4a", ".wav", ".ogg", ".flac", ".webm"] as const;
export const OVERLAP_SEC = 10;
/** How far to rewind when a request dies after some turns have already arrived. */
export const RESUME_OVERLAP_SEC = 2;

const extensionSet = new Set<string>(SUPPORTED_EXTENSIONS);

export interface ChunkPlan {
  start: number;
  duration: number;
}

export function resolveChunkSec(chunkMinutes: number, maxChunkSec?: number): number {
  const requested = chunkMinutes * 60;
  if (maxChunkSec === undefined) return requested;
  return Math.min(requested, maxChunkSec);
}

export function planChunks(
  durationSec: number,
  chunkSec: number,
  overlapSec = OVERLAP_SEC,
  startSec = 0,
): ChunkPlan[] {
  if (!(durationSec > 0)) throw new Error("Audio duration must be greater than zero.");
  if (!(chunkSec > 0)) throw new Error("Chunk length must be greater than zero.");

  const origin = round3(Math.min(Math.max(0, startSec), durationSec));
  if (origin >= durationSec - 0.05) return [];

  const size = Math.min(chunkSec, durationSec - origin);
  const overlap = Math.min(Math.max(overlapSec, 0), size / 2);
  const step = size - overlap;
  if (!(step > 0)) throw new Error("Chunk step must be greater than zero.");

  const plans: ChunkPlan[] = [];
  const limit = Math.ceil((durationSec - origin) / step) + 2;
  for (let index = 0; index < limit; index += 1) {
    const start = round3(origin + index * step);
    if (start >= durationSec - 0.05) break;
    const duration = round3(Math.min(size, durationSec - start));
    if (duration <= 0.05) break;
    plans.push({ start, duration });
    if (start + size >= durationSec - 0.05) break;
  }

  if (plans.length === 0 && origin === 0) plans.push({ start: 0, duration: round3(durationSec) });
  return plans;
}

export async function listInputs(input: string): Promise<string[]> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(input);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Input not found: ${input}`);
    }
    throw error;
  }

  if (stat.isDirectory()) {
    const names = await fs.readdir(input);
    const files = names
      .filter((name) => extensionSet.has(path.extname(name).toLowerCase()))
      .map((name) => path.join(input, name))
      .sort((a, b) => a.localeCompare(b));
    if (files.length === 0) {
      throw new Error(
        `No supported audio files in ${input}. Supported extensions: ${SUPPORTED_EXTENSIONS.join(", ")}`,
      );
    }
    return files;
  }

  if (!stat.isFile()) throw new Error(`Not a file or directory: ${input}`);
  const extension = path.extname(input).toLowerCase();
  if (!extensionSet.has(extension)) {
    throw new Error(`Unsupported audio type "${extension}". Supported extensions: ${SUPPORTED_EXTENSIONS.join(", ")}`);
  }
  return [input];
}

async function runTool(command: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return String(stdout);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string | Buffer };
    if (failure.code === "ENOENT") {
      throw new Error(`${command} was not found on PATH. Install ffmpeg (it provides ${command}).`);
    }
    const stderr =
      typeof failure.stderr === "string" ? failure.stderr : (failure.stderr?.toString("utf8") ?? "");
    const detail = stderr.trim() || failure.message;
    throw new Error(`${command} failed: ${detail}`);
  }
}

export async function probeDuration(filePath: string): Promise<number> {
  const stdout = await runTool("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "json",
    filePath,
  ]);
  let duration = Number.NaN;
  try {
    const parsed = JSON.parse(stdout) as { format?: { duration?: string } };
    duration = Number(parsed.format?.duration);
  } catch {
    duration = Number.NaN;
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Could not read a positive duration from ${filePath}`);
  }
  return round3(duration);
}

async function cutChunk(source: string, plan: ChunkPlan, destination: string): Promise<void> {
  await runTool("ffmpeg", [
    "-y",
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    plan.start.toFixed(3),
    "-t",
    plan.duration.toFixed(3),
    "-i",
    source,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "libmp3lame",
    "-q:a",
    "4",
    destination,
  ]);
}

export async function writeChunk(source: string, plan: ChunkPlan, destination: string): Promise<void> {
  await cutChunk(source, plan, destination);
}

export async function createWorkDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "audio-to-text-"));
}

export async function buildChunks(
  source: string,
  chunkSec: number,
  workDir: string,
  onStatus?: (message: string) => void,
): Promise<{
  durationSec: number;
  chunks: AudioChunk[];
}> {
  const durationSec = await probeDuration(source);
  const plans = planChunks(durationSec, chunkSec);
  const chunks: AudioChunk[] = [];

  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index];
    if (!plan) continue;
    const destination = path.join(workDir, `chunk-${String(index).padStart(3, "0")}.mp3`);
    onStatus?.(
      `cutting chunk ${index + 1}/${plans.length} (${formatTimestamp(plan.start)}–${formatTimestamp(plan.start + plan.duration)})`,
    );
    await cutChunk(source, plan, destination);
    chunks.push({
      path: destination,
      index,
      total: plans.length,
      offsetSec: plan.start,
      durationSec: plan.duration,
    });
  }

  return { durationSec, chunks };
}
