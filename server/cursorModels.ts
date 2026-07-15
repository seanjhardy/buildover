/**
 * Lists models available on the signed-in Cursor account.
 */
import { readCursorCreds } from "./cursorAuth.js";
import {
  toCursorModelId,
  type ProviderModel,
} from "./modelProvider.js";

interface AvailableModel {
  name?: string;
  clientDisplayName?: string;
  serverModelName?: string;
  supportsAgent?: boolean;
  supportsMaxMode?: boolean;
  idAliases?: string[];
  tooltipData?: { markdownContent?: string };
}

/** Curated fallback when the live catalog can't be fetched. */
export const CURSOR_FALLBACK_MODELS: ProviderModel[] = [
  { id: toCursorModelId("default"), label: "Auto", provider: "cursor", contextWindow: 200_000 },
  { id: toCursorModelId("composer-2.5"), label: "Composer 2.5", provider: "cursor", contextWindow: 200_000 },
  { id: toCursorModelId("composer-2.5-fast"), label: "Composer 2.5 Fast", provider: "cursor", contextWindow: 200_000 },
  { id: toCursorModelId("grok-4.5-xhigh"), label: "Grok 4.5", provider: "cursor", contextWindow: 200_000 },
  { id: toCursorModelId("claude-opus-4-8-thinking-high"), label: "Opus 4.8 Thinking", provider: "cursor", contextWindow: 1_000_000 },
  { id: toCursorModelId("claude-4.6-sonnet-medium-thinking"), label: "Sonnet 4.6 Thinking", provider: "cursor", contextWindow: 200_000 },
  { id: toCursorModelId("gpt-5.3-codex"), label: "Codex 5.3", provider: "cursor", contextWindow: 200_000 },
];

function labelFor(m: AvailableModel): string {
  const fromTooltip = m.tooltipData?.markdownContent?.match(/\*\*([^*]+)\*\*/)?.[1];
  if (fromTooltip) return fromTooltip.trim();
  const name = m.clientDisplayName || m.serverModelName || m.name || "unknown";
  if (name === "default") return "Auto";
  return name
    .replace(/^claude-/, "Claude ")
    .replace(/^gpt-/, "GPT ")
    .replace(/^composer-/, "Composer ")
    .replace(/^grok-/, "Grok ")
    .replace(/-/g, " ");
}

function contextWindowFor(name: string): number {
  if (/opus|1m|sol-xhigh|sol-high/i.test(name)) return 1_000_000;
  return 200_000;
}

/** Prefer a compact, useful subset for the picker (full catalog is 100+). */
function isPreferredModel(name: string): boolean {
  if (name === "default") return true;
  if (/^composer-2\.5(-fast)?$/.test(name)) return true;
  if (/^grok-4\.5(-fast)?-xhigh$/.test(name)) return true;
  // One good variant per major family rather than every effort/fast combo.
  const preferred = new Set([
    "claude-opus-4-8-thinking-high",
    "claude-opus-4-8-thinking-high-fast",
    "claude-4.6-sonnet-medium-thinking",
    "claude-4.6-opus-high-thinking",
    "claude-sonnet-5-thinking-high",
    "claude-4.5-sonnet-thinking",
    "claude-4.5-haiku-thinking",
    "gpt-5.3-codex",
    "gpt-5.3-codex-high",
    "gpt-5.2",
    "gpt-5.2-high",
    "gpt-5.6-sol-high",
    "gemini-3.1-pro",
    "gemini-3.5-flash",
  ]);
  return preferred.has(name);
}

export async function fetchCursorModels(): Promise<{
  models: ProviderModel[];
  fallback: boolean;
}> {
  try {
    const creds = await readCursorCreds();
    const res = await fetch(
      "https://api2.cursor.sh/aiserver.v1.AiService/AvailableModels",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${creds.token}`,
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
          "User-Agent": "buildover",
        },
        body: "{}",
      },
    );
    if (!res.ok) {
      return { models: CURSOR_FALLBACK_MODELS, fallback: true };
    }
    const data = (await res.json()) as { models?: AvailableModel[] };
    const all = (data.models ?? []).filter((m) => m.supportsAgent && m.name);
    const preferred = all.filter((m) => isPreferredModel(m.name!));
    const source = preferred.length >= 4 ? preferred : all.slice(0, 40);
    const models: ProviderModel[] = source.map((m) => ({
      id: toCursorModelId(m.name!),
      label: labelFor(m),
      provider: "cursor" as const,
      contextWindow: contextWindowFor(m.name!),
    }));
    return {
      models: models.length ? models : CURSOR_FALLBACK_MODELS,
      fallback: false,
    };
  } catch {
    return { models: CURSOR_FALLBACK_MODELS, fallback: true };
  }
}
