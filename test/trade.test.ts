import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { classify, tradeLamports, WSOL, type ParsedTx, type TokenBalance } from "../src/trade.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as ParsedTx;
const payer = (tx: ParsedTx) => tx.transaction.message.accountKeys[0]!.pubkey;
const near = (a: number, b: number, tol: number) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

// Real mainnet transactions (19 Oct 2026), trimmed to the fields the parser reads.
test("a real PumpSwap buy", () => {
  const tx = fixture("buy");
  const e = classify(tx, payer(tx))!;
  assert.equal(e.side, "buy");
  assert.ok(e.mint.endsWith("pump"));
  near(e.solAmount, 0.0124, 0.00006);
  near(e.tokenAmount, 17_036_495.34, 0.01);
  assert.ok(e.priceSol !== null && e.priceSol > 0);
});

test("a real PumpSwap sell", () => {
  const tx = fixture("sell");
  const e = classify(tx, payer(tx))!;
  assert.equal(e.side, "sell");
  near(e.solAmount, 2.1013, 0.00006);
  near(e.tokenAmount, 5_726_182, 0.01);
});

test("a wallet the transaction does not touch gets nothing", () => {
  assert.equal(classify(fixture("buy"), "11111111111111111111111111111111"), null);
});

const tb = (accountIndex: number, mint: string, owner: string, amount: string, decimals = 6): TokenBalance => ({
  accountIndex,
  mint,
  owner,
  uiTokenAmount: { amount, decimals },
});

function tx(o: {
  keys: string[];
  pre: number[];
  post: number[];
  fee?: number;
  err?: unknown;
  preTok?: TokenBalance[];
  postTok?: TokenBalance[];
}): ParsedTx {
  return {
    slot: 1,
    blockTime: 1_792_400_000,
    transaction: { signatures: ["SIG"], message: { accountKeys: o.keys.map((pubkey) => ({ pubkey })) } },
    meta: {
      err: o.err ?? null,
      fee: o.fee ?? 5_000,
      preBalances: o.pre,
      postBalances: o.post,
      preTokenBalances: o.preTok ?? [],
      postTokenBalances: o.postTok ?? [],
    },
  };
}

const RENT = 2_039_280;
const SOL = 1_000_000_000;

test("rent of a token account the buy creates is not counted as price", () => {
  const t = tx({
    keys: ["W", "ATA", "VAULT"],
    pre: [10 * SOL, 0, 50 * SOL],
    post: [10 * SOL - SOL - RENT - 5_000, RENT, 51 * SOL],
    postTok: [tb(1, "MINT", "W", "1000000000")],
  });
  assert.equal(tradeLamports(t, "W"), -SOL);
  const e = classify(t, "W")!;
  assert.equal(e.side, "buy");
  assert.equal(e.solAmount, 1);
  assert.equal(e.tokenAmount, 1000);
  assert.equal(e.priceSol, 0.001);
});

test("rent returned when a sell closes the token account is not counted as proceeds", () => {
  const t = tx({
    keys: ["W", "ATA", "VAULT"],
    pre: [5 * SOL, RENT, 50 * SOL],
    post: [5 * SOL + SOL / 2 + RENT - 5_000, 0, 49.5 * SOL],
    preTok: [tb(1, "MINT", "W", "1000000000")],
  });
  const e = classify(t, "W")!;
  assert.equal(e.side, "sell");
  assert.equal(e.solAmount, 0.5);
});

test("spending wrapped SOL counts as spending SOL", () => {
  const t = tx({
    keys: ["W", "WSOL_ACC", "ATA"],
    pre: [SOL, 0.3 * SOL + RENT, RENT],
    post: [SOL - 5_000, RENT, RENT],
    preTok: [tb(1, WSOL, "W", "300000000", 9), tb(2, "MINT", "W", "0")],
    postTok: [tb(1, WSOL, "W", "0", 9), tb(2, "MINT", "W", "500000")],
  });
  const e = classify(t, "W")!;
  assert.equal(e.side, "buy");
  near(e.solAmount, 0.3, 1e-12);
  assert.equal(e.tokenAmount, 0.5);
});

test("the fee is added back only when the wallet paid it", () => {
  const t = tx({
    keys: ["PAYER", "W", "ATA"],
    pre: [SOL, SOL, RENT],
    post: [SOL - 5_000, 0.8 * SOL, RENT],
    preTok: [tb(2, "MINT", "W", "0")],
    postTok: [tb(2, "MINT", "W", "2000000")],
  });
  const e = classify(t, "W")!;
  assert.equal(e.side, "buy");
  near(e.solAmount, 0.2, 1e-12);
});

test("tokens arriving without SOL are a transfer", () => {
  const t = tx({ keys: ["SENDER", "ATA"], pre: [SOL, RENT], post: [SOL - 5_000, RENT], postTok: [tb(1, "MINT", "W", "7000000")] });
  const e = classify(t, "W")!;
  assert.equal(e.side, "transfer-in");
  assert.equal(e.tokenAmount, 7);
  assert.equal(e.solAmount, 0);
});

test("token for token is a swap", () => {
  const t = tx({
    keys: ["W", "A_ACC", "B_ACC"],
    pre: [SOL, RENT, RENT],
    post: [SOL - 5_000, RENT, RENT],
    preTok: [tb(1, "A", "W", "100000000"), tb(2, "B", "W", "0")],
    postTok: [tb(1, "A", "W", "0"), tb(2, "B", "W", "50000000")],
  });
  const e = classify(t, "W")!;
  assert.equal(e.side, "swap");
  assert.equal(e.mint, "B");
  assert.equal(e.otherMint, "A");
  assert.equal(e.otherAmount, 100);
  assert.equal(e.tokenAmount, 50);
});

test("failed transactions and SOL-only movements are ignored", () => {
  const base = { keys: ["W", "ATA"], pre: [SOL, 0], post: [0.9 * SOL, RENT], postTok: [tb(1, "MINT", "W", "1000000")] };
  assert.equal(classify(tx({ ...base, err: { InstructionError: [0, "Custom"] } }), "W"), null);
  assert.equal(classify(tx({ keys: ["W", "X"], pre: [SOL, 0], post: [0.5 * SOL, 0.5 * SOL] }), "W"), null);
});
