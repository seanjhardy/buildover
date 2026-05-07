import { useCallback, useEffect, useRef, useState } from "react";
import { agentSocket, type Connection } from "../lib/agentSocket.js";
import type {
  AgentEvent,
  Attachment,
  ChatEvent,
  ChatRecord,
  ChatStatus,
  ContentBlock,
  McpServerInfo,
  Model,
  PermissionMode,
} from "../types.js";

export type ChatTurn =
  | { kind: "user"; id: string; text: string; attachments?: Attachment[] }
  | { kind: "assistant"; id: string; content: ContentBlock[] }
  | { kind: "tool_results"; id: string; content: ContentBlock[] }
  | {
      kind: "result";
      id: string;
      subtype: string;
      durationMs: number;
      totalCostUsd?: number;
      numTurns: number;
    };

export interface PendingPermission {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  suggestions: unknown[];
}

interface SendOptions {
  model: Model;
  permissionMode: PermissionMode;
  attachments?: Attachment[];
}

interface UseAgentReturn {
  turns: ChatTurn[];
  connection: Connection;
  isStreaming: boolean;
  sessionId: string | undefined;
  tools: string[];
  mcpServers: McpServerInfo[];
  cwd: string | undefined;
  status: ChatStatus | null;
  pendingPermission: PendingPermission | undefined;
  send: (text: string, opts: SendOptions) => void;
  respondPermission: (
    requestId: string,
    result:
      | {
          behavior: "allow";
          updatedInput?: Record<string, unknown>;
          updatedPermissions?: unknown[];
        }
      | { behavior: "deny"; message: string; interrupt?: boolean },
  ) => void;
  interrupt: () => void;
}

