export interface StreamSegment {
  speaker: string;
  start: number;
  end: number;
  text: string;
}

/**
 * Pull every finished segment object out of a partial JSON transcript.
 * An object that is still being written is left out until its closing brace arrives.
 */
export function completeSegments(buffer: string): StreamSegment[] {
  const marker = buffer.indexOf('"segments"');
  if (marker < 0) return [];
  const arrayStart = buffer.indexOf("[", marker);
  if (arrayStart < 0) return [];

  const found: StreamSegment[] = [];
  let index = arrayStart + 1;
  while (index < buffer.length) {
    const char = buffer[index];
    if (char === undefined) break;
    if (char === "]" ) break;
    if (char === "{" ) {
      const end = closingBrace(buffer, index);
      if (end < 0) break;
      const segment = parseSegment(buffer.slice(index, end + 1));
      if (segment) found.push(segment);
      index = end + 1;
      continue;
    }
    index += 1;
  }
  return found;
}

function closingBrace(buffer: string, open: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = open; index < buffer.length; index += 1) {
    const char = buffer[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function parseSegment(slice: string): StreamSegment | null {
  try {
    const value = JSON.parse(slice) as Partial<StreamSegment>;
    if (typeof value.speaker !== "string" || value.speaker.trim().length === 0) return null;
    if (typeof value.text !== "string" || value.text.trim().length === 0) return null;
    if (typeof value.start !== "number" || typeof value.end !== "number") return null;
    return {
      speaker: value.speaker.trim(),
      start: value.start,
      end: value.end,
      text: value.text.trim(),
    };
  } catch {
    return null;
  }
}
