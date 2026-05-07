import { query } from "@anthropic-ai/claude-agent-sdk";

// Generates a short chat title from the user's first prompt by asking Haiku.
// Returns the title string, or null if generation fails or yields nothing.
// We disable all tools so the model just produces text.
export async function generateTitle(userPrompt: string): Promise<string | null> {
  const trimmed = userPrompt.trim().slice(0, 800);
  if (!trimmed) return null;

  const instruction = `Summarize the following user request as a concise chat title.

Constraints:
- 3 to 6 words.
- Title case, no surrounding quotes, no trailing punctuation.
- Describe the *task*, not the act of asking ("Refactor auth middleware", not "Help with auth").
- Output the title and nothing else.

User request:
"""
${trimmed}
"""`;

  const stream = query({
    prompt: instruction,
    options: {
      model: "claude-haiku-4-5",
      // No tools, no working dir mutation — we just want one text reply.
      allowedTools: [],
      includePartialMessages: false,
    },
  });

  let collected = "";
  try {
    for await (const message of stream as AsyncIterable<any>) {
      if (message.type === "assistant") {
        for (const block of message.message?.content ?? []) {
          if (block?.type === "text") collected += String(block.text ?? "");
        }
      } else if (message.type === "result") {
        // Once we hit a result event the turn is done.
        break;
      }
    }
  } catch {
    return null;
  }

  return cleanTitle(collected);
}

function cleanTitle(raw: string): string | null {
  let t = raw.trim();
  if (!t) return null;
  // Strip wrapping quotes/backticks, trailing punctuation, and any prefix the
  // model added despite the instructions.
  t = t.replace(/^["'`“”]+|["'`“”]+$/g, "");
  t = t.replace(/[.!?,;:]+$/g, "");
  // If the model emitted multiple lines, keep just the first.
  t = t.split(/\r?\n/)[0].trim();
  if (!t) return null;
  // Cap length so we don't blow out the sidebar.
  if (t.length > 60) t = t.slice(0, 60).trimEnd();
  return t;
}
