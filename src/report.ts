import type { WalletEntry } from "./config.ts";
import type { Side, TradeEvent } from "./trade.ts";

const SIDE: Record<Side, string> = { buy: "BUY", sell: "SELL", "transfer-in": "RECEIVED", "transfer-out": "SENT", swap: "SWAP" };

const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;

const KNOWN_MINTS: Record<string, string> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
};

/** A readable name for well-known mints, a shortened address for the rest. */
export const tokenName = (mint: string) => KNOWN_MINTS[mint] ?? short(mint);

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 1234567 → "1.23M". */
export function compact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return a >= 1 ? n.toFixed(2) : n.toPrecision(3);
}

const sol = (n: number) => n.toFixed(3);
const price = (p: number | null) => (p === null ? "" : ` @ ${p.toExponential(3)} SOL`);

export function tokenLink(mint: string): string {
  return mint.endsWith("pump") ? `https://pump.fun/coin/${mint}` : `https://solscan.io/token/${mint}`;
}

function movement(e: TradeEvent): string {
  switch (e.side) {
    case "buy":
      return `${sol(e.solAmount)} SOL → ${compact(e.tokenAmount)} ${tokenName(e.mint)}${price(e.priceSol)}`;
    case "sell":
      return `${compact(e.tokenAmount)} ${tokenName(e.mint)} → ${sol(e.solAmount)} SOL${price(e.priceSol)}`;
    case "swap":
      return `${compact(e.otherAmount ?? 0)} ${tokenName(e.otherMint ?? "")} → ${compact(e.tokenAmount)} ${tokenName(e.mint)}`;
    default:
      return `${compact(e.tokenAmount)} ${tokenName(e.mint)}`;
  }
}

/** Buys and sells below the SOL threshold are noise; swaps always count; incoming transfers are often spam airdrops. */
export function shouldAlert(e: TradeEvent, minSol: number, includeTransfers = false): boolean {
  if (e.side === "buy" || e.side === "sell") return e.solAmount >= minSol;
  if (e.side === "swap") return true;
  return includeTransfers;
}

export function formatConsole(e: TradeEvent, w: WalletEntry): string {
  const who = w.label ? `${w.label} (${short(e.wallet)})` : short(e.wallet);
  const time = e.blockTime ? ` · ${new Date(e.blockTime * 1000).toISOString().slice(11, 19)} UTC` : "";
  return `[${SIDE[e.side]}] ${who} · ${movement(e)} · tx ${short(e.signature)}${time}`;
}

export function formatTelegramHtml(e: TradeEvent, w: WalletEntry): string {
  const who = esc(w.label ?? short(e.wallet));
  return [
    `<b>${SIDE[e.side]}</b> · ${who}`,
    esc(movement(e)),
    `<a href="${tokenLink(e.mint)}">token</a> · <a href="https://solscan.io/tx/${esc(e.signature)}">tx</a> · ` +
      `<a href="https://solscan.io/account/${esc(e.wallet)}">wallet</a>`,
  ].join("\n");
}
