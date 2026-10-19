import { Backoff } from "./backoff.ts";

/** The slice of the WebSocket API this module uses — the real one or a test double. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (ev: { data?: unknown }) => void): void;
}

export type SocketFactory = (url: string) => SocketLike;

export interface StreamOptions {
  url: string;
  wallets: string[];
  /** A transaction mentioning a watched wallet was confirmed. */
  onActivity: (wallet: string, signature: string, failed: boolean) => void;
  log?: (msg: string) => void;
  backoff?: Backoff;
  /** Reconnect when no slot notification arrived for this long. */
  heartbeatMs?: number;
  socketFactory?: SocketFactory;
}

const HEARTBEAT_ID = 0;

/**
 * One WebSocket to a Solana RPC node with a `logsSubscribe` per watched wallet.
 *
 * A `slotSubscribe` runs alongside as a heartbeat: slots arrive several times a
 * second, so a socket that stays "open" but has stopped delivering is noticed
 * within a minute and replaced. After every reconnect all wallets are
 * subscribed again; a signature seen twice for the same wallet is reported once.
 */
export class WalletStream {
  private socket?: SocketLike;
  private subscriptions = new Map<number, string>();
  private seen = new Set<string>();
  private lastBeat = 0;
  private heartbeat?: NodeJS.Timeout;
  private reconnect?: NodeJS.Timeout;
  private stopped = true;
  private readonly backoff: Backoff;
  private readonly log: (msg: string) => void;
  private readonly factory: SocketFactory;

  constructor(private readonly o: StreamOptions) {
    this.backoff = o.backoff ?? new Backoff();
    this.log = o.log ?? (() => undefined);
    this.factory = o.socketFactory ?? ((url) => new WebSocket(url) as unknown as SocketLike);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnect);
    clearInterval(this.heartbeat);
    this.socket?.close();
  }

  private connect(): void {
    const socket = this.factory(this.o.url);
    this.socket = socket;
    this.subscriptions.clear();
    socket.addEventListener("open", () => {
      this.backoff.opened();
      this.lastBeat = Date.now();
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: HEARTBEAT_ID, method: "slotSubscribe" }));
      this.o.wallets.forEach((wallet, i) => {
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: i + 1,
            method: "logsSubscribe",
            params: [{ mentions: [wallet] }, { commitment: "confirmed" }],
          }),
        );
      });
      this.log(`connected, watching ${this.o.wallets.length} wallet(s)`);
      this.watchHeartbeat(socket);
    });
    socket.addEventListener("message", (ev) => this.onMessage(typeof ev.data === "string" ? ev.data : String(ev.data)));
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      clearInterval(this.heartbeat);
      if (this.stopped) return;
      const b = this.backoff.next();
      this.log(`disconnected; reconnecting in ${Math.round(b.delayMs / 1000)} s`);
      this.reconnect = setTimeout(() => this.connect(), b.delayMs);
    });
    socket.addEventListener("error", () => undefined);
  }

  /** Exposed for tests: one raw message from the node. */
  onMessage(raw: string): void {
    let m: { id?: number; result?: unknown; method?: string; params?: { subscription?: number; result?: unknown } };
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof m.id === "number" && typeof m.result === "number") {
      if (m.id === HEARTBEAT_ID) return;
      const wallet = this.o.wallets[m.id - 1];
      if (wallet) this.subscriptions.set(m.result, wallet);
      return;
    }
    if (m.method === "slotNotification") {
      this.lastBeat = Date.now();
      return;
    }
    if (m.method === "logsNotification" && typeof m.params?.subscription === "number") {
      const wallet = this.subscriptions.get(m.params.subscription);
      const value = (m.params.result as { value?: { signature?: string; err?: unknown } } | undefined)?.value;
      if (!wallet || !value?.signature) return;
      const key = `${wallet}:${value.signature}`;
      if (this.seen.has(key)) return;
      this.seen.add(key);
      if (this.seen.size > 10_000) this.seen = new Set([...this.seen].slice(-5_000));
      this.o.onActivity(wallet, value.signature, value.err !== null && value.err !== undefined);
    }
  }

  private watchHeartbeat(socket: SocketLike): void {
    const limit = this.o.heartbeatMs ?? 60_000;
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastBeat > limit) {
        this.log(`no slot updates for ${Math.round(limit / 1000)} s — reconnecting`);
        socket.close();
      }
    }, Math.min(10_000, limit));
  }
}
