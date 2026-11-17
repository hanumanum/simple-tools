import { config as loadDotenv } from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadEnv(): void {
  const cwdEnv = path.resolve(process.cwd(), ".env");
  const packageEnv = path.join(packageRoot, ".env");
  if (fs.existsSync(cwdEnv)) loadDotenv({ path: cwdEnv, quiet: true });
  if (cwdEnv !== packageEnv && fs.existsSync(packageEnv)) loadDotenv({ path: packageEnv, quiet: true });
}

const envSchema = z.object({
  LLM_PROVIDER: z.string().trim().min(1),
  LLM_MODEL: z.string().trim().min(1).optional(),
  CHUNK_MINUTES: z.coerce.number().positive(),
  LANGUAGE: z.string().trim().min(1),
  GEMINI_API_KEY: z.string().trim().min(1).optional(),
  OPENAI_API_KEY: z.string().trim().min(1).optional(),
});

const PROVIDER_KEYS = {
  gemini: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY",
} as const;

export interface AppConfig {
  provider: string;
  model?: string;
  chunkMinutes: number;
  language: string;
  geminiApiKey?: string;
  openaiApiKey?: string;
}

export interface ConfigOverrides {
  provider?: string;
  model?: string;
}

function blankToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function parseConfig(env: Record<string, string | undefined>, overrides: ConfigOverrides = {}): AppConfig {
  const parsed = envSchema.safeParse({
    LLM_PROVIDER: blankToUndefined(env.LLM_PROVIDER) ?? "gemini",
    LLM_MODEL: blankToUndefined(env.LLM_MODEL),
    CHUNK_MINUTES: blankToUndefined(env.CHUNK_MINUTES) ?? "5",
    LANGUAGE: blankToUndefined(env.LANGUAGE) ?? "hy",
    GEMINI_API_KEY: blankToUndefined(env.GEMINI_API_KEY),
    OPENAI_API_KEY: blankToUndefined(env.OPENAI_API_KEY),
  });

  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid configuration: ${detail}`);
  }

  const provider = (overrides.provider?.trim() || parsed.data.LLM_PROVIDER).toLowerCase();
  const model = overrides.model?.trim() || parsed.data.LLM_MODEL;
  const keyName = PROVIDER_KEYS[provider as keyof typeof PROVIDER_KEYS];
  if (keyName && !parsed.data[keyName]) {
    throw new Error(`Missing ${keyName}. Add it to .env. It is required when LLM_PROVIDER=${provider}.`);
  }

  return {
    provider,
    model,
    chunkMinutes: parsed.data.CHUNK_MINUTES,
    language: parsed.data.LANGUAGE,
    geminiApiKey: parsed.data.GEMINI_API_KEY,
    openaiApiKey: parsed.data.OPENAI_API_KEY,
  };
}
