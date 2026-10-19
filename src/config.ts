import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";

export interface WalletEntry {
  address: string;
  label?: string;
}

export interface Config {
  rpcUrl: string;
  wsUrl: string;
  rpcMaxRps: number;
  walletsFile: string;
  minSol: number;
  telegramToken?: string;
  telegramChatId?: string;
  alertsJsonl?: string;
}

function num(value: string | undefined, fallback: number, name: string, allowZero = false): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) throw new Error(`${name} must be a positive number, got "${value}"`);
  return n;
}

function text(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

/** https://host/path → wss://host/path, http → ws. */
export function wsFromHttp(url: string): string {
  return url.replace(/^http(s?):\/\//i, (_m, s: string) => `ws${s}://`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rpcUrl = text(env.RPC_URL) ?? "https://api.mainnet-beta.solana.com";
  return {
    rpcUrl,
    wsUrl: text(env.WS_URL) ?? wsFromHttp(rpcUrl),
    rpcMaxRps: num(env.RPC_MAX_RPS, 2, "RPC_MAX_RPS"),
    walletsFile: text(env.WALLETS_FILE) ?? "wallets.json",
    minSol: num(env.MIN_SOL, 0.1, "MIN_SOL", true),
    telegramToken: text(env.TELEGRAM_BOT_TOKEN),
    telegramChatId: text(env.TELEGRAM_CHAT_ID),
    alertsJsonl: text(env.ALERTS_JSONL),
  };
}

/** Wallet list: `["addr", ...]` or `[{"address": "...", "label": "..."}, ...]`. Every address is validated. */
export function parseWallets(json: string): WalletEntry[] {
  const raw = JSON.parse(json) as unknown;
  if (!Array.isArray(raw)) throw new Error("wallets file must be a JSON array");
  const out: WalletEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const entry: WalletEntry =
      typeof item === "string" ? { address: item } : { address: String((item as WalletEntry).address), label: (item as WalletEntry).label };
    try {
      entry.address = new PublicKey(entry.address).toBase58();
    } catch {
      throw new Error(`not a Solana address: "${entry.address}"`);
    }
    if (seen.has(entry.address)) continue;
    seen.add(entry.address);
    out.push(entry);
  }
  return out;
}

export function loadWallets(path: string): WalletEntry[] {
  return parseWallets(readFileSync(path, "utf8"));
}

/** Hide API keys and tokens in any URL before it reaches a log line. */
export function maskSecrets(s: string): string {
  return s
    .replace(/(api[-_]?key=)[^&\s"']+/gi, "$1***")
    .replace(/(bot)\d+:[A-Za-z0-9_-]+/g, "$1***");
}