export function useAgent(
  repoPath: string | null,
  chatId: string | null,
): UseAgentReturn {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [tools, setTools] = useState<string[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([]);
  const [cwd, setCwd] = useState<string | undefined>();
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [pendingPermission, setPendingPermission] =
    useState<PendingPermission | undefined>();
  // Mirror state in refs so handlers can read without re-subscribing.
  const chatIdRef = useRef(chatId);
  chatIdRef.current = chatId;

  useEffect(() => agentSocket.onConnection(setConnection), []);

  useEffect(() => {
    if (!repoPath || !chatId) {
      setTurns([]);
      setIsStreaming(false);
      setSessionId(undefined);
      setTools([]);
      setMcpServers([]);
      setCwd(undefined);
      setStatus(null);
      setPendingPermission(undefined);
      return;
    }

    const handler = (event: AgentEvent) => {
      // Defensive: events may arrive after we've switched chats. The
      // multiplexer routes by chatId so this should be impossible, but ignore
      // anyway if the active chatId no longer matches.
      if (event.chatId !== chatIdRef.current) return;
      applyAgentEvent(event, {
        setTurns,
        setIsStreaming,
        setSessionId,
        setTools,
        setMcpServers,
        setCwd,
        setStatus,
        setPendingPermission,
      });
    };

    const unsubscribeListener = agentSocket.onChatEvent(chatId, handler);
    agentSocket.send({
      type: "subscribe",
      chatId,
      repoPath,
      withReplay: true,
    });

    return () => {
      unsubscribeListener();
      // We keep the subscription on the server (other hooks like useChats
      // still want status updates). agentSocket cleans up the server-side
      // subscription only when the last listener for this chat is gone.
    };
  }, [repoPath, chatId]);

  const send = useCallback(
    (text: string, opts: SendOptions) => {
      if (!repoPath || !chatId) return;
      agentSocket.send({
        type: "user_message",
        chatId,
        repoPath,
        text,
        model: opts.model,
        permissionMode: opts.permissionMode,
        attachments: opts.attachments,
      });
    },
    [repoPath, chatId],
  );

  const respondPermission = useCallback<UseAgentReturn["respondPermission"]>(
    (requestId, result) => {
      const id = chatIdRef.current;
      if (!id) return;
      agentSocket.send({
        type: "permission_response",
        chatId: id,
        requestId,
        result,
      });
      setPendingPermission((p) =>
        p?.requestId === requestId ? undefined : p,
      );
    },
    [],
  );

  const interrupt = useCallback(() => {
    const id = chatIdRef.current;
    if (!id) return;
    agentSocket.send({ type: "interrupt", chatId: id });
  }, []);

  return {
    turns,
    connection,
    isStreaming,
    sessionId,
    tools,
    mcpServers,
    cwd,
    status,
    pendingPermission,
    send,
    respondPermission,
    interrupt,
  };
}

interface Setters {
  setTurns: React.Dispatch<React.SetStateAction<ChatTurn[]>>;
  setIsStreaming: React.Dispatch<React.SetStateAction<boolean>>;
  setSessionId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setTools: React.Dispatch<React.SetStateAction<string[]>>;
  setMcpServers: React.Dispatch<React.SetStateAction<McpServerInfo[]>>;
  setCwd: React.Dispatch<React.SetStateAction<string | undefined>>;
  setStatus: React.Dispatch<React.SetStateAction<ChatStatus | null>>;
  setPendingPermission: React.Dispatch<
    React.SetStateAction<PendingPermission | undefined>
  >;
}

function applyAgentEvent(event: AgentEvent, s: Setters): void {
  switch (event.type) {
    case "chat_replay": {
      hydrateFromRecord(event.record, s);
      // Restore any in-flight permission request the server is still waiting on.
      const first = event.pendingPermissions[0];
      s.setPendingPermission(
        first
          ? {
              requestId: first.requestId,
              toolName: first.toolName,
              input: first.input,
              suggestions: first.suggestions ?? [],
            }
          : undefined,
      );
      s.setStatus(event.record.status);
      s.setIsStreaming(event.record.status === "running");
      break;
    }
    case "system_init":
      s.setSessionId(event.sessionId || undefined);
      s.setTools(event.tools);
      s.setMcpServers(event.mcpServers);
      s.setCwd(event.cwd);
      break;
    case "user_message_echo":
      s.setTurns((prev) => [
        ...prev,
        {
          kind: "user",
          id: event.id,
          text: event.text,
          attachments: event.attachments,
        },
      ]);
      break;
    case "assistant":
      s.setTurns((prev) => [
        ...prev,
        { kind: "assistant", id: event.uuid, content: event.content },
      ]);
      break;
    case "user_tool_results":
      s.setTurns((prev) => [
        ...prev,
        { kind: "tool_results", id: event.uuid, content: event.content },
      ]);
      break;
    case "result":
      s.setSessionId(event.sessionId || undefined);
      s.setTurns((prev) => [
        ...prev,
        {
          kind: "result",
          id: `result-${Date.now()}`,
          subtype: event.subtype,
          durationMs: event.durationMs,
          totalCostUsd: event.totalCostUsd,
          numTurns: event.numTurns,
        },
      ]);
      break;
    case "permission_request":
      s.setPendingPermission({
        requestId: event.requestId,
        toolName: event.toolName,
        input: event.input,
        suggestions: event.suggestions ?? [],
      });
      break;
    case "error":
      s.setTurns((prev) => [
        ...prev,
        {
          kind: "assistant",
          id: `err-${Date.now()}`,
          content: [{ type: "text", text: `**Error:** ${event.message}` }],
        },
      ]);
      break;
    case "turn_start":
      s.setIsStreaming(true);
      break;
    case "turn_end":
      s.setIsStreaming(false);
      s.setPendingPermission(undefined);
      break;
    case "chat_status":
      s.setStatus(event.status);
      if (event.sessionId) s.setSessionId(event.sessionId);
      // Running ⇔ a turn is in progress for the agent.
      if (event.status === "running") s.setIsStreaming(true);
      else if (event.status !== "awaiting_input") s.setIsStreaming(false);
      break;
    case "chat_title":
      // Title isn't displayed inside the chat body, but other consumers (the
      // sidebar) handle this event in their own subscriptions.
      break;
  }
}

function hydrateFromRecord(record: ChatRecord, s: Setters): void {
  const turns: ChatTurn[] = [];
  let initSeen = false;
  for (const ev of record.events) {
    const t = chatEventToTurn(ev);
    if (t) turns.push(t);
    if (!initSeen && ev.type === "system_init") {
      initSeen = true;
      s.setSessionId(ev.sessionId || undefined);
      s.setTools(ev.tools);
      s.setMcpServers(ev.mcpServers);
      s.setCwd(ev.cwd);
    }
  }
  s.setTurns(turns);
  if (record.sessionId) s.setSessionId(record.sessionId);
}

function chatEventToTurn(ev: ChatEvent): ChatTurn | null {
  switch (ev.type) {
    case "user_message":
      return {
        kind: "user",
        id: ev.id,
        text: ev.text,
        attachments: ev.attachments,
      };
    case "assistant":
      return { kind: "assistant", id: ev.uuid, content: ev.content };
    case "user_tool_results":
      return { kind: "tool_results", id: ev.uuid, content: ev.content };
    case "result":
      return {
        kind: "result",
        id: `r-${ev.ts}`,
        subtype: ev.subtype,
        durationMs: ev.durationMs,
        totalCostUsd: ev.totalCostUsd,
        numTurns: ev.numTurns,
      };
    case "error":
      return {
        kind: "assistant",
        id: `e-${ev.ts}`,
        content: [{ type: "text", text: `**Error:** ${ev.message}` }],
      };
    default:
      return null;
  }
}
