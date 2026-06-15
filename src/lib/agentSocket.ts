import type { AgentEvent, ClientMessage } from "../types.js";
import { wsUrl } from "./serverOrigin.js";

export type Connection = "connecting" | "connected" | "error" | "closed";

const WS_URL = wsUrl("/agent");

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

  constructor() {
    this.connect();
  }

  private setConnection(c: Connection): void {
    if (this.connection === c) return;
    this.connection = c;
    for (const fn of this.connectionListeners) fn(c);
  }

  private connect(): void {
    this.setConnection("connecting");
    const ws = new WebSocket(WS_URL);
    this.ws = ws;
    ws.addEventListener("open", () => {
      const isReconnect = this.hasConnectedBefore;
      this.hasConnectedBefore = true;
      this.setConnection("connected");
      this.retryDelayMs = 500;
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
    ws.addEventListener("error", () => this.setConnection("error"));
    ws.addEventListener("close", () => {
      this.setConnection("closed");
      this.scheduleReconnect();
    });
    ws.addEventListener("message", (ev) => {
      let event: AgentEvent;
      try {
        event = JSON.parse(ev.data) as AgentEvent;
      } catch {
        return;
      }
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
    if (this.ws) {
      this.ws.close();
      this.ws = null;
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
