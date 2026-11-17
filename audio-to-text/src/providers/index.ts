import type { AppConfig } from "../config.js";
import type { TranscriptionProvider } from "./types.js";

const KNOWN_PROVIDERS = ["gemini", "openai"] as const;

export async function createProvider(config: AppConfig): Promise<TranscriptionProvider> {
  switch (config.provider) {
    case "gemini": {
      if (!config.geminiApiKey) {
        throw new Error("Missing GEMINI_API_KEY. Add it to .env. It is required when LLM_PROVIDER=gemini.");
      }
      const { GeminiProvider } = await import("./gemini.js");
      return new GeminiProvider({ apiKey: config.geminiApiKey, model: config.model });
    }
    case "openai": {
      if (!config.openaiApiKey) {
        throw new Error("Missing OPENAI_API_KEY. Add it to .env. It is required when LLM_PROVIDER=openai.");
      }
      const { OpenAIProvider } = await import("./openai.js");
      return new OpenAIProvider({ apiKey: config.openaiApiKey, model: config.model });
    }
    default:
      throw new Error(
        `Unknown LLM provider "${config.provider}". Known providers: ${KNOWN_PROVIDERS.join(", ")}. Add a provider file under src/providers/ and register it in src/providers/index.ts.`,
      );
  }
}
