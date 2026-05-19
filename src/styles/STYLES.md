# Styles layout

`app.css` is the single entry imported from `main.tsx`. It only `@import`s smaller modules so agents can edit one concern at a time.

| File | What to edit |
|------|----------------|
| `tokens.css` | Design tokens (colors, spacing, fonts) |
| `base.css` | Global reset, `html`/`body`, scrollbars |
| `shell.css` | App shell, header, wake word, model selector, connection pill |
| `chat-messages.css` | Message list, bubbles, thinking/tools blocks, table/chart blocks |
| `chat-composer.css` | Composer, context ring, queue, mic, popups, attachments |
| `chat-permissions.css` | Permission prompts, AskUserQuestion, plan card, mode picker |
| `mcp.css` | MCP server panel |
| `utilities.css` | Shared spinner |
| `layout-workspace.css` | Multi-repo layout, repo tabs, sidebar, chat pane, archive |
| `empty-states.css` | Empty workspace / empty chat, setup & permissions onboarding |
| `orchestrator.css` | Floating orchestrator FAB and speech bubble |
| `message-jump.css` | Message jump bar pill |
| `git.css` | Git panel, branch row, full-page git graph |
| `panels-rail.css` | Right-rail todo panel, icon strip, files tree |
| `dashboard.css` | Dashboard panel (todos, notes) |
| `schedule.css` | Schedule panel |
| `file-viewer.css` | File viewer slide-in and diff UI |
| `hljs.css` | highlight.js syntax colors |
| `terminal.css` | Terminal panel and tabs |
| `market.css` | Plugin market panel |
| `update-banner.css` | App update / dirty-repo banner |

Import order matters where later rules override earlier ones; add new modules at the end of `app.css` unless they are base resets.
