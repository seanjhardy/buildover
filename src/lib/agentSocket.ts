import type { AgentEvent, ClientMessage } from "../types.js";
import { wsUrl } from "./serverOrigin.js";

export type Connection = "connecting" | "connected" | "error" | "closed";

const WS_URL = wsUrl("/agent");

// How often to send an application-level ping while the socket is idle, and how
// long to wait for any reply before deciding the pipe is dead. A WebSocket whose
// TCP connection dies while the laptop sleeps or wifi drops frequently stays in
// the OPEN readyState — no close/error event ever fires — so this heartbeat is
// the only reliable way for the client to notice and reconnect.
const HEARTBEAT_INTERVAL_MS = 15000;
const PONG_TIMEOUT_MS = 8000;

type ConnectionListener = (c: Connection) => void;
type EventListener = (event: AgentEvent) => void;
type ReconnectListener = () => void;

// Single shared WebSocket connection for all chats. Multiplexes events to
// per-chat subscribers based on the chatId field on each AgentEvent. Survives
// the lifetime of the page; reconnects with backoff if the server drops.
class AgentSocket {
  private ws: WebSocket | null = null;
  private connection: Connection = "connecting";
  private connectionListeners = new Set<ConnectionListener>();
  private eventListeners = new Map<string, Set<EventListener>>();
  // Fired once each time the socket successfully re-connects after having been
  // closed/errored (i.e. not the very first connection).
  private reconnectListeners = new Set<ReconnectListener>();
  private hasConnectedBefore = false;
  // Pending sends queued while the socket is opening or reconnecting. Most
  // operations don't need this (we render based on REST state first), but
  // subscribe/unsubscribe messages do — they must reach the server eventually.
  private outbox: ClientMessage[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelayMs = 500;
  // Heartbeat: a repeating ping while OPEN, plus a one-shot timer that fires if
  // no reply (pong or any other traffic) arrives — meaning the pipe is dead.
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.connect();
    this.registerLivenessListeners();
  }

  private setConnection(c: Connection): void {
    if (this.connection === c) return;
    this.connection = c;
    for (const fn of this.connectionListeners) fn(c);
  }

  private connect(): void {
    this.stopHeartbeat();
    this.setConnection("connecting");
    const ws = new WebSocket(WS_URL);
    this.ws = ws;
    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      const isReconnect = this.hasConnectedBefore;
      this.hasConnectedBefore = true;
      this.setConnection("connected");
      this.retryDelayMs = 500;
      this.startHeartbeat();
      // Re-subscribe to anything that has a listener.
      for (const chatId of this.eventListeners.keys()) {
        const sub = this.activeSubscriptions.get(chatId);
        if (sub) ws.send(JSON.stringify(sub));
      }
      while (this.outbox.length > 0) {
        const msg = this.outbox.shift();
        if (msg) ws.send(JSON.stringify(msg));
      }
      // Notify reconnect listeners *after* re-subscriptions are flushed so
      // the server has already received the subscribe messages before any
      // retry turn is sent.
      if (isReconnect) {
        for (const fn of this.reconnectListeners) {
          try { fn(); } catch { /* listener crash must not break socket */ }
        }
      }
    });
    ws.addEventListener("error", () => {
      if (this.ws !== ws) return;
      this.setConnection("error");
    });
    ws.addEventListener("close", () => {
      if (this.ws !== ws) return;
      this.setConnection("closed");
      this.scheduleReconnect();
    });
    ws.addEventListener("message", (ev) => {
      if (this.ws !== ws) return;
      // Any inbound frame is proof the pipe is alive — cancel the pending
      // liveness timeout regardless of the message's contents.
      if (this.pongTimer) {
        clearTimeout(this.pongTimer);
        this.pongTimer = null;
      }
      let parsed: AgentEvent | { type: "pong" };
      try {
        parsed = JSON.parse(ev.data) as AgentEvent | { type: "pong" };
      } catch {
        return;
      }
      // Connection-level pong: consumed here, never routed to chat listeners.
      if (parsed.type === "pong") return;
      const event = parsed;
      const listeners = this.eventListeners.get((event as { chatId: string }).chatId);
      if (!listeners) return;
      for (const fn of listeners) {
        try {
          fn(event);
        } catch {
          // Listener crashes must not break the multiplexer.
        }
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.retryTimer) return;
    const delay = Math.min(this.retryDelayMs, 8000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryDelayMs = Math.min(this.retryDelayMs * 2, 8000);
      this.connect();
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.sendPing(), HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  /** Probe the socket. Sends a ping and arms a timeout; if no frame of any kind
   *  arrives before it fires, the connection is dead and we tear it down and
   *  reconnect. The message handler clears pongTimer on any inbound traffic. */
  private sendPing(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (this.pongTimer) return; // a probe is already in flight
    try {
      ws.send(JSON.stringify({ type: "ping" }));
    } catch {
      this.reconnectNow();
      return;
    }
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null;
      this.reconnectNow();
    }, PONG_TIMEOUT_MS);
  }

  /** Reconnect proactively when the machine wakes or the network returns. On a
   *  fresh OPEN socket that silently died during sleep, readyState still reads
   *  OPEN, so we can't trust it — probe with a ping and let the timeout catch a
   *  dead pipe. When the socket is already closed/closing, reconnect now rather
   *  than waiting out the backoff timer. */
  private checkConnectionHealth(): void {
    const ws = this.ws;
    if (
      !ws ||
      ws.readyState === WebSocket.CLOSED ||
      ws.readyState === WebSocket.CLOSING
    ) {
      this.reconnectNow();
      return;
    }
    if (ws.readyState === WebSocket.CONNECTING) return; // let it finish
    this.sendPing();
  }

  private registerLivenessListeners(): void {
    if (typeof window === "undefined") return;
    const check = () => this.checkConnectionHealth();
    window.addEventListener("online", check);
    window.addEventListener("focus", check);
    window.addEventListener("pageshow", check);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") check();
      });
    }
  }

  // Tracks the most recent subscription parameters per chatId so we can
  // replay them on reconnect.
  private activeSubscriptions = new Map<string, ClientMessage>();

  send(msg: ClientMessage): void {
    if (msg.type === "subscribe") {
      this.activeSubscriptions.set(msg.chatId, msg);
    } else if (msg.type === "unsubscribe") {
      this.activeSubscriptions.delete(msg.chatId);
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.outbox.push(msg);
    }
  }

  onConnection(fn: ConnectionListener): () => void {
    this.connectionListeners.add(fn);
    fn(this.connection);
    return () => this.connectionListeners.delete(fn);
  }

  /** Register a listener that fires each time the socket successfully
   *  re-connects after a drop (not on the initial connection). */
  onReconnect(fn: ReconnectListener): () => void {
    this.reconnectListeners.add(fn);
    return () => this.reconnectListeners.delete(fn);
  }

  /** Cancel any pending retry timer and immediately attempt a new connection.
   *  Useful for a manual "reconnect" button in the UI. */
  reconnectNow(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryDelayMs = 500;
    if (this.ws) {
      this.ws.close();
    }
    this.connect();
  }

  onChatEvent(chatId: string, fn: EventListener): () => void {
    let set = this.eventListeners.get(chatId);
    if (!set) {
      set = new Set();
      this.eventListeners.set(chatId, set);
    }
    set.add(fn);
    return () => {
      set?.delete(fn);
      if (set && set.size === 0) {
        this.eventListeners.delete(chatId);
        this.activeSubscriptions.delete(chatId);
      }
    };
  }
}

export const agentSocket = new AgentSocket();
