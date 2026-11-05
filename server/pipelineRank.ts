import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { complete } from "./anthropicDirect.js";
import { NOTES_FILE, PIPELINES_DIR } from "./pageTools.js";
import type { PipelineItem } from "./pipelines.js";
import type { PipelineSettings, SourceConfig } from "./pipelineSources.js";

// Ranking: one cheap call per source over one line per item, not an agent.
// What matters comes from the user's private heuristics (<pipelines dir>/
// ranking.md) and the notes their typed instructions leave (NOTES.md).

const RANKING_FILE = join(PIPELINES_DIR, "ranking.md");
const RANK_MODEL = "claude-haiku-4-5-20251001";

const read = (f: string) => readFile(f, "utf8").catch(() => "");

/** One line describing an item to the ranker. */
export function rankLine(item: PipelineItem, i: number, facts: string[] = []): string {
  const d = item.data && typeof item.data === "object" ? (item.data as Record<string, unknown>) : {};
  const shown = facts
    .map((k) => [k, d[k]] as const)
    .filter(([, v]) => v !== null && v !== undefined && v !== "" && typeof v !== "object")
    .map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`);
  const age = Math.max(0, Math.round((Date.now() - Date.parse(item.createdAt)) / 86_400_000));
  return `${i}. ${item.title}${item.summary ? ` — ${item.summary}` : ""}${shown.length ? ` [${shown.join(", ")}]` : ""} (${age}d here)`;
}

/** Parse "3, 0, 2" into an order covering every index once. */
export function parseOrder(answer: string, n: number): number[] {
  const order = [...new Set((answer.match(/\d+/g) ?? []).map(Number).filter((x) => x < n))];
  for (let i = 0; i < n; i++) if (!order.includes(i)) order.push(i);
  return order;
}

/** Re-rank a source's open items in place (rank 1 = most important). */
export async function rankItems(src: SourceConfig, items: PipelineItem[], settings: PipelineSettings): Promise<void> {
  if (!items.length) return;
  if (items.length === 1) {
    items[0].rank = 1;
    return;
  }
  const [heuristics, notes] = await Promise.all([read(RANKING_FILE), read(NOTES_FILE)]);
  const { text } = await complete({
    model: settings.rankModel ?? RANK_MODEL,
    maxTokens: 400,
    systemPrompt: [
      "You order a person's work items by what matters most to them. Weigh real impact on customers and on people who are blocked above theoretical severity.",
      heuristics.trim(),
      notes.trim() && `Their own notes:\n${notes.trim()}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    userPrompt: `Items from ${src.name}:\n${items.map((it, i) => rankLine(it, i, src.facts)).join("\n")}\n\nReply with only the item numbers, most important first, comma-separated.`,
  });
  parseOrder(text, items.length).forEach((idx, pos) => {
    items[idx].rank = pos + 1;
  });
}
