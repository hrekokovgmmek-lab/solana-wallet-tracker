import assert from "node:assert/strict";
import { test } from "node:test";
import { Backoff } from "../src/backoff.ts";
import { WalletStream, type SocketLike } from "../src/stream.ts";

class FakeSocket implements SocketLike {
  sent: string[] = [];
  private listeners: Record<string, ((ev: { data?: unknown }) => void)[]> = {};
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.emit("close");
  }
  addEventListener(type: "open" | "message" | "close" | "error", listener: (ev: { data?: unknown }) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  emit(type: string, data?: unknown): void {
    for (const l of this.listeners[type] ?? []) l({ data });
  }
}

function setup(wallets: string[], onActivity = (_w: string, _s: string, _f: boolean) => undefined) {
  const sockets: FakeSocket[] = [];
  const stream = new WalletStream({
    url: "wss://node",
    wallets,
    onActivity,
    backoff: new Backoff({ baseMs: 1, rand: () => 0.5 }),
    socketFactory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
  });
  return { stream, sockets };
}

const logs = (subscription: number, signature: string, err: unknown = null) =>
  JSON.stringify({ jsonrpc: "2.0", method: "logsNotification", params: { subscription, result: { value: { signature, err, logs: [] } } } });

test("on open: a slot heartbeat and one logsSubscribe per wallet", () => {
  const { stream, sockets } = setup(["A", "B"]);
  stream.start();
  sockets[0]!.emit("open");
  const msgs = sockets[0]!.sent.map((s) => JSON.parse(s));
  assert.equal(msgs[0].method, "slotSubscribe");
  assert.deepEqual(
    msgs.slice(1).map((m) => [m.method, m.params[0].mentions[0], m.params[1].commitment]),
    [
      ["logsSubscribe", "A", "confirmed"],
      ["logsSubscribe", "B", "confirmed"],
    ],
  );
  stream.stop();
});

test("notifications reach the right wallet once; failed ones are marked", () => {
  const seen: [string, string, boolean][] = [];
  const { stream, sockets } = setup(["A", "B"], (w, s, f) => void seen.push([w, s, f]));
  stream.start();
  sockets[0]!.emit("open");
  stream.onMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 77 }));
  stream.onMessage(JSON.stringify({ jsonrpc: "2.0", id: 2, result: 88 }));
  stream.onMessage(logs(88, "S1"));
  stream.onMessage(logs(88, "S1"));
  stream.onMessage(logs(77, "S2", { InstructionError: [0, "Custom"] }));
  stream.onMessage(logs(99, "S3"));
  stream.onMessage("not json");
  assert.deepEqual(seen, [
    ["B", "S1", false],
    ["A", "S2", true],
  ]);
  stream.stop();
});

test("after a dropped connection it reconnects and subscribes again", async () => {
  const { stream, sockets } = setup(["A"]);
  stream.start();
  sockets[0]!.emit("open");
  sockets[0]!.emit("close");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sockets.length, 2);
  sockets[1]!.emit("open");
  assert.ok(sockets[1]!.sent.some((s) => JSON.parse(s).method === "logsSubscribe"));
  stream.stop();
});

test("stop() does not reconnect", async () => {
  const { stream, sockets } = setup(["A"]);
  stream.start();
  sockets[0]!.emit("open");
  stream.stop();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sockets.length, 1);
});
