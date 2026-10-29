/**
 * Optional cap on concurrently running agent turns. Unlimited by default: start
 * as many chats as you like and they all run at once. Setting the
 * maxConcurrentTurns pref to a positive number turns the cap back on, in which
 * case extra turns wait FIFO and each running turn holds one slot.
 *
 * Nothing else depends on this being bounded: plan/usage limits are handled
 * separately (queueForUsageLimit parks a turn when the account is out of
 * usage), and the CLI retries transient rate limits itself (surfaced as a
 * non-fatal chat_notice), so queueing here would not prevent either.
 *
 * Why a cap cannot deadlock when one is set: a slot is only ever waited on by a
 * turn that has not started, and slots are only freed by turns ending (or
 * pausing for user input — see AgentSession.suspendSlot). No turn blocks on
 * another chat's turn while holding a slot: spawn_subagent,
 * send_message_to_subagent and report_to_parent all fire-and-forget the other
 * chat's runTurn (or park the message) and return immediately; the SDK's own
 * Agent-tool subagents run inside the parent chat's CLI process and never take
 * a slot. So the "waits for" graph has no edges between turns, and therefore no
 * cycles.
 */

/** No cap unless the user opts into one (`<= 0` means unlimited). */
export const DEFAULT_MAX_CONCURRENT_TURNS = 0;

interface Waiter {
  resolve: (acquired: boolean) => void;
  onPosition?: (position: number) => void;
  lastPosition: number;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface AcquireOptions {
  /** Aborting while queued removes the waiter and resolves false. */
  signal?: AbortSignal;
  /** Jump the queue (a turn resuming after it released its slot to wait for
   *  the user already has in-flight state, so it should not requeue behind
   *  brand-new turns). */
  front?: boolean;
  /** Called when the waiter's 1-based queue position changes (also on enqueue). */
  onPosition?: (position: number) => void;
}

export class TurnSlots {
  private running = 0;
  private waiters: Waiter[] = [];

  constructor(private max = DEFAULT_MAX_CONCURRENT_TURNS) {}

  /** `max <= 0` (or non-finite) means unlimited. */
  setMax(max: number | undefined): void {
    const next = typeof max === "number" && Number.isFinite(max) ? Math.floor(max) : DEFAULT_MAX_CONCURRENT_TURNS;
    if (next === this.max) return;
    this.max = next;
    this.pump();
  }

  get limit(): number {
    return this.max;
  }

  get stats(): { running: number; max: number; queued: number } {
    return { running: this.running, max: this.max, queued: this.waiters.length };
  }

  private hasCapacity(): boolean {
    return this.max <= 0 || this.running < this.max;
  }

  /** Takes a slot only if one is free right now (and nobody is queued ahead). */
  tryAcquire(): boolean {
    if (this.waiters.length === 0 && this.hasCapacity()) {
      this.running++;
      return true;
    }
    return false;
  }

  acquire(opts: AcquireOptions = {}): Promise<boolean> {
    if (opts.signal?.aborted) return Promise.resolve(false);
    if (this.waiters.length === 0 && this.hasCapacity()) {
      this.running++;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const waiter: Waiter = {
        resolve,
        onPosition: opts.onPosition,
        lastPosition: 0,
        signal: opts.signal,
      };
      if (opts.signal) {
        waiter.onAbort = () => {
          const i = this.waiters.indexOf(waiter);
          if (i === -1) return;
          this.waiters.splice(i, 1);
          resolve(false);
          this.notifyPositions();
        };
        opts.signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      if (opts.front) this.waiters.unshift(waiter);
      else this.waiters.push(waiter);
      this.notifyPositions();
    });
  }

  release(): void {
    if (this.running > 0) this.running--;
    this.pump();
  }

  private pump(): void {
    let granted = false;
    while (this.waiters.length > 0 && this.hasCapacity()) {
      const waiter = this.waiters.shift()!;
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      this.running++;
      granted = true;
      waiter.resolve(true);
    }
    if (granted || this.waiters.length > 0) this.notifyPositions();
  }

  private notifyPositions(): void {
    this.waiters.forEach((waiter, i) => {
      const position = i + 1;
      if (waiter.lastPosition === position) return;
      waiter.lastPosition = position;
      try {
        waiter.onPosition?.(position);
      } catch {
        // A status-callback failure must not break the queue.
      }
    });
  }
}

/** The process-wide instance every AgentSession shares. */
export const turnSlots = new TurnSlots();
