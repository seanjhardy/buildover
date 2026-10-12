#!/usr/bin/env node
// Where did the Claude Code tokens go? Reads local transcripts under
// ~/.claude/projects (desktop, CLI and SDK sessions incl. subagents) and prices
// every API call at list price, so the numbers are "API-equivalent $" — a good
// proxy for how fast a subscription's weekly limit burns.
//
//   npm run tokens               # last 7 days
//   npm run tokens -- --days 1
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";

const days = Number(process.argv[process.argv.indexOf("--days") + 1]) || 7;
const since = new Date(Date.now() - days * 864e5).toISOString();
const ROOT = join(homedir(), ".claude", "projects");

// $/MTok: input, output, cache read. Cache writes: 1.25× input (5m), 2× (1h).
const PRICES = [
  ["fable", 10, 50, 0.25], ["opus-5-5", 4, 20, 0.2], ["sonnet-5", 2, 10, 0.2], ["haiku-5", 0.1, 0.5, 0.01],
  ["opus", 5, 25, 0.5], ["sonnet", 3, 15, 0.3], ["haiku", 1, 5, 0.1],
];
const priceFor = (m = "") => PRICES.find(([k]) => m.includes(k)) ?? PRICES[1];

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".jsonl") && statSync(p).mtime.toISOString() >= since) yield p;
  }
}

const calls = [];
// Global: resumed / forked sessions copy earlier turns into their new file.
const seen = new Set();
let images = 0, compactions = 0;
for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file).split(sep);
  const project = rel[0].replace(/^-Users-[^-]+-Documents-/, "").replace(/^(Work|Projects)-/, "");
  const sub = rel.includes("subagents");
  let agentType = "main";
  if (sub) {
    const meta = file.replace(/\.jsonl$/, ".meta.json");
    agentType = existsSync(meta) ? JSON.parse(readFileSync(meta, "utf8")).agentType ?? "?" : "?";
  }
  const session = rel[1].replace(".jsonl", "").slice(0, 8);
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"assistant"') && !line.includes('"image"') && !line.includes("compact_boundary")) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if ((d.timestamp ?? "") < since) continue;
    if (d.subtype === "compact_boundary") { compactions++; continue; }
    const msg = d.message ?? {};
    if (d.type === "user" && Array.isArray(msg.content)) {
      for (const c of msg.content)
        if (c?.type === "tool_result" && Array.isArray(c.content)) images += c.content.filter((x) => x?.type === "image").length;
      continue;
    }
    const u = msg.usage;
    if (d.type !== "assistant" || !u || msg.model === "<synthetic>") continue;
    const key = `${msg.id}:${d.requestId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const [, pin, pout, pread] = priceFor(msg.model);
    let w5 = u.cache_creation?.ephemeral_5m_input_tokens ?? 0;
    const w1 = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    if (!w5 && !w1) w5 = u.cache_creation_input_tokens ?? 0;
    const read = u.cache_read_input_tokens ?? 0, inp = u.input_tokens ?? 0, out = u.output_tokens ?? 0;
    const parts = { input: inp * pin, write: w5 * pin * 1.25 + w1 * pin * 2, read: read * pread, output: out * pout };
    for (const k in parts) parts[k] /= 1e6;
    calls.push({
      project, session, agent: sub ? `subagent:${agentType}` : "main", model: msg.model, effort: d.effort ?? "-",
      day: d.timestamp.slice(0, 10), ctx: inp + w5 + w1 + read, write: w5 + w1, parts,
      cost: parts.input + parts.write + parts.read + parts.output,
    });
  }
}

const total = calls.reduce((s, c) => s + c.cost, 0);
const fmt = (n) => `$${n.toLocaleString("en", { maximumFractionDigits: 0 })}`;
function table(title, keyFn, limit = 10) {
  const g = new Map();
  for (const c of calls) {
    const k = keyFn(c);
    const r = g.get(k) ?? { cost: 0, n: 0, ctx: 0 };
    r.cost += c.cost; r.n++; r.ctx += c.ctx;
    g.set(k, r);
  }
  console.log(`\n${title}`);
  for (const [k, r] of [...g].sort((a, b) => b[1].cost - a[1].cost).slice(0, limit))
    console.log(`  ${String(k).padEnd(42).slice(0, 42)} ${fmt(r.cost).padStart(8)} ${((100 * r.cost) / total).toFixed(1).padStart(5)}%  ${String(r.n).padStart(6)} calls  avg ctx ${Math.round(r.ctx / r.n / 1000)}k`);
}

console.log(`Claude Code usage, last ${days} day(s): ${fmt(total)} API-equivalent over ${calls.length} calls`);
const comp = { input: 0, write: 0, read: 0, output: 0 };
for (const c of calls) for (const k in comp) comp[k] += c.parts[k];
console.log(`  cache reads ${fmt(comp.read)} · cache writes ${fmt(comp.write)} · output ${fmt(comp.output)} · uncached input ${fmt(comp.input)}`);
const big = calls.filter((c) => c.ctx > 200_000).reduce((s, c) => s + c.cost, 0);
console.log(`  ${((100 * big) / total).toFixed(0)}% of spend was calls with >200k context · ${images} images read · ${compactions} compactions`);
const busts = calls.filter((c) => c.write > 50_000 && c.write > 0.5 * c.ctx);
console.log(`  ${busts.length} full cache rewrites >50k tokens (resumed idle/stale sessions): ${fmt(busts.reduce((s, c) => s + c.parts.write, 0))}`);

table("By project", (c) => c.project);
table("Main thread vs subagents", (c) => c.agent);
table("By model", (c) => c.model);
table("By effort", (c) => c.effort);
table("By day", (c) => c.day, 14);
table("Top sessions (incl. subagents)", (c) => `${c.project} ${c.session}`, 10);
