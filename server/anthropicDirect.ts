import { fetchWithClaudeAuth } from "./anthropicAuth.js";

// Bare Anthropic Messages API client. Uses the same OAuth token the Claude
// Code CLI stores, so no separate ANTHROPIC_API_KEY is needed. We use this
// for tiny one-shot calls (chat title generation, voice segmentation) so
// they don't go through claude-agent-sdk and don't pollute
// ~/.claude/projects/ with phantom "chats" visible in the VS Code extension.

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";

export interface CompleteOptions {
  model: string;
  systemPrompt?: string;
  userPrompt: string;
  maxTokens?: number;
  // Soft request timeout. Defaults to 15s — these are tiny calls.
  timeoutMs?: number;
}

export interface CompleteResult {
  text: string;
}

// One-shot text completion. Throws on transport / auth / non-2xx responses.
export async function complete(opts: CompleteOptions): Promise<CompleteResult> {
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), opts.timeoutMs ?? 15_000);

  try {
    const res = await fetchWithClaudeAuth(MESSAGES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: ac.signal,
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens ?? 256,
        ...(opts.systemPrompt ? { system: opts.systemPrompt } : {}),
        messages: [{ role: "user", content: opts.userPrompt }],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Anthropic ${res.status}: ${body.slice(0, 300) || res.statusText}`,
      );
    }

    const json = (await res.json()) as {
      content?: { type: string; text?: string }[];
    };
    const text = (json.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    return { text };
  } finally {
    clearTimeout(timeout);
  }
}
