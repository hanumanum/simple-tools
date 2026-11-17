import type { TranscriptionContext } from "./providers/types.js";

const LANGUAGE_NAMES: Record<string, string> = {
  hy: "Armenian",
  en: "English",
  ru: "Russian",
};

export function buildTranscriptionPrompt(ctx: TranscriptionContext): string {
  const languageName = LANGUAGE_NAMES[ctx.language] ?? ctx.language;
  const lines = [
    "You are transcribing one chunk of a conversational recording.",
    `Language code: ${ctx.language} (${languageName}).`,
    "Write every utterance in the original spoken language and script. Do not translate.",
    "For Armenian (hy), use the Armenian alphabet.",
    "",
    "Return only JSON with this shape:",
    '{ "speakers": string[], "segments": { "speaker": string, "start": number, "end": number, "text": string }[] }',
    "",
    "Rules:",
    "- segments are speaking turns, in time order.",
    "- start and end are seconds from the beginning of THIS audio chunk.",
    "- speaker is a short name. Use the same name for the same voice throughout the conversation.",
    "- text is the verbatim utterance, with no speaker labels or timestamps inside it.",
    "- Skip silence and non-speech. Do not invent words you cannot hear.",
  ];

  if (ctx.speakers && ctx.speakers.length > 0) {
    lines.push(`- Known speakers, use these exact names when the voice matches: ${ctx.speakers.join(", ")}.`);
  } else {
    lines.push("- No names were provided. Label voices Speaker 1, Speaker 2, and so on, and keep those labels stable.");
  }

  if (ctx.hint?.trim()) {
    lines.push(`- Hint: ${ctx.hint.trim()}`);
  }

  if (ctx.previousSegments && ctx.previousSegments.length > 0) {
    lines.push("");
    lines.push(
      "The beginning of this chunk overlaps audio that was already transcribed. The lines below are the end of the previous chunk (times are relative to that chunk). Keep the same speaker names and do not repeat that speech:",
    );
    for (const segment of ctx.previousSegments) {
      lines.push(`- ${segment.speaker} [${segment.start.toFixed(1)}-${segment.end.toFixed(1)}]: ${segment.text}`);
    }
  }

  return lines.join("\n");
}
