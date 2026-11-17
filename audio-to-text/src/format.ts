import fs from "node:fs/promises";
import path from "node:path";
import type { Segment, TokenUsage } from "./providers/types.js";
import { formatTimestamp } from "./time.js";
import { formatTokenCounts, hasUsage } from "./usage.js";

export interface TranscriptDocument {
  sourceFile: string;
  provider: string;
  model: string;
  durationSec: number;
  createdAt: string;
  language: string;
  speakers: string[];
  segments: Segment[];
  usage?: TokenUsage;
}

export function renderMarkdown(name: string, doc: TranscriptDocument): string {
  const speakers = doc.speakers.length > 0 ? doc.speakers.join(", ") : "unknown";
  const date = doc.createdAt.slice(0, 10);
  const lines = [
    `# ${name}`,
    `Date: ${date} | Duration: ${formatTimestamp(doc.durationSec)} | Speakers: ${speakers} | Model: ${doc.provider}/${doc.model}`,
  ];
  if (hasUsage(doc.usage)) {
    lines.push(`Tokens: ${formatTokenCounts(doc.usage)}`);
  }
  lines.push(
    "",
    ...doc.segments.map(
      (segment) =>
        `**[${formatTimestamp(segment.start)}] ${segment.speaker}:** ${segment.text.replace(/\s+/g, " ").trim()}`,
    ),
    "",
  );
  return lines.join("\n");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function outputPaths(basePath: string): { jsonPath: string; mdPath: string } {
  return { jsonPath: `${basePath}.json`, mdPath: `${basePath}.md` };
}

export async function findExistingOutputs(basePath: string): Promise<string[]> {
  const paths = outputPaths(basePath);
  const found: string[] = [];
  for (const filePath of [paths.jsonPath, paths.mdPath]) {
    if (await exists(filePath)) found.push(filePath);
  }
  return found;
}

export async function writeOutputs(basePath: string, doc: TranscriptDocument, force: boolean): Promise<{
  jsonPath: string;
  mdPath: string;
}> {
  const { jsonPath, mdPath } = outputPaths(basePath);
  if (!force) {
    const existing = await findExistingOutputs(basePath);
    const first = existing[0];
    if (first) {
      throw new Error(`Output already exists: ${first}. Pass --force to overwrite.`);
    }
  }

  await fs.mkdir(path.dirname(basePath), { recursive: true });
  const name = path.basename(basePath);
  await fs.writeFile(jsonPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  await fs.writeFile(mdPath, renderMarkdown(name, doc), "utf8");
  return { jsonPath, mdPath };
}
