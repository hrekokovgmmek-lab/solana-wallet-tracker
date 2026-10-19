export const WSOL = "So11111111111111111111111111111111111111112";

export interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

/** The part of a `getTransaction` (jsonParsed) result this tracker reads. */
export interface ParsedTx {
  slot: number;
  blockTime: number | null;
  transaction: {
    signatures: string[];
    message: { accountKeys: { pubkey: string }[] };
  };
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
  } | null;
}

export type Side = "buy" | "sell" | "transfer-in" | "transfer-out" | "swap";

export interface TradeEvent {
  signature: string;
  wallet: string;
  side: Side;
  /** Token the wallet received (buy, swap, transfer-in) or gave away (sell, transfer-out). */
  mint: string;
  /** Token amount moved, always positive. */
  tokenAmount: number;
  /** SOL moved in the trade, always positive; 0 for transfers. */
  solAmount: number;
  /** SOL per token for buys and sells. */
  priceSol: number | null;
  /** For swaps: the token given away. */
  otherMint?: string;
  otherAmount?: number;
  slot: number;
  blockTime: number | null;
}

/**
 * The wallet's SOL movement in lamports, with the network fee added back and the
 * wallet's token accounts counted as its own money. A token account the trade
 * creates holds rent (~0.002 SOL) and one it closes returns it; counting their
 * lamports as the wallet's cancels that out, and also covers wrapped SOL, whose
 * balance lives in the token account's lamports.
 */
export function tradeLamports(tx: ParsedTx, wallet: string): number {
  const meta = tx.meta;
  if (!meta) return 0;
  const keys = tx.transaction.message.accountKeys;
  const at = (i: number, side: number[]) => side[i] ?? 0;
  let lamports = 0;
  const idx = keys.findIndex((k) => k.pubkey === wallet);
  if (idx >= 0) {
    lamports += at(idx, meta.postBalances) - at(idx, meta.preBalances);
    if (idx === 0) lamports += meta.fee;
  }
  const owned = new Set<number>();
  for (const b of [...(meta.preTokenBalances ?? []), ...(meta.postTokenBalances ?? [])]) {
    if (b.owner === wallet) owned.add(b.accountIndex);
  }
  for (const i of owned) lamports += at(i, meta.postBalances) - at(i, meta.preBalances);
  return lamports;
}

/** Change of each non-SOL token the wallet owns, in raw units. Zero changes are dropped. */
export function tokenDeltas(tx: ParsedTx, wallet: string): Map<string, { raw: bigint; decimals: number }> {
  const out = new Map<string, { raw: bigint; decimals: number }>();
  const add = (b: TokenBalance, sign: 1n | -1n) => {
    if (b.owner !== wallet || b.mint === WSOL) return;
    const cur = out.get(b.mint) ?? { raw: 0n, decimals: b.uiTokenAmount.decimals };
    cur.raw += sign * BigInt(b.uiTokenAmount.amount);
    out.set(b.mint, cur);
  };
  for (const b of tx.meta?.postTokenBalances ?? []) add(b, 1n);
  for (const b of tx.meta?.preTokenBalances ?? []) add(b, -1n);
  for (const [mint, d] of out) if (d.raw === 0n) out.delete(mint);
  return out;
}

const human = (d: { raw: bigint; decimals: number }) => Number(d.raw) / 10 ** d.decimals;

/**
 * What the transaction did for one wallet, read from balance changes rather than
 * from instructions — so it works the same for pump.fun, PumpSwap, Raydium,
 * Jupiter routes or anything else. Failed transactions and SOL-only movements
 * return null.
 */
export function classify(tx: ParsedTx, wallet: string, dustSol = 0.001): TradeEvent | null {
  if (!tx.meta || tx.meta.err) return null;
  const deltas = [...tokenDeltas(tx, wallet).entries()];
  if (deltas.length === 0) return null;
  const sol = tradeLamports(tx, wallet) / 1e9;
  const base = { signature: tx.transaction.signatures[0] ?? "", wallet, slot: tx.slot, blockTime: tx.blockTime };

  if (deltas.length >= 2) {
    const got = deltas.filter(([, d]) => d.raw > 0n).sort((a, b) => human(b[1]) - human(a[1]))[0];
    const gave = deltas.filter(([, d]) => d.raw < 0n).sort((a, b) => human(a[1]) - human(b[1]))[0];
    if (got && gave) {
      return { ...base, side: "swap", mint: got[0], tokenAmount: human(got[1]), solAmount: 0, priceSol: null, otherMint: gave[0], otherAmount: -human(gave[1]) };
    }
  }
  // One token moved (or several in one direction): report the largest.
  const [mint, d] = deltas.sort((a, b) => Math.abs(human(b[1])) - Math.abs(human(a[1])))[0]!;
  const amount = human(d);
  if (amount > 0 && sol < -dustSol) return { ...base, side: "buy", mint, tokenAmount: amount, solAmount: -sol, priceSol: -sol / amount };
  if (amount < 0 && sol > dustSol) return { ...base, side: "sell", mint, tokenAmount: -amount, solAmount: sol, priceSol: sol / -amount };
  return { ...base, side: amount > 0 ? "transfer-in" : "transfer-out", mint, tokenAmount: Math.abs(amount), solAmount: 0, priceSol: null };
}
