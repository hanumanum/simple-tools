# audio-to-text

Local command-line tool that turns a conversational audio file into a speaker-labeled script. It shells out to `ffmpeg`, sends each chunk to an audio-capable LLM, and writes a Markdown script plus JSON next to the file. There is no login, database, or UI.

Gemini is the first provider. Switching models is a new provider file and one environment variable. The chunking, merging, and writers do not import a vendor SDK.

## Requirements

- Node.js 20 or newer
- `ffmpeg` and `ffprobe` on `PATH`
- An API key for the provider you select

## Setup

```bash
cd audio-to-text
npm install
cp .env.example .env
```

Put your key in `.env`:

```
LLM_PROVIDER=gemini
LLM_MODEL=
CHUNK_MINUTES=5
LANGUAGE=hy

GEMINI_API_KEY=your-key
OPENAI_API_KEY=
```

`LLM_MODEL` is optional. Gemini defaults to `gemini-4-hydrogen`, the current Gemini model that accepts audio (along with text, image, and video). Only the key for `LLM_PROVIDER` is required.

## Usage

```bash
npm run transcribe -- path/to/audio.m4a
npm run transcribe -- audio.m4a --speakers "Artak, Anna" --hint "Artak speaks first"
npm run transcribe -- path/to/folder/
npm run transcribe -- audio.m4a --provider gemini --model gemini-4-hydrogen --out ./transcripts --force
```

Supported inputs: mp3, m4a, wav, ogg, flac, webm. Other formats are converted to mp3 while chunking. A directory is read one level deep and transcribed in filename order (`part2` before `part10`). Non-audio files are skipped.

`--provider` and `--model` override `.env`.

Chunk length is `CHUNK_MINUTES` (default 5). Five minutes is short enough that a request usually finishes before the connection drops; raise it when a model stays reliable on longer audio. The length is also capped by the provider's own limit. A chunk ends on a pause when one falls near that length, so speech is not cut in half. If a stretch has no pause, chunks overlap by about 10 seconds and the duplicate is dropped. Pauses longer than about 2 seconds are shortened to a short breath before the audio is sent. Printed times stay on the original recording. Speaker names from the previous chunk are passed into the next request so labels stay stable.

If a request dies after some lines have already arrived, those lines are kept and the next piece starts about two seconds before the last finished turn. The same progress is written to `<name>.partial.json` as each turn arrives, so stopping the command and running it again continues from there. `--force` deletes that file and starts over.

## Output

For an input named `interview.m4a`, the tool writes `interview.json` and `interview.md` beside the file, or into `--out DIR`:

```
# interview
Date: 2026-11-17 | Duration: 00:40:12 | Speakers: Artak, Anna | Model: gemini/gemini-4-hydrogen

**[00:00:03] Artak:** ...
**[00:00:12] Anna:** ...
```

The JSON file has the merged segments plus `sourceFile`, `provider`, `model`, `durationSec`, `createdAt`, and `usage` (token counts and an estimated USD cost). Existing files are left alone unless you pass `--force`.

Each finished chunk prints its token counts. The file total is repeated at the end and stored in both outputs:

```
Tokens: 186,400 in, 2,150 out (80 thinking), 188,630 total, est. $0.2957
Estimated from the paid-tier list price. On the free tier this model is $0 until that quota is used.
```

The estimate uses Google's published paid-tier rates for the model that ran. Audio tokens are part of the input count (about 32 tokens per second). Thinking tokens are billed as output. Cached input, when the API reports it, uses the lower cache rate. A model with no entry in the price table still reports tokens, with the cost left blank. A response that fails to parse is still counted, because those tokens were already billed. A directory of files also prints a run total.

While a chunk is in progress the tool prints each step: cutting the audio, uploading it, and waiting for Gemini to accept the file. Transcript lines then appear as each speaking turn finishes, with times from the start of the original file. Until the first line arrives, a heartbeat prints every 15 seconds. Finished lines are also saved to `<name>.partial.json`, so a dropped connection continues from the last one. A retry after a 503 or 429 says how long it will wait. Failures are appended to `transcribe.log`. If a response cannot be parsed, it is retried once and the raw text is saved to `<name>.raw.txt`. An empty response is split into a shorter piece and tried again. The process exits with a non-zero status if any file failed. Uploaded provider files and the temp chunks are deleted when the run finishes.

## Scripts

```bash
npm run transcribe -- <input>
npm test
npm run build
```

`npm run build` compiles `src/` to `dist/` with strict TypeScript.

## Adding a new provider

1. Add `src/providers/<name>.ts` that implements `TranscriptionProvider` from `src/providers/types.ts`.
2. Keep the vendor SDK import inside that file. Upload, retries, and response parsing stay there. Return a `ChunkTranscript` checked with `parseChunkTranscript` from `src/schema.ts`.
3. Use `buildTranscriptionPrompt` from `src/prompts.ts`. The default wording is provider-agnostic. If the API has no structured-output mode, the prompt already asks for JSON.
4. Use `withRetry` from `src/retry.ts` for HTTP 429 and 5xx.
5. Put token counts and a list-price estimate on `ChunkTranscript.usage`. The pipeline adds them up and prints them.
6. Register the name in `createProvider` in `src/providers/index.ts`.
7. If it needs a key, require that variable in `src/config.ts` only when this provider is selected.
8. Set `LLM_PROVIDER=<name>` in `.env`.

`src/providers/openai.ts` is a stub of that pattern. Selecting it fails with a clear "not implemented" message.

## Layout

```
src/
  cli.ts
  config.ts
  pipeline.ts
  audio.ts
  merge.ts
  format.ts
  prompts.ts
  schema.ts
  retry.ts
  time.ts
  usage.ts
  providers/
    types.ts
    index.ts
    gemini.ts
    openai.ts
tests/
```
