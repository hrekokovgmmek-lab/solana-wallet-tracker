import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, maskSecrets, parseWallets, wsFromHttp } from "../src/config.ts";
import { pickHolderWallets } from "../src/holders.ts";
import { compact, formatConsole, formatTelegramHtml, shouldAlert } from "../src/report.ts";
import type { TradeEvent } from "../src/trade.ts";

const A = "6ym5E5hWbnvEQfiiMpPpCfMHHs64yEbg71fyLPRPvZmv";
const B = "33QjEoLi9cm6mwG3fWS9BBQ6abA1hnUghr1EqbrfS9XK";

test("wallet lists accept plain addresses and labelled entries, validate and dedupe", () => {
  assert.deepEqual(parseWallets(JSON.stringify([A, { address: B, label: "whale" }, A])), [
    { address: A },
    { address: B, label: "whale" },
  ]);
  assert.throws(() => parseWallets('[{"address":"PASTE_A_WALLET_ADDRESS_HERE"}]'), /not a Solana address/);
  assert.throws(() => parseWallets('{"address":"x"}'), /JSON array/);
});

test("config derives the websocket url and keeps secrets out of logs", () => {
  assert.equal(wsFromHttp("https://rpc.example/?api-key=1"), "wss://rpc.example/?api-key=1");
  assert.equal(wsFromHttp("http://localhost:8899"), "ws://localhost:8899");
  const c = loadConfig({ RPC_URL: "https://rpc.example", MIN_SOL: "0" });
  assert.equal(c.wsUrl, "wss://rpc.example");
  assert.equal(c.minSol, 0);
  assert.throws(() => loadConfig({ RPC_MAX_RPS: "0" }));
  assert.equal(maskSecrets("wss://rpc.example/?api-key=SECRET"), "wss://rpc.example/?api-key=***");
});

test("holder wallets: program accounts dropped, owners merged, ranked by share", () => {
  const supply = 1_000_000n;
  const picked = pickHolderWallets(
    [
      { owner: "POOL", amount: 500_000n, onCurve: false },
      { owner: A, amount: 100_000n, onCurve: true },
      { owner: B, amount: 120_000n, onCurve: true },
      { owner: A, amount: 50_000n, onCurve: true },
    ],
    supply,
    10,
  );
  assert.deepEqual(picked, [
    { address: A, label: "top-1 holder · 15.0%" },
    { address: B, label: "top-2 holder · 12.0%" },
  ]);
});

const event = (o: Partial<TradeEvent> = {}): TradeEvent => ({
  signature: "5QGRUZ4bqC2tahnRk5MH3nJJKhhYYCEppmV2fAQ13qob",
  wallet: A,
  side: "sell",
  mint: "DTaPDXwmwL5Pbzrg5PCHCRbp5ujeB7ra265zhNBmpump",
  tokenAmount: 5_726_182,
  solAmount: 2.1013,
  priceSol: 3.67e-7,
  slot: 1,
  blockTime: 1_792_400_000,
  ...o,
});

test("alerts: buys and sells by size, swaps always, transfers only on request", () => {
  assert.equal(shouldAlert(event({ solAmount: 0.05 }), 0.1), false);
  assert.equal(shouldAlert(event(), 0.1), true);
  assert.equal(shouldAlert(event({ side: "swap", solAmount: 0 }), 0.1), true);
  assert.equal(shouldAlert(event({ side: "transfer-in", solAmount: 0 }), 0.1), false);
  assert.equal(shouldAlert(event({ side: "transfer-in", solAmount: 0 }), 0.1, true), true);
});

test("formatting: compact numbers, labels, links", () => {
  assert.deepEqual([compact(1_234_567), compact(5_726_182), compact(1_500), compact(0.000123)], ["1.23M", "5.73M", "1.50K", "0.000123"]);
  assert.match(formatConsole(event(), { address: A, label: "dev" }), /^\[SELL\] dev \(6ym5…vZmv\) · 5\.73M DTaP…pump → 2\.101 SOL @ 3\.670e-7 SOL/);
  const html = formatTelegramHtml(event(), { address: A, label: "<dev>" });
  assert.match(html, /&lt;dev&gt;/);
  assert.match(html, /pump\.fun\/coin\/DTaPDXwmwL5Pbzrg5PCHCRbp5ujeB7ra265zhNBmpump/);
  assert.match(formatTelegramHtml(event({ mint: B }), { address: A }), /solscan\.io\/token\//);
  const usdc = event({ side: "buy", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", tokenAmount: 0.161, solAmount: 0.001 });
  assert.match(formatConsole(usdc, { address: A }), /→ 0\.161 USDC/);
});
