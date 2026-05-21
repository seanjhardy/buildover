import { complete } from "./anthropicDirect.js";

// Generates a short chat title from the user's first prompt by asking Haiku
// over the bare Messages API (NOT through claude-agent-sdk) so it doesn't
// leave a phantom "chat" in ~/.claude/projects/.
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

  let raw: string;
  try {
    const result = await complete({
      model: "claude-haiku-4-5",
      userPrompt: instruction,
      maxTokens: 64,
    });
    raw = result.text;
  } catch {
    return null;
  }

  return cleanTitle(raw);
}

export async function generateCommitMessage(diff: string): Promise<string | null> {
  const trimmed = diff.trim().slice(0, 14_000);
  if (!trimmed) return null;

  const instruction = `Generate a concise git commit message for the following diff.

Constraints:
- Follow conventional commits format where appropriate (feat:, fix:, refactor:, style:, chore:, docs:, test:)
- Keep it under 72 characters
- Use imperative mood ("Add feature" not "Added feature")
- Be specific about what changed
- Output the commit message and nothing else — no explanation, no quotes

Diff:
\`\`\`
${trimmed}
\`\`\``;

  try {
    const result = await complete({
      model: "claude-haiku-4-5",
      userPrompt: instruction,
      maxTokens: 128,
    });
    const text = result.text.trim().replace(/^["'`]+|["'`]+$/g, "").trim();
    return text || null;
  } catch {
    return null;
  }
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
