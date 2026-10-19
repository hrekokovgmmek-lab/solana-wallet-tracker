/**
 * Reconnect delays for a websocket feed.
 *
 * A feed provider that sees the same address reconnect every few seconds may
 * start refusing it. So the delay grows exponentially with jitter, and it only
 * resets after a connection has stayed up for `stableMs` — a socket that opens
 * and drops at once does not count as recovered.
 */
export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  stableMs?: number;
  jitter?: number;
  rand?: () => number;
}

export class Backoff {
  private attempt = 0;
  private openedAt: number | null = null;
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly stableMs: number;
  private readonly jitter: number;
  private readonly rand: () => number;

  constructor(o: BackoffOptions = {}) {
    this.baseMs = o.baseMs ?? 5_000;
    this.maxMs = o.maxMs ?? 300_000;
    this.stableMs = o.stableMs ?? 60_000;
    this.jitter = o.jitter ?? 0.2;
    this.rand = o.rand ?? Math.random;
  }

  /** The socket opened. */
  opened(now = Date.now()): void {
    this.openedAt = now;
  }

  /** Delay before the next connection attempt. Call on every close. */
  next(now = Date.now()): { delayMs: number; healthy: boolean; attempt: number } {
    const healthy = this.openedAt !== null && now - this.openedAt >= this.stableMs;
    if (healthy) this.attempt = 0;
    this.openedAt = null;
    const raw = Math.min(this.maxMs, this.baseMs * 2 ** this.attempt);
    if (this.attempt < 30) this.attempt++;
    const spread = 1 + this.jitter * (2 * this.rand() - 1);
    return { delayMs: Math.round(Math.min(this.maxMs, raw * spread)), healthy, attempt: this.attempt };
  }
}
