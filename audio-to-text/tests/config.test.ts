import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { createProvider } from "../src/providers/index.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = path.join(packageRoot, "node_modules", ".bin", "tsx");

function runCli(env: Record<string, string>): { status: number | null; output: string } {
  const result = spawnSync(tsxBin, ["src/cli.ts", "missing.mp3"], {
    cwd: packageRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}

describe("parseConfig", () => {
  it("defaults to Armenian and a 5 minute chunk, and requires the selected key", () => {
    const config = parseConfig({ GEMINI_API_KEY: "test-key" });
    expect(config.provider).toBe("gemini");
    expect(config.language).toBe("hy");
    expect(config.chunkMinutes).toBe(5);
    expect(config.model).toBeUndefined();
  });

  it("lets CLI flags override the provider and model", () => {
    const config = parseConfig(
      { LLM_PROVIDER: "gemini", GEMINI_API_KEY: "g", OPENAI_API_KEY: "o", LLM_MODEL: "from-env" },
      { provider: "openai", model: "from-flag" },
    );
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("from-flag");
  });

  it("rejects a missing key for the selected provider", () => {
    expect(() => parseConfig({ LLM_PROVIDER: "gemini" })).toThrow(/Missing GEMINI_API_KEY/);
    expect(() => parseConfig({ LLM_PROVIDER: "gemini", GEMINI_API_KEY: "   " })).toThrow(/Missing GEMINI_API_KEY/);
    expect(() => parseConfig({ LLM_PROVIDER: "openai" })).toThrow(/Missing OPENAI_API_KEY/);
  });

  it("rejects a non-positive chunk length", () => {
    expect(() => parseConfig({ GEMINI_API_KEY: "x", CHUNK_MINUTES: "0" })).toThrow(/Invalid configuration/);
  });
});

describe("createProvider", () => {
  it("fails clearly when the OpenAI stub is selected", async () => {
    const config = parseConfig({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-test" });
    await expect(createProvider(config)).rejects.toThrow(/not implemented/);
  });

  it("names unknown providers", async () => {
    const config = parseConfig({ LLM_PROVIDER: "whisper" });
    await expect(createProvider(config)).rejects.toThrow(/Unknown LLM provider "whisper"/);
  });
});

describe("cli", () => {
  it("prints a missing-key error instead of crashing", () => {
    const result = runCli({ LLM_PROVIDER: "gemini", GEMINI_API_KEY: "", OPENAI_API_KEY: "" });
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/Missing GEMINI_API_KEY/);
    expect(result.output).not.toMatch(/Unhandled/);
  });

  it("prints the OpenAI not-implemented error instead of crashing", () => {
    const result = runCli({
      LLM_PROVIDER: "openai",
      OPENAI_API_KEY: "sk-test",
      GEMINI_API_KEY: "",
    });
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/not implemented/);
    expect(result.output).not.toMatch(/Unhandled|TypeError/);
  });
});
