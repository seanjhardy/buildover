import express from "express";
import { createServer } from "node:http";
import { readFile as fsReadFile } from "node:fs/promises";
import { WebSocketServer, type WebSocket } from "ws";
import {
  createChat,
  deleteChat,
  listChats,
  readChat,
  recoverStaleChatsForRepo,
  recoverStaleChatsForRepoWithIds,
  setTitle,
  setUserFinished,
} from "./chats.js";
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
  gitDiffStat,
  gitFileDiff,
  gitLog,
  gitCreateBranch,
} from "./git.js";
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

app.get("/api/usage", async (_req, res) => {
  try {
    res.json(await fetchUsage());
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
    res.json({ chats: await listChats(repoPath) });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.post("/api/chats", async (req, res) => {
  try {
    const repoPath = readRepoPath(req);
    const model = (req.body?.model as Model) ?? "claude-sonnet-4-6";
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
    const session = tryGetSession(repoPath, req.params.chatId);
    session?.interrupt();
    dropSession(repoPath, req.params.chatId);
    const ok = await deleteChat(repoPath, req.params.chatId);
    if (!ok) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
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

// ---- WebSocket multiplexer ----
const httpServer = createServer(app);
// Both WS endpoints use noServer mode so we can route a single `upgrade`
// event based on the URL path. Attaching multiple WebSocketServers to the
// same httpServer with `server:` causes the non-matching one to abort the
// handshake with a 400 on the already-upgraded socket, which kills the
// connection from the browser's side.
const wss = new WebSocketServer({ noServer: true });

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
        });
        // Always push chat_status after a replay so any sidebar subscriber
        // on this same WS connection (withReplay: false) picks up the current
        // status immediately — especially important after stale recovery where
        // the status just changed from "running" or "error" to a new value.
        send({
          type: "chat_status",
          chatId,
          status: record.status,
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
