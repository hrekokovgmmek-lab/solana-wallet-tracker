import { appendFileSync, existsSync } from "node:fs";
import { loadConfig, loadWallets, maskSecrets, type WalletEntry } from "./config.ts";
import { topHolderWallets } from "./holders.ts";
import { formatConsole, formatTelegramHtml, shouldAlert } from "./report.ts";
import { RpcClient } from "./rpc.ts";
import { WalletStream } from "./stream.ts";
import { sendTelegram } from "./telegram.ts";
import { classify, type ParsedTx } from "./trade.ts";

const cfg = loadConfig();
const rpc = new RpcClient(cfg.rpcUrl, cfg.rpcMaxRps);
const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const telegramOn = Boolean(cfg.telegramToken && cfg.telegramChatId);

/** The stream can announce a confirmed signature before the node serves the transaction. */
async function fetchTx(signature: string): Promise<ParsedTx | null> {
  for (let i = 0; i < 4; i++) {
    const tx = await rpc.getTransaction(signature);
    if (tx) return tx;
    await sleep(1_500);
  }
  return null;
}

async function handle(entry: WalletEntry, signature: string): Promise<void> {
  try {
    const tx = await fetchTx(signature);
    if (!tx) return log(`transaction ${signature} not available yet — skipped`);
    const e = classify(tx, entry.address);
    if (!e || !shouldAlert(e, cfg.minSol)) return;
    console.log(formatConsole(e, entry));
    if (cfg.alertsJsonl) appendFileSync(cfg.alertsJsonl, JSON.stringify({ ...e, label: entry.label }) + "\n");
    if (telegramOn) {
      await sendTelegram(cfg.telegramToken!, cfg.telegramChatId!, formatTelegramHtml(e, entry)).catch((err) =>
        log(`telegram: ${maskSecrets(String(err instanceof Error ? err.message : err))}`),
      );
    }
  } catch (err) {
    log(`skipped ${signature}: ${maskSecrets(String(err instanceof Error ? err.message : err))}`);
  }
}

const argValue = (args: string[], name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const args = process.argv.slice(2);

if (args[0] === "inspect") {
  const [, signature, wallet] = args;
  if (!signature || !wallet) {
    console.error("usage: npm run inspect -- <signature> <wallet address>");
    process.exit(2);
  }
  const tx = await rpc.getTransaction(signature);
  if (!tx) {
    console.error("transaction not found");
    process.exit(1);
  }
  const e = classify(tx, wallet);
  console.log(e ? formatConsole(e, { address: wallet }) : "no token movement for this wallet in this transaction");
} else {
  const wallets: WalletEntry[] = existsSync(cfg.walletsFile) ? loadWallets(cfg.walletsFile) : [];
  const holdersOf = argValue(args, "--holders-of");
  if (holdersOf) {
    try {
      const top = await topHolderWallets(rpc, holdersOf, Number(argValue(args, "--top") ?? 10));
      for (const h of top) if (!wallets.some((w) => w.address === h.address)) wallets.push(h);
      log(`added the top ${top.length} holders of ${holdersOf}`);
    } catch (err) {
      console.error(
        `could not read the holders of ${holdersOf}: ${maskSecrets(String(err instanceof Error ? err.message : err))}\n` +
          "Public RPC endpoints often refuse getTokenLargestAccounts — set RPC_URL to a provider endpoint (free tiers work).",
      );
      process.exit(1);
    }
  }
  if (wallets.length === 0) {
    console.error(`no wallets to watch: create ${cfg.walletsFile} (see wallets.example.json) or pass --holders-of <mint>`);
    process.exit(2);
  }
  const byAddress = new Map(wallets.map((w) => [w.address, w]));
  // One queue: lookups for overlapping trades never burst the RPC together. A wallet that trades every
  // second can outrun a slow RPC; past MAX_PENDING the tracker says so and drops, instead of falling ever further behind.
  const MAX_PENDING = 50;
  let queue: Promise<void> = Promise.resolve();
  let pending = 0;
  let dropped = 0;
  const stream = new WalletStream({
    url: cfg.wsUrl,
    wallets: wallets.map((w) => w.address),
    log,
    onActivity: (wallet, signature, failed) => {
      const entry = byAddress.get(wallet);
      if (process.env.VERBOSE) log(`activity ${entry?.label ?? wallet} ${signature}${failed ? " (failed)" : ""}`);
      if (failed || !entry) return;
      if (pending >= MAX_PENDING) {
        if (dropped++ % 50 === 0) {
          log(`falling behind: ${dropped} notification(s) dropped at ${cfg.rpcMaxRps} req/s — use a faster RPC and raise RPC_MAX_RPS`);
        }
        return;
      }
      pending++;
      queue = queue.then(() => handle(entry, signature)).finally(() => void pending--);
    },
  });
  stream.start();
  log(
    `RPC ${maskSecrets(cfg.rpcUrl)} · alerts from ${cfg.minSol} SOL` +
      (telegramOn ? " · Telegram alerts on" : "") +
      ` · ${wallets.map((w) => w.label ?? w.address).join(", ")}`,
  );
  process.on("SIGINT", () => {
    stream.stop();
    log("stopped");
    process.exit(0);
  });
}
