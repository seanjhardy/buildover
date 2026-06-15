import type {
  OrchestratorClientMessage,
  OrchestratorEvent,
} from "../types.js";
import { wsUrl } from "./serverOrigin.js";

export type OrchestratorConnection =
  | "connecting"
  | "connected"
  | "error"
  | "closed";

const WS_URL = wsUrl("/orchestrator");

type ConnectionListener = (c: OrchestratorConnection) => void;
type EventListener = (event: OrchestratorEvent) => void;

// Single shared connection to the global orchestrator session. Survives the
// page lifetime; reconnects with backoff on drop. Unlike agentSocket there's
// no chat multiplexing — every event goes to every subscriber.
class OrchestratorSocket {
  private ws: WebSocket | null = null;
  private connection: OrchestratorConnection = "connecting";
  private connectionListeners = new Set<ConnectionListener>();
  private eventListeners = new Set<EventListener>();
  private outbox: OrchestratorClientMessage[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelayMs = 500;

  constructor() {
    this.connect();
  }

  private setConnection(c: OrchestratorConnection): void {
    if (this.connection === c) return;
    this.connection = c;
    for (const fn of this.connectionListeners) fn(c);
  }

  private connect(): void {
    this.setConnection("connecting");
    const ws = new WebSocket(WS_URL);
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.setConnection("connected");
      this.retryDelayMs = 500;
      while (this.outbox.length > 0) {
        const msg = this.outbox.shift();
        if (msg) ws.send(JSON.stringify(msg));
      }
    });
    ws.addEventListener("error", () => this.setConnection("error"));
    ws.addEventListener("close", () => {
      this.setConnection("closed");
      this.scheduleReconnect();
    });
    ws.addEventListener("message", (ev) => {
      let event: OrchestratorEvent;
      try {
        event = JSON.parse(ev.data) as OrchestratorEvent;
      } catch {
        return;
      }
      for (const fn of this.eventListeners) {
        try {
          fn(event);
        } catch {
          /* never let a listener crash break the socket */
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

  send(msg: OrchestratorClientMessage): void {
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

  onEvent(fn: EventListener): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }
}

export const orchestratorSocket = new OrchestratorSocket();
