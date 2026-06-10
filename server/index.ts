import express from "express";
import { createServer } from "node:http";
import { readFile as fsReadFile, readdir, readFile, writeFile, stat as fsStat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { join, relative, isAbsolute as pathIsAbsolute, resolve as resolvePath } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import {
  createChat,
  deleteChat,
  listChats,
  readChat,
  recoverStaleChatsForRepo,
  recoverStaleChatsForRepoWithIds,
  setModel,
  setTitle,
  setUserFinished,
  ensureCoordinatorChat,
  CoordinatorDeleteError,
} from "./chats.js";
import {
  listTickets,
  createTicket,
  updateTicket,
  deleteTicket,
  getTicket,
} from "./plans.js";
import { broadcastPlansUpdated } from "./coordinationTools.js";
import { pickFolder } from "./picker.js";
import {
  ensureRepo,
  listRecents,
  removeRecent,
  touchRecent,
} from "./repos.js";
import { dropSession, getSession, tryGetSession } from "./sessions.js";
import { getOrchestrator } from "./orchestrator.js";
import { classifySegment } from "./segmenter.js";
import { fetchUsage } from "./usage.js";
import {
  getGitStatus,
  gitCheckout,
  gitCommit,
  gitPush,
  gitForcePush,
  gitPull,
  gitFetch,
  gitDiffStat,
  gitFileDiff,
  gitLog,
  gitCreateBranch,
  gitCherryPick,
  gitRevert,
  gitMerge,
  gitRebase,
  gitReset,
  gitDeleteBranch,
  gitCommitDiffStat,
  gitCommitFileDiff,
  gitGetWorkingDiff,
} from "./git.js";
import { generateCommitMessage } from "./title.js";
import {
  readDashboard,
  addNote,
  updateNote,
  deleteNote,
  addTodo,
  updateTodo,
  deleteTodo,
} from "./dashboard.js";
import {
  readSchedules,
  createTask,
  updateTask,
  deleteTask,
  startScheduler,
} from "./schedules.js";
import { attachTerminalWss } from "./terminal.js";
import {
  readInstalledServers,
  writeInstalledServers,
} from "./mcp-config.js";
import type { InstalledMcpServer } from "../src/types.js";
import { searchMessages, removeIndexedChat, getIndexStatus } from "./embeddings.js";
import {
  readRunConfig,
  readRunPanelHtml,
  writeRunConfig,
  checkPortListening,
  killPort,
} from "./runConfig.js";
import {
  checkForUpdates,
  getSelfUpdateStatus,
  getSelfAppRoot,
  pullLatestMain,
  startSelfUpdateChecker,
} from "./selfUpdate.js";
import { readCreds } from "./anthropicAuth.js";
import {
  listGitHubPRs,
  getGitHubPR,
  mergePR,
  addPRComment,
  updatePRBranch,
  getDefaultBranch,
  createPR,
  getPRDiff,
  editPR,
  getRepoCollaborators,
  getRepoLabels,
  getStatusFiles,
} from "./github.js";
import type {
  AgentEvent,
  ClientMessage,
  Model,
  OrchestratorClientMessage,
  OrchestratorEvent,
  PermissionMode,
} from "../src/types.js";

const PORT = Number(process.env.PORT ?? 8787);

const app = express();
app.use(express.json({ limit: "10mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

// Focus helper: opened by the Dock launcher instead of localhost:5173 directly.
// Sends a BroadcastChannel message to any existing app tab telling it to focus,
// then redirects to the app. If no tab is open yet, the redirect opens it fresh.
app.get("/focus", (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html>
<head><title>buildover</title></head>
<body>
<script>
  const ch = new BroadcastChannel('buildover-focus');
  let acknowledged = false;

  // If an existing app tab replies with 'ack' within 300ms, it's already
  // open and focused — just close this helper tab silently.
  ch.addEventListener('message', (e) => {
    if (e.data === 'ack') {
      acknowledged = true;
      ch.close();
      window.close();
    }
  });

  // Ask any open app tab to focus itself and reply
  ch.postMessage('focus');

  // If no ack after 300ms, no app tab is open yet — navigate here to the app
  setTimeout(() => {
    if (!acknowledged) {
      ch.close();
      window.location.replace('http://localhost:5173');
    }
  }, 300);
</script>
</body>
</html>`);
});

// ---- Env var management ----
const MANAGED_ENV_VARS = ["WHISPER_API_KEY", "GROQ_API_KEY", "GROQ_WHISPER_MODEL"];

app.get("/api/env/status", (_req, res) => {
  const status: Record<string, boolean> = {};
  for (const key of MANAGED_ENV_VARS) {
    status[key] = Boolean(process.env[key]);
  }
  res.json({ status });
});

app.post("/api/env/set", async (req, res) => {
  const key = String(req.body?.key ?? "").trim();
  const value = String(req.body?.value ?? "").trim();
  if (!/^[A-Z][A-Z0-9_]*$/.test(key) || !MANAGED_ENV_VARS.includes(key)) {
    res.status(400).json({ error: "Invalid or unknown env var key" });
    return;
  }
  const envPath = join(process.cwd(), ".env");
  let content = "";
  try { content = await readFile(envPath, "utf-8"); } catch { /* create fresh */ }
  // Replace existing key or append
  const lines = content.split("\n");
  const idx = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
  const newLine = `${key}="${value}"`;
  if (idx >= 0) {
    lines[idx] = newLine;
  } else {
    if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
    lines.push(newLine);
  }
  await writeFile(envPath, lines.join("\n"), "utf-8");
  process.env[key] = value; // take effect immediately in this process
  res.json({ ok: true });
});

app.get("/api/usage", async (_req, res) => {
  try {
    res.json(await fetchUsage());
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// ---- Model list ----
// Proxies the Anthropic models API so the frontend gets a live list without
// exposing credentials to the browser.
app.get("/api/models", async (_req, res) => {
  try {
    const creds = await readCreds();
    const resp = await fetch("https://api.anthropic.com/v1/models?limit=100", {
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        "anthropic-version": "2023-06-01",
      },
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return res.status(resp.status).json({ error: text || resp.statusText });
    }
    const data = (await resp.json()) as {
      data: { id: string; display_name: string; created_at: string }[];
    };
    // Return only claude-* models, newest first, shaped for the frontend.
    // Include context window sizes based on model family
    const models = (data.data ?? [])
      .filter((m) => m.id.startsWith("claude-"))
      .map((m) => {
        let contextWindow = 200_000; // default
        if (m.id.includes("opus") || m.id.includes("sonnet")) {
          contextWindow = 1_000_000;
        }
        return { id: m.id, label: m.display_name, contextWindow };
      });
    res.json({ models });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// ---- Agent list ----
// Returns the list of available agent types from the SDK
app.get("/api/agents", async (_req, res) => {
  try {
    const { query, startup } = await import("@anthropic-ai/claude-agent-sdk");
    await startup();

    const stream = query({
      // query() requires a string or AsyncIterable — wrap the single message
      // in an async generator.
      prompt: (async function* () {
        yield {
          type: "user" as const,
          message: { role: "user" as const, content: "test" },
          parent_tool_use_id: null,
          session_id: "",
        };
      })(),
      options: {
        model: "claude-sonnet-4-5",
        includePartialMessages: false,
      },
    });

    let agents: string[] = [];
    for await (const msg of stream as AsyncIterable<any>) {
      if (msg.type === "system" && msg.subtype === "init") {
        agents = msg.agents || [];
        break;
      }
    }

    // Interrupt the stream to clean up
    await (stream as any).interrupt?.().catch(() => {});

    res.json({ agents });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// ---- Audio transcription ----
const GROQ_TRANSCRIBE_URL =
  "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL = process.env.GROQ_WHISPER_MODEL ?? "whisper-large-v3-turbo";

app.post(
  "/api/transcribe",
  express.raw({ type: "application/octet-stream", limit: "25mb" }),
  async (req, res) => {
    const apiKey = process.env.WHISPER_API_KEY ?? process.env.GROQ_API_KEY;
    if (!apiKey) {
      res
        .status(500)
        .json({ error: "WHISPER_API_KEY is not set on the server" });
      return;
    }
    const buffer = req.body as Buffer | undefined;
    if (!buffer || buffer.length === 0) {
      res.status(400).json({ error: "Empty audio body" });
      return;
    }
    const mime =
      typeof req.query.mime === "string" ? req.query.mime : "audio/webm";
    const ext = mime.includes("ogg") ? "ogg" : mime.includes("mp4") ? "m4a" : mime.includes("wav") ? "wav" : "webm";
    try {
      const form = new FormData();
      const ab = new ArrayBuffer(buffer.byteLength);
      new Uint8Array(ab).set(buffer);
      form.append("file", new Blob([ab], { type: mime }), `audio.${ext}`);
      form.append("model", GROQ_MODEL);
      form.append("response_format", "json");
      if (typeof req.query.language === "string") {
        form.append("language", req.query.language);
      }

      const r = await fetch(GROQ_TRANSCRIBE_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
      if (!r.ok) {
        const text = await r.text();
        res.status(r.status).json({ error: text || `HTTP ${r.status}` });
        return;
      }
      const json = (await r.json()) as { text?: string };
      res.json({ text: json.text ?? "" });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
);

// ---- Orchestrator: voice segmenter ----
app.post("/api/segment", async (req, res) => {
  try {
    const text = String(req.body?.text ?? "");
    const rateKey = req.ip ?? "anon";
    const result = await classifySegment(text, rateKey);
    res.json(result);
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// ---- Folder picker ----
app.get("/api/picker/folder", async (_req, res) => {
  try {
    const path = await pickFolder();
    res.json({ path });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// ---- Repos ----
app.get("/api/repos/recents", async (_req, res) => {
  try {
    res.json({ recents: await listRecents() });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.post("/api/repos/open", async (req, res) => {
  try {
    const path = String(req.body?.path ?? "");
    const meta = await ensureRepo(path);
    await touchRecent(meta);
    res.json({ repo: meta });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.delete("/api/repos/recents", async (req, res) => {
  try {
    const path = String(req.body?.path ?? "");
    await removeRecent(path);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// ---- Chats ----
function readRepoPath(req: express.Request): string {
  const p = (req.query.repoPath ?? req.body?.repoPath ?? "") as string;
  if (!p) throw new Error("repoPath required");
  return String(p);
}

app.get("/api/chats", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    // Every repo has a permanent Coordinator chat pinned in the sidebar;
    // create it lazily the first time the chat list is requested.
    await ensureCoordinatorChat(repoPath);
    const chats = await listChats(repoPath);
    // Overlay live "awaiting_input" for any chats whose session has a pending
    // attention. This state is never persisted to disk, so listChats() alone
    // would return "running" for those chats — causing the sidebar and tab
    // badges to revert to "running" on every repo-switch or page reload.
    for (const chat of chats) {
      const session = tryGetSession(repoPath, chat.id);
      if (session && session.pendingAttentionList().length > 0) {
        chat.status = "awaiting_input";
      }
    }
    res.json({ chats });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.post("/api/chats", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    const model = (req.body?.model as Model) ?? "claude-opus-4-8";
    const permissionMode =
      (req.body?.permissionMode as PermissionMode) ?? "default";
    const record = await createChat(repoPath, { model, permissionMode });
    res.json({ chat: record });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.get("/api/chats/:chatId", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    const record = await readChat(repoPath, req.params.chatId);
    if (!record) return res.status(404).json({ error: "Not found" });
    res.json({ chat: record });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.patch("/api/chats/:chatId", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    let record = await readChat(repoPath, req.params.chatId);
    if (!record) return res.status(404).json({ error: "Not found" });
    if (typeof req.body?.userMarkedFinished === "boolean") {
      record =
        (await setUserFinished(
          repoPath,
          req.params.chatId,
          req.body.userMarkedFinished,
        )) ?? record;
    }
    if (typeof req.body?.title === "string" && req.body.title.trim()) {
      record =
        (await setTitle(
          repoPath,
          req.params.chatId,
          req.body.title.trim(),
          false,
        )) ?? record;
    }
    if (typeof req.body?.model === "string" && req.body.model.trim()) {
      record = (await setModel(repoPath, req.params.chatId, req.body.model.trim())) ?? record;
    }
    res.json({ chat: record });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.delete("/api/chats/:chatId", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    // Delete first: this throws CoordinatorDeleteError for coordinator chats,
    // so we never interrupt a coordinator that can't actually be deleted.
    const ok = await deleteChat(repoPath, req.params.chatId);
    if (!ok) return res.status(404).json({ error: "Not found" });
    const session = tryGetSession(repoPath, req.params.chatId);
    session?.interrupt();
    dropSession(repoPath, req.params.chatId);
    // Remove embeddings for the deleted chat
    removeIndexedChat(repoPath, req.params.chatId);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof CoordinatorDeleteError) {
      return res.status(403).json({ error: err.message });
    }
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// ---- Plans (coordinator ticket board) ----
app.get("/api/plans", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    const tickets = await listTickets(repoPath);
    res.json({ tickets });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.post("/api/plans", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    const title = String(req.body?.title ?? "").trim();
    const description = String(req.body?.description ?? "");
    if (!title) return res.status(400).json({ error: "title required" });
    const ticket = await createTicket(repoPath, {
      title,
      description,
      status: req.body?.status,
      order: typeof req.body?.order === "number" ? req.body.order : undefined,
    });
    await broadcastPlansUpdated(repoPath);
    res.json({ ticket });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.patch("/api/plans/:ticketId", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    const prevStatus = (
      await listTickets(repoPath)
    ).find((t) => t.id === req.params.ticketId)?.status;
    const ticket = await updateTicket(repoPath, req.params.ticketId, {
      title: req.body?.title,
      description: req.body?.description,
      status: req.body?.status,
      order: typeof req.body?.order === "number" ? req.body.order : undefined,
    });
    if (!ticket) return res.status(404).json({ error: "Not found" });
    await broadcastPlansUpdated(repoPath);
    // Panel status changes are board-only: the coordinator deliberately gets
    // NO message for approvals/rejections/sign-offs — it reads the board with
    // list_tickets whenever it's next active, so working the panel never
    // spams it. The one exception is rejection feedback, which goes straight
    // to the agent that owns the ticket (its worker, else its drafter).
    if (
      ticket.status === "rejected" &&
      ticket.status !== prevStatus &&
      typeof req.body?.feedback === "string" &&
      req.body.feedback.trim()
    ) {
      const target = ticket.subagentChatId ?? ticket.createdByChatId;
      if (target && (await readChat(repoPath, target))) {
        void getSession(repoPath, target)
          .deliverMessage({
            text: `The user rejected the plan "${ticket.title}" with this feedback: ${req.body.feedback.trim()}`,
            origin: "system",
            originLabel: "Plan rejected",
          })
          .catch((e) => console.warn("[plans] feedback delivery failed:", e));
      }
    }
    res.json({ ticket });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// Ephemeral feedback on a plan: delivered straight into the chat of the agent
// linked to the ticket (the worker if one was spawned, otherwise the agent
// that drafted it). Nothing is persisted on the ticket itself, and the
// coordinator is never involved.
app.post("/api/plans/:ticketId/message", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    const text = String(req.body?.text ?? "").trim();
    if (!text) return res.status(400).json({ error: "text required" });
    const ticket = await getTicket(repoPath, req.params.ticketId);
    if (!ticket) return res.status(404).json({ error: "Not found" });
    const target = ticket.subagentChatId ?? ticket.createdByChatId;
    const targetChat = target ? await readChat(repoPath, target) : null;
    if (!target || !targetChat) {
      return res
        .status(409)
        .json({ error: "No agent is linked to this plan yet" });
    }
    await getSession(repoPath, target).deliverMessage({
      text: `(About the plan "${ticket.title}") ${text}`,
    });
    res.json({ ok: true, chatId: target });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.delete("/api/plans/:ticketId", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    const ok = await deleteTicket(repoPath, req.params.ticketId);
    if (!ok) return res.status(404).json({ error: "Not found" });
    await broadcastPlansUpdated(repoPath);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// ---- Semantic search ----
app.post("/api/search", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    const query = String(req.body?.query ?? "").trim();
    const limit = Math.min(Number(req.body?.limit ?? 12), 50);
    const { results, status } = await searchMessages(repoPath, query, limit);
    res.json({ results, status });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.get("/api/search/status", (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    // Kick off background indexing if not started yet
    void (async () => { try { const { ensureIndexedBackground } = await import("./embeddings.js"); ensureIndexedBackground(repoPath); } catch {} })();
    res.json(getIndexStatus());
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---- Git operations ----
app.get("/api/git/status", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    const status = await getGitStatus(repoPath);
    res.json(status);
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.post("/api/git/checkout", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    const branch = String(req.body?.branch ?? "");
    if (!branch) throw new Error("branch required");
    await gitCheckout(repoPath, branch);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.post("/api/git/commit", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    const message = String(req.body?.message ?? "");
    if (!message) throw new Error("message required");
    await gitCommit(repoPath, message);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.post("/api/git/push", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    await gitPush(repoPath);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.post("/api/git/force-push", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    await gitForcePush(repoPath);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.post("/api/git/pull", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    await gitPull(repoPath);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.post("/api/git/fetch", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    await gitFetch(repoPath);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.get("/api/git/log", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) || 150 : 150;
    const result = await gitLog(repoPath, limit);
    res.json(result);
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.post("/api/git/branch", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    const name = String(req.body?.name ?? "").trim();
    if (!name) throw new Error("name required");
    const fromHash = typeof req.body?.fromHash === "string" ? req.body.fromHash : undefined;
    await gitCreateBranch(repoPath, name, fromHash);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.get("/api/git/diff", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    const relPath = String(req.query.file ?? "");
    if (!relPath) throw new Error("file required");
    const result = await gitFileDiff(repoPath, relPath);
    res.json(result);
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.get("/api/git/diff-stat", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    const filesParam = String(req.query.files ?? "");
    const relPaths = filesParam
      ? filesParam.split(",").map((f) => f.trim()).filter(Boolean)
      : [];
    const stats = await gitDiffStat(repoPath, relPaths);
    res.json({ stats });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// ---- Installed MCP servers ----

app.get("/api/mcp-servers", (_req, res) => {
  res.json(readInstalledServers());
});

app.post("/api/mcp-servers", (req, res) => {
  const entry = req.body as InstalledMcpServer;
  if (!entry?.id || !entry?.type) {
    return res.status(400).json({ error: "id and type are required" });
  }
  const servers = readInstalledServers();
  const idx = servers.findIndex((s) => s.id === entry.id);
  if (idx >= 0) servers[idx] = entry;
  else servers.push(entry);
  writeInstalledServers(servers);
  res.json({ ok: true });
});

app.delete("/api/mcp-servers", (req, res) => {
  const id = String(req.query.id ?? "");
  if (!id) return res.status(400).json({ error: "id required" });
  writeInstalledServers(readInstalledServers().filter((s) => s.id !== id));
  res.json({ ok: true });
});

// ---- MCP server config ----

app.get("/api/mcp-servers", (_req, res) => {
  res.json(readInstalledServers());
});

app.post("/api/mcp-servers", (req, res) => {
  const entry = req.body as InstalledMcpServer;
  if (!entry?.id || !entry?.type) {
    return res.status(400).json({ error: "id and type are required" });
  }
  const servers = readInstalledServers();
  const idx = servers.findIndex((s) => s.id === entry.id);
  if (idx >= 0) servers[idx] = entry;
  else servers.push(entry);
  writeInstalledServers(servers);
  res.json({ ok: true });
});

app.delete("/api/mcp-servers/:id", (req, res) => {
  const id = decodeURIComponent(req.params.id);
  writeInstalledServers(readInstalledServers().filter((s) => s.id !== id));
  res.json({ ok: true });
});

app.post("/api/git/cherry-pick", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    const hash = String(req.body?.hash ?? "");
    if (!hash) throw new Error("hash required");
    await gitCherryPick(repoPath, hash);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/git/revert", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    const hash = String(req.body?.hash ?? "");
    if (!hash) throw new Error("hash required");
    await gitRevert(repoPath, hash);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/git/merge", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    const ref = String(req.body?.ref ?? "");
    if (!ref) throw new Error("ref required");
    await gitMerge(repoPath, ref);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/git/rebase", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    const onto = String(req.body?.onto ?? "");
    if (!onto) throw new Error("onto required");
    await gitRebase(repoPath, onto);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/git/reset", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    const hash = String(req.body?.hash ?? "");
    const mode = (req.body?.mode ?? "mixed") as "soft" | "mixed" | "hard";
    if (!hash) throw new Error("hash required");
    await gitReset(repoPath, hash, mode);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete("/api/git/branch", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    const name = String(req.body?.name ?? "").trim();
    if (!name) throw new Error("name required");
    await gitDeleteBranch(repoPath, name);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/git/commit-diff", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    const hash = String(req.query.hash ?? "");
    if (!hash) throw new Error("hash required");
    const files = await gitCommitDiffStat(repoPath, hash);
    res.json({ files });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/git/commit-file-diff", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    const hash = String(req.query.hash ?? "");
    const file = String(req.query.file ?? "");
    if (!hash) throw new Error("hash required");
    if (!file) throw new Error("file required");
    const diff = await gitCommitFileDiff(repoPath, hash, file);
    res.json({ diff });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---- Git status files (porcelain) ----
app.get("/api/git/status-files", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    const files = await getStatusFiles(repoPath);
    res.json({ files });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---- Generate commit message via Haiku ----
app.post("/api/git/generate-commit-message", async (req, res) => {
  try {
    const { repoPath } = req.body as { repoPath?: string };
    if (!repoPath) return res.status(400).json({ error: "repoPath required" });
    const diff = await gitGetWorkingDiff(repoPath);
    if (!diff) return res.status(400).json({ error: "No changes to describe" });
    const message = await generateCommitMessage(diff);
    if (!message) return res.status(500).json({ error: "Failed to generate message" });
    res.json({ message });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---- GitHub PR routes ----
app.get("/api/github/prs", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    const prs = await listGitHubPRs(repoPath);
    res.json({ prs });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

app.get("/api/github/pr", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    const number = parseInt(String(req.query.number ?? ""), 10);
    if (!number || isNaN(number)) throw new Error("number required");
    const pr = await getGitHubPR(repoPath, number);
    res.json({ pr });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

app.post("/api/github/pr/merge", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    const number = parseInt(String(req.body?.number ?? ""), 10);
    if (!number || isNaN(number)) throw new Error("number required");
    const method = (req.body?.method ?? "merge") as 'merge' | 'squash' | 'rebase';
    await mergePR(repoPath, number, method);
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

app.post("/api/github/pr/comment", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    const number = parseInt(String(req.body?.number ?? ""), 10);
    if (!number || isNaN(number)) throw new Error("number required");
    const body = String(req.body?.body ?? "").trim();
    if (!body) throw new Error("body required");
    await addPRComment(repoPath, number, body);
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

app.post("/api/github/pr/update-branch", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    const number = parseInt(String(req.body?.number ?? ""), 10);
    if (!number || isNaN(number)) throw new Error("number required");
    await updatePRBranch(repoPath, number);
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ---- GitHub PR create ----
app.get("/api/github/default-branch", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    const branch = await getDefaultBranch(repoPath);
    res.json({ branch });
  } catch (err) {
    // Always return a sensible fallback — never a 500
    res.json({ branch: 'main' });
  }
});

app.post("/api/github/pr/create", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    const { title, body, head, base, draft } = req.body ?? {};
    if (!title) throw new Error("title required");
    if (!head) throw new Error("head required");
    if (!base) throw new Error("base required");
    const prNumber = await createPR(repoPath, String(title), String(body ?? ''), String(head), String(base), Boolean(draft));
    const pr = await getGitHubPR(repoPath, prNumber);
    res.json({ pr });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ---- GitHub PR diff ----
app.get("/api/github/pr/diff", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    const number = parseInt(String(req.query.number ?? ""), 10);
    if (isNaN(number)) throw new Error("number required");
    const diff = await getPRDiff(repoPath, number);
    res.json({ diff });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ---- GitHub PR edit (reviewers / assignees / labels) ----
app.post("/api/github/pr/edit", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    const { number, addReviewers, removeReviewers, addAssignees, removeAssignees, addLabels, removeLabels } = req.body ?? {};
    if (!number) throw new Error("number required");
    await editPR(repoPath, Number(number), {
      addReviewers: addReviewers as string[] | undefined,
      removeReviewers: removeReviewers as string[] | undefined,
      addAssignees: addAssignees as string[] | undefined,
      removeAssignees: removeAssignees as string[] | undefined,
      addLabels: addLabels as string[] | undefined,
      removeLabels: removeLabels as string[] | undefined,
    });
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ---- GitHub repo collaborators ----
app.get("/api/github/collaborators", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    const collaborators = await getRepoCollaborators(repoPath);
    res.json({ collaborators });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ---- GitHub repo labels ----
app.get("/api/github/labels", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    const labels = await getRepoLabels(repoPath);
    res.json({ labels });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ---- File read ----
app.get("/api/file/read", async (req, res) => {
  try {
    const filePath = String(req.query.path ?? "");
    if (!filePath) throw new Error("path required");
    // Basic safety: only allow absolute paths (no path traversal tricks)
    const { resolve, isAbsolute } = await import("node:path");
    if (!isAbsolute(filePath)) throw new Error("absolute path required");
    const content = await fsReadFile(resolve(filePath), "utf8");
    res.json({ content });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// ---- File serve (binary — for images and other binary assets) ----
const SERVE_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
  avif: "image/avif",
  tiff: "image/tiff",
  tif: "image/tiff",
};

app.get("/api/file/serve", async (req, res) => {
  try {
    const filePath = String(req.query.path ?? "");
    if (!filePath) throw new Error("path required");
    if (!pathIsAbsolute(filePath)) throw new Error("absolute path required");
    const resolved = resolvePath(filePath);
    const ext = resolved.split(".").pop()?.toLowerCase() ?? "";
    const mimeType = SERVE_MIME_TYPES[ext] ?? "application/octet-stream";
    const buffer = await fsReadFile(resolved);
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Cache-Control", "no-cache");
    res.send(buffer);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---- File list ----
const FILE_LIST_EXCLUDES = new Set([
  "node_modules", ".git", "dist", "build", "out",
  ".next", ".cache", "coverage", ".turbo", ".swc",
]);
const FILE_LIST_MAX = 5000;

async function walkDir(root: string, current: string, results: string[]): Promise<void> {
  if (results.length >= FILE_LIST_MAX) return;
  let entries;
  try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (results.length >= FILE_LIST_MAX) return;
    if (FILE_LIST_EXCLUDES.has(entry.name)) continue;
    const full = join(current, entry.name);
    if (entry.isDirectory()) {
      await walkDir(root, full, results);
    } else if (entry.isFile()) {
      results.push(relative(root, full));
    }
  }
}

app.get("/api/file/list", async (req, res) => {
  try {
    const repoPath = String(req.query.path ?? "");
    if (!repoPath) throw new Error("path required");
    if (!pathIsAbsolute(repoPath)) throw new Error("absolute path required");
    const root = resolvePath(repoPath);
    const files: string[] = [];
    await walkDir(root, root, files);
    res.json({ files });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---- File write ----
app.post("/api/file/write", async (req, res) => {
  try {
    const filePath = String(req.body?.path ?? "");
    const content = String(req.body?.content ?? "");
    if (!filePath) throw new Error("path required");
    const { resolve, isAbsolute } = await import("node:path");
    if (!isAbsolute(filePath)) throw new Error("absolute path required");
    await writeFile(resolve(filePath), content, "utf8");
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---- File content search (pure Node.js — no external binary required) ----
interface SearchLineMatch { line: number; text: string }
interface SearchFileResult { relPath: string; lines: SearchLineMatch[] }

const SEARCH_MAX_FILE_CHARS    = 500_000; // skip files larger than ~500 KB text
const SEARCH_MAX_MATCHES_PER_FILE = 20;   // lines shown per file
const SEARCH_PAGE_SIZE         = 50;      // matching files per page — stop early here

app.get("/api/file/search", async (req, res) => {
  try {
    const repoPath    = String(req.query.path ?? "");
    const query       = String(req.query.query ?? "");
    const excludeExts = String(req.query.excludeExts ?? "");
    const offset      = Math.max(0, parseInt(String(req.query.offset ?? "0"), 10) || 0);

    if (!repoPath) throw new Error("path required");
    if (!query.trim()) { res.json({ matches: [], total: 0, hasMore: false }); return; }
    if (!pathIsAbsolute(repoPath)) throw new Error("absolute path required");

    const root       = resolvePath(repoPath);
    const queryLower = query.toLowerCase();

    const excludedExts = new Set(
      excludeExts.split(",").map((e) => e.trim().replace(/^\./, "").toLowerCase()).filter(Boolean),
    );

    // Reuse the existing walkDir which already skips node_modules/.git/dist/…
    const allFiles: string[] = [];
    await walkDir(root, root, allFiles);

    const results: SearchFileResult[] = [];
    let total   = 0;   // matches in this page
    let skipped = 0;   // matching files skipped due to offset
    let hasMore = false;

    for (const relPath of allFiles) {
      const ext = relPath.split(".").pop()?.toLowerCase() ?? "";
      if (excludedExts.has(ext)) continue;

      const absPath = join(root, relPath);
      let content: string;
      try {
        content = await fsReadFile(absPath, "utf8");
      } catch { continue; }

      if (content.length > SEARCH_MAX_FILE_CHARS) continue;

      const rawLines = content.split("\n");
      const matches: SearchLineMatch[] = [];

      for (let i = 0; i < rawLines.length; i++) {
        if (rawLines[i]!.toLowerCase().includes(queryLower)) {
          matches.push({ line: i + 1, text: rawLines[i]! });
          if (matches.length >= SEARCH_MAX_MATCHES_PER_FILE) break;
        }
      }

      if (matches.length === 0) continue;

      // Skip files that belong to earlier pages
      if (skipped < offset) { skipped++; continue; }

      results.push({ relPath, lines: matches });
      total += matches.length;

      // Stop as soon as we have a full page — don't read more files
      if (results.length >= SEARCH_PAGE_SIZE) {
        hasMore = true;
        break;
      }
    }

    res.json({ matches: results, total, hasMore });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---- Dashboard ----
app.get("/api/dashboard", async (_req, res) => {
  try {
    res.json(await readDashboard());
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/dashboard/notes", async (req, res) => {
  try {
    const content = String(req.body?.content ?? "").trim();
    if (!content) { res.status(400).json({ error: "content required" }); return; }
    const pinned = Boolean(req.body?.pinned ?? false);
    res.json(await addNote(content, pinned));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.patch("/api/dashboard/notes/:id", async (req, res) => {
  try {
    const note = await updateNote(req.params.id, {
      content: req.body?.content,
      pinned: req.body?.pinned,
    });
    if (!note) { res.status(404).json({ error: "Not found" }); return; }
    res.json(note);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete("/api/dashboard/notes/:id", async (req, res) => {
  try {
    const ok = await deleteNote(req.params.id);
    if (!ok) { res.status(404).json({ error: "Not found" }); return; }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/dashboard/todos", async (req, res) => {
  try {
    const text = String(req.body?.text ?? "").trim();
    if (!text) { res.status(400).json({ error: "text required" }); return; }
    const priority = req.body?.priority ?? "medium";
    res.json(await addTodo(text, priority));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.patch("/api/dashboard/todos/:id", async (req, res) => {
  try {
    const todo = await updateTodo(req.params.id, {
      text: req.body?.text,
      done: req.body?.done,
      priority: req.body?.priority,
    });
    if (!todo) { res.status(404).json({ error: "Not found" }); return; }
    res.json(todo);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete("/api/dashboard/todos/:id", async (req, res) => {
  try {
    const ok = await deleteTodo(req.params.id);
    if (!ok) { res.status(404).json({ error: "Not found" }); return; }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---- Scheduled tasks ----
app.get("/api/schedules", async (_req, res) => {
  try {
    const list = await readSchedules();
    res.json({ tasks: list.tasks });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/schedules", async (req, res) => {
  try {
    const task = await createTask({
      label: String(req.body?.label ?? "").trim() || "Untitled task",
      cronExpression: String(req.body?.cronExpression ?? ""),
      prompt: String(req.body?.prompt ?? "").trim(),
      repoPath: String(req.body?.repoPath ?? ""),
      chatId: req.body?.chatId,
      model: req.body?.model,
      permissionMode: req.body?.permissionMode,
      enabled: req.body?.enabled !== false,
    });
    res.json(task);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.patch("/api/schedules/:id", async (req, res) => {
  try {
    const task = await updateTask(req.params.id, req.body);
    if (!task) { res.status(404).json({ error: "Not found" }); return; }
    res.json(task);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete("/api/schedules/:id", async (req, res) => {
  try {
    const ok = await deleteTask(req.params.id);
    if (!ok) { res.status(404).json({ error: "Not found" }); return; }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---- Run config ----
app.get("/api/run-config", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    const config = await readRunConfig(repoPath);
    res.json({ config });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/run-config/html", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    const html = await readRunPanelHtml(repoPath);
    res.json({ html });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/port-status", async (req, res) => {
  try {
    const port = parseInt(String(req.query.port ?? ""), 10);
    if (!port || isNaN(port)) throw new Error("port required");
    const listening = await checkPortListening(port);
    res.json({ listening });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/kill-port", async (req, res) => {
  try {
    const port = Number(req.body?.port);
    if (!port || isNaN(port)) throw new Error("port required");
    await killPort(port);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---- Self-update routes ----

app.get("/api/self/status", async (_req, res) => {
  try {
    // Return cached result immediately; background cron keeps it fresh.
    // If there is no cache yet (first request before the initial check fires),
    // run one synchronously so the client always gets a real answer.
    const status = getSelfUpdateStatus() ?? (await checkForUpdates());
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/self/info", (_req, res) => {
  res.json({ appRoot: getSelfAppRoot() });
});

app.post("/api/self/pull", async (_req, res) => {
  try {
    const result = await pullLatestMain(false);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/self/force-pull", async (_req, res) => {
  try {
    const result = await pullLatestMain(true);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---- WebSocket multiplexer ----
const httpServer = createServer(app);
// Both WS endpoints use noServer mode so we can route a single `upgrade`
// event based on the URL path. Attaching multiple WebSocketServers to the
// same httpServer with `server:` causes the non-matching one to abort the
// handshake with a 400 on the already-upgraded socket, which kills the
// connection from the browser's side.
const wss = new WebSocketServer({ noServer: true });

// Terminal WebSocket server — one per browser tab, multiplexed by tabId
const terminalWss = new WebSocketServer({ noServer: true });
attachTerminalWss(terminalWss);

wss.on("connection", (ws: WebSocket) => {
  // A connection can subscribe to many chats. We hold the unsubscribe fn plus
  // (repoPath, chatId) so subsequent client messages can route back to the
  // same session instance.
  const subscriptions = new Map<
    string,
    { repoPath: string; chatId: string; unsubscribe: () => void }
  >();

  const send = (event: AgentEvent) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
  };

  const subscribe = async (
    repoPath: string,
    chatId: string,
    withReplay: boolean,
  ) => {
    const existing = subscriptions.get(chatId);
    if (existing && !withReplay) return; // already subscribed, no replay needed
    const session = getSession(repoPath, chatId);
    if (withReplay) {
      // If the persisted record claims a turn is in flight but this session
      // has nothing running (typical after the previous server died), heal
      // the transcript before replaying so the client doesn't get a phantom
      // "running" status it can never escape.
      // Also re-heal if the chat is in "error" state from a previous recovery
      // and a new server restart happened during a retry — we need to append a
      // fresh error+turn_end so the client knows to retry again.
      let record = await readChat(repoPath, chatId);
      const needsRecovery =
        record &&
        !session.isRunning() &&
        (record.status === "running" ||
          record.status === "awaiting_input" ||
          record.status === "error");
      if (needsRecovery) {
        await recoverStaleChatsForRepo(repoPath).catch(() => {});
        record = await readChat(repoPath, chatId);
      }
      if (record) {
        send({
          type: "chat_replay",
          chatId,
          record,
          pendingPermissions: session.pendingPermissionList(),
          pendingAttentions: session.pendingAttentionList(),
        });
        // Always push chat_status after a replay so any sidebar subscriber
        // on this same WS connection (withReplay: false) picks up the current
        // status immediately — especially important after stale recovery where
        // the status just changed from "running" or "error" to a new value.
        //
        // Use "awaiting_input" when the session has a pending attention, because
        // that state is never written to the DB record (it's a live-only signal)
        // so record.status would otherwise emit a misleading "running" status.
        const hasPendingAttention = session.pendingAttentionList().length > 0;
        send({
          type: "chat_status",
          chatId,
          status: hasPendingAttention ? "awaiting_input" : record.status,
          sessionId: record.sessionId,
        });
      }
    }
    if (existing) return;
    const unsubscribe = session.subscribe(send);
    subscriptions.set(chatId, { repoPath, chatId, unsubscribe });
  };

  const unsubscribe = (chatId: string) => {
    const sub = subscriptions.get(chatId);
    if (!sub) return;
    sub.unsubscribe();
    subscriptions.delete(chatId);
  };

  ws.on("message", async (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      send({ type: "error", chatId: "", message: "Invalid JSON" });
      return;
    }

    try {
      switch (msg.type) {
        case "subscribe":
          await subscribe(msg.repoPath, msg.chatId, msg.withReplay !== false);
          break;
        case "unsubscribe":
          unsubscribe(msg.chatId);
          break;
        case "user_message": {
          await subscribe(msg.repoPath, msg.chatId, false);
          const session = getSession(msg.repoPath, msg.chatId);
          // runTurn rejects if a turn is already running. Surface that as an
          // error event rather than crashing the connection.
          session
            .runTurn({
              text: msg.text,
              model: msg.model,
              permissionMode: msg.permissionMode ?? "default",
              attachments: msg.attachments,
              isRetry: msg.isRetry,
            })
            .catch((err) => {
              send({
                type: "error",
                chatId: msg.chatId,
                message: err instanceof Error ? err.message : String(err),
              });
            });
          break;
        }
        case "permission_response": {
          const sub = subscriptions.get(msg.chatId);
          if (!sub) break;
          const session = getSession(sub.repoPath, msg.chatId);
          session.resolvePermission(msg.requestId, msg.result);
          break;
        }
        case "attention_ack": {
          const sub = subscriptions.get(msg.chatId);
          if (!sub) break;
          const session = getSession(sub.repoPath, msg.chatId);
          session.resolveAttentionAck(msg.attentionId, {
            feedback: msg.feedback,
            interrupt: msg.interrupt,
          });
          break;
        }
        case "interrupt": {
          const sub = subscriptions.get(msg.chatId);
          if (!sub) break;
          const session = getSession(sub.repoPath, msg.chatId);
          session.interrupt();
          break;
        }
        case "set_permission_mode": {
          const sub = subscriptions.get(msg.chatId);
          if (!sub) break;
          const session = getSession(sub.repoPath, msg.chatId);
          session.setPermissionMode(msg.permissionMode);
          break;
        }
        case "fork_message": {
          await subscribe(msg.repoPath, msg.chatId, false);
          const session = getSession(msg.repoPath, msg.chatId);
          session
            .runFork({
              userMessageId: msg.userMessageId,
              newText: msg.newText,
              attachments: msg.attachments,
              model: msg.model,
              permissionMode: msg.permissionMode ?? "default",
            })
            .catch((err) => {
              send({
                type: "error",
                chatId: msg.chatId,
                message: err instanceof Error ? err.message : String(err),
              });
            });
          break;
        }
        case "switch_branch": {
          const sub = subscriptions.get(msg.chatId);
          if (!sub) break;
          const session = getSession(sub.repoPath, msg.chatId);
          session
            .runSwitchBranch({
              parentMessageId: msg.parentMessageId,
              targetBranchId: msg.targetBranchId,
            })
            .catch((err) => {
              send({
                type: "error",
                chatId: msg.chatId,
                message: err instanceof Error ? err.message : String(err),
              });
            });
          break;
        }
        case "revert_to_checkpoint": {
          await subscribe(msg.repoPath, msg.chatId, false);
          const session = getSession(msg.repoPath, msg.chatId);
          session
            .runRevert(msg.checkpointId)
            .catch((err) => {
              send({
                type: "error",
                chatId: msg.chatId,
                message: err instanceof Error ? err.message : String(err),
              });
            });
          break;
        }
      }
    } catch (err) {
      send({
        type: "error",
        chatId: (msg as { chatId?: string }).chatId ?? "",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  ws.on("close", () => {
    for (const [, sub] of subscriptions) sub.unsubscribe();
    subscriptions.clear();
    // Sessions deliberately survive WS disconnects — closing the browser
    // leaves the agent running, and reopening replays from disk.
  });
});

// ---- Orchestrator WebSocket ----
// Single global orchestrator session; many clients (typically just one tab)
// can subscribe and all see the same event stream. Closing the WS does NOT
// reset the session — refreshing the browser keeps the orchestrator's
// memory of recent navigation.
const orchWss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  const url = req.url ?? "";
  const pathname = url.split("?")[0];
  if (pathname === "/agent") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else if (pathname === "/orchestrator") {
    orchWss.handleUpgrade(req, socket, head, (ws) => {
      orchWss.emit("connection", ws, req);
    });
  } else if (pathname === "/terminal") {
    terminalWss.handleUpgrade(req, socket, head, (ws) => {
      terminalWss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

orchWss.on("connection", (ws: WebSocket) => {
  const orchestrator = getOrchestrator();

  const send = (event: OrchestratorEvent) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
  };

  const unsubscribe = orchestrator.subscribe(send);

  ws.on("message", (raw) => {
    let msg: OrchestratorClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as OrchestratorClientMessage;
    } catch {
      send({ type: "error", message: "Invalid JSON" });
      return;
    }
    switch (msg.type) {
      case "user_message":
        orchestrator.enqueue(msg.text, msg.activeRepoPath ?? null);
        break;
      case "interrupt":
        orchestrator.interrupt();
        break;
      case "reset":
        orchestrator.reset();
        break;
    }
  });

  ws.on("close", () => {
    unsubscribe();
  });
});

httpServer.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[server] listening on http://localhost:${PORT}`);
  console.log(`[server] websocket at ws://localhost:${PORT}/agent`);
  void recoverStaleChats();
  void startScheduler();
  startSelfUpdateChecker();
});

// Walk every recent repo and patch chats whose persisted state is "running"
// or has unresolved permission requests — leftovers from a previous server
// process that died mid-turn. After healing, automatically re-run each
// interrupted turn so agents resume without the user having to click anything.
async function recoverStaleChats(): Promise<void> {
  try {
    const recents = await listRecents();
    let total = 0;
    for (const r of recents) {
      try {
        const healedIds = await recoverStaleChatsForRepoWithIds(r.path);
        total += healedIds.length;
        // Fire retries in the background — don't await so one slow agent
        // doesn't block recovery of the remaining repos/chats.
        for (const chatId of healedIds) {
          const session = getSession(r.path, chatId);
          session.retryAfterRestart().catch((err) => {
            console.warn(
              `[server] retry failed for ${chatId}:`,
              err instanceof Error ? err.message : err,
            );
          });
        }
      } catch (err) {
        console.warn(
          `[server] recovery skipped for ${r.path}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    if (total > 0) console.log(`[server] recovered and retrying ${total} stale chat(s)`);
  } catch (err) {
    console.warn(
      "[server] stale-chat recovery failed:",
      err instanceof Error ? err.message : err,
    );
  }
}
