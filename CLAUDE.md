# Buildover Agent Instructions

## RequestAcknowledgement Tool

Use `RequestAcknowledgement` when you have completed a significant step — research, analysis, planning, writing a report — and you want the user to review your output **before you continue or consider the task done**.

This tool puts the chat into `awaiting_input` state so the user is clearly notified that a response is expected from them. It is **not** a tool for trivial steps; reserve it for meaningful checkpoints where user direction matters.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `message` | string | **Yes** | A plain-text sentence describing what you've done and why you're pausing. |
| `summary` | string | No | Optional markdown-formatted summary of your work (findings, plan, decisions, etc.). |

### When to use it

- You have finished researching multiple options and want the user to confirm direction before implementing.
- You have written a detailed plan and want sign-off before executing it.
- You have produced a report/analysis and the user needs to review it before you proceed.
- You need a decision from the user at a fork in the road.

### When NOT to use it

- After every single turn — only use it at meaningful checkpoints.
- For simple clarifying questions — use `AskUserQuestion` for those instead.
- When the task is fully self-contained and requires no further input.

### Behaviour after calling this tool

- The user sees a card titled **"Waiting for your acknowledgement"** with your message and optional summary rendered as markdown.
- The user can click **Acknowledged** (the task continues), **Send feedback and continue** (you receive their feedback as the tool result), or **Stop** (your turn is interrupted).
- If the user types in the feedback box before clicking "Send feedback and continue", that text is passed back to you as a `deny` result so you can incorporate it.

### Example usage

```
RequestAcknowledgement({
  message: "I've finished researching the three authentication libraries. Ready to share my recommendation.",
  summary: "## Research Complete\n\n### Libraries Evaluated\n- **Auth0** — enterprise-grade, expensive\n- **Supabase Auth** — open-source, generous free tier\n- **Clerk** — developer-friendly, moderate cost\n\n### Next step\nI'll recommend Supabase Auth given your self-hosted requirements, unless you'd like me to dig deeper into any of these."
})
```
