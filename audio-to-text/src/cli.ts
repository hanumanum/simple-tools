import { Command } from "commander";
import path from "node:path";
import { loadEnv, parseConfig } from "./config.js";
import { transcribePaths } from "./pipeline.js";
import { createProvider } from "./providers/index.js";

interface CliOptions {
  speakers?: string;
  hint?: string;
  provider?: string;
  model?: string;
  out?: string;
  force?: boolean;
}

async function main(): Promise<void> {
  loadEnv();

  const program = new Command();
  program
    .name("transcribe")
    .description("Transcribe conversational audio into a speaker-labeled script.")
    .argument("<input>", "audio file or a directory of audio files")
    .option("--speakers <names>", 'comma-separated speaker names, for example "Artak, Anna"')
    .option("--hint <text>", "free-text hint about who is speaking")
    .option("--provider <name>", "override LLM_PROVIDER")
    .option("--model <name>", "override LLM_MODEL")
    .option("--out <dir>", "directory for the .json and .md transcripts")
    .option("--force", "overwrite existing transcripts and discard saved progress", false)
    .exitOverride()
    .showHelpAfterError(false);

  program.action(async (input: string, opts: CliOptions) => {
    const config = parseConfig(process.env, {
      provider: opts.provider,
      model: opts.model,
    });
    const provider = await createProvider(config);
    const speakers = opts.speakers
      ?.split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    const failed = await transcribePaths(path.resolve(input), {
      provider,
      language: config.language,
      speakers,
      hint: opts.hint?.trim() || undefined,
      chunkMinutes: config.chunkMinutes,
      outDir: opts.out ? path.resolve(opts.out) : undefined,
      force: Boolean(opts.force),
      logPath: path.resolve("transcribe.log"),
    });
    if (failed > 0) process.exitCode = 1;
  });

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
