import {
  CODEX_CLIENT_VERSION,
  codexChatGptHeaders,
  readCodexCreds,
} from "./codexAuth.js";
import type { ProviderModel } from "./modelProvider.js";

export const CODEX_FALLBACK_MODELS: ProviderModel[] = [
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    provider: "openai",
    contextWindow: 272_000,
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    provider: "openai",
    contextWindow: 272_000,
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    provider: "openai",
    contextWindow: 272_000,
  },
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    provider: "openai",
    contextWindow: 272_000,
  },
  {
    id: "gpt-5.4",
    label: "GPT-5.4",
    provider: "openai",
    contextWindow: 272_000,
  },
  {
    id: "gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    provider: "openai",
    contextWindow: 272_000,
  },
];

export interface CodexModelsResponse {
  models: ProviderModel[];
  fallback: boolean;
}

export async function fetchCodexModels(): Promise<CodexModelsResponse> {
  try {
    const creds = await readCodexCreds();
    if (creds.kind === "chatgpt") {
      const response = await fetch(
        `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CLIENT_VERSION}`,
        { headers: codexChatGptHeaders(creds) },
      );
      if (!response.ok) {
        throw new Error(`Codex models HTTP ${response.status}`);
      }
      const data = (await response.json()) as {
        models?: Array<{
          slug?: string;
          display_name?: string;
          context_window?: number | null;
          max_context_window?: number | null;
          visibility?: string;
          priority?: number;
        }>;
      };
      const models = (data.models ?? [])
        .filter(
          (model) =>
            model.slug &&
            model.visibility === "list",
        )
        .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
        .map((model) => ({
          id: model.slug!,
          label: model.display_name || model.slug!,
          provider: "openai" as const,
          contextWindow:
            model.context_window ?? model.max_context_window ?? undefined,
        }));
      if (models.length > 0) return { models, fallback: false };
    } else {
      const response = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${creds.apiKey}` },
      });
      if (!response.ok) {
        throw new Error(`OpenAI models HTTP ${response.status}`);
      }
      const data = (await response.json()) as {
        data?: Array<{ id?: string; created?: number }>;
      };
      const models = (data.data ?? [])
        .filter(
          (model): model is { id: string; created?: number } =>
            typeof model.id === "string" &&
            /^gpt-5(?:\.|-)/.test(model.id) &&
            !/audio|image|realtime|transcribe|search/i.test(model.id),
        )
        .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
        .map((model) => ({
          id: model.id,
          label: model.id
            .split("-")
            .map((part) =>
              part.toLowerCase() === "gpt"
                ? "GPT"
                : part.charAt(0).toUpperCase() + part.slice(1),
            )
            .join(" "),
          provider: "openai" as const,
        }));
      if (models.length > 0) return { models, fallback: false };
    }
  } catch {
    // The picker remains useful while signed out or temporarily offline.
  }

  return { models: CODEX_FALLBACK_MODELS, fallback: true };
}
