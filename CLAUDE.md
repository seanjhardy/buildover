# Buildover Agent Instructions

## Search Tools

Always use `rg` (ripgrep) instead of `grep` for searching file contents. Ripgrep is faster, respects `.gitignore` by default, and supports the same common flags (`-n`, `-i`, `-r`, etc.). For example:

- Use `rg "pattern" path/` instead of `grep -r "pattern" path/`
- Use `rg --type ts "pattern"` instead of `grep -r --include="*.ts" "pattern"`

## RequestUserAttention Tool

Use `RequestUserAttention` **only when you need a response or decision from the user** — for example, when you have a question that requires their input, when you have finished research and need them to choose a direction, or when you are about to take an action and need explicit sign-off.

**Do NOT use it simply to announce that you have completed a step.** If you have just read some files, finished some analysis, or produced a plan and intend to keep going, just continue — do not pause to ask for acknowledgement. The tool is for situations where you genuinely cannot proceed without the user's input.

This tool puts the chat into `awaiting_input` state so the user is clearly notified that a response is expected from them.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `message` | string | **Yes** | A plain-text sentence stating what you need from the user. |
| `summary` | string | No | Optional markdown-formatted context (findings, options, decisions, etc.) to help the user respond. |

### When to use it

- You have a question that you cannot answer yourself and need the user to decide.
- You have finished researching multiple options and need the user to confirm which direction to take **before you implement anything**.
- You have written a detailed plan and need explicit sign-off before executing it.
- You are at a genuine fork in the road where proceeding without input would be risky.

### When NOT to use it

- After reading files, exploring the codebase, or doing background research — just continue.
- After completing a self-contained task that required no further decisions.
- After every single turn — only use it when you genuinely need input.
- For simple clarifying questions mid-turn — use `AskUserQuestion` for those instead.
- When you have produced output (a report, analysis, plan) but are not yet blocked — present the output in the chat and keep going, or ask a specific follow-up question with `AskUserQuestion`.

### What happens when you call it

- The user sees a card titled **"Attention needed"** with your `message` and optional `summary` rendered as markdown.
- **Continue** — the user is happy to proceed; your turn continues normally.
- **Send feedback and continue** — the user has typed a comment; your turn is interrupted with their feedback as the denial message so you can incorporate it in a follow-up.
- **Stop** — the user wants to halt; your turn is aborted.

### Example usage

```
RequestUserAttention({
  message: "I've evaluated three authentication libraries. Which should I implement?",
  summary: "## Options\n\n- **Auth0** — enterprise-grade, expensive\n- **Supabase Auth** — open-source, generous free tier\n- **Clerk** — developer-friendly, moderate cost\n\nI recommend Supabase Auth given your self-hosted requirements, but let me know if you'd like me to dig deeper into any of these before I start."
})
```

## Context Management

The context window is a shared, finite resource. Every tool result, file read, and assistant message that remains in the history costs tokens on every subsequent API call. **Proactively clear irrelevant context** rather than letting it accumulate.

### ClearContext tool

Use `ClearContext` to trigger an immediate, silent compaction of the conversation history. After your current turn ends, the full history is summarised into a compact form — all irrelevant tool results and file contents are dropped from the active window.

```
ClearContext({
  reason: "Finished exploring the codebase — clearing file reads before starting implementation"
})
```

### When to call it

Call `ClearContext` **before** the context gets crowded, not after. Good triggers:

- You have finished an **exploration or research phase** (reading files, grepping, etc.) and are switching to writing or editing code. The raw file contents are no longer needed.
- You completed a **self-contained subtask** (e.g. debugging one module) and are moving on to an unrelated part of the codebase.
- The history contains **many large tool results** (long grep outputs, full file reads, shell output) that were only needed for a single step.
- You are about to start a **new logical phase** of a task and the prior context would just add noise.

### When NOT to call it

- Mid-investigation, when earlier results are still being referenced.
- When the context is mostly lean assistant/user messages — only clear when there is actual bulk to remove.
- Immediately before returning a final answer — compact first only if the history is genuinely large.
