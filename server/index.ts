import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  createChat,
  deleteChat,
  listChats,
  readChat,
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
import { fetchUsage } from "./usage.js";
import type {
  AgentEvent,
  ClientMessage,
  Model,
  PermissionMode,
} from "../src/types.js";

const PORT = Number(process.env.PORT ?? 8787);

const app = express();
app.use(express.json({ limit: "10mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

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
    const ext = mime.includes("ogg") ? "ogg" : mime.includes("mp4") ? "m4a" : "webm";
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

// ---- WebSocket multiplexer ----
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/agent" });

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
      const record = await readChat(repoPath, chatId);
      if (record) {
        send({
          type: "chat_replay",
          chatId,
          record,
          pendingPermissions: session.pendingPermissionList(),
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
        case "interrupt": {
          const sub = subscriptions.get(msg.chatId);
          if (!sub) break;
          const session = getSession(sub.repoPath, msg.chatId);
          session.interrupt();
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

httpServer.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[server] listening on http://localhost:${PORT}`);
  console.log(`[server] websocket at ws://localhost:${PORT}/agent`);
});
