import { PublicKey } from "@solana/web3.js";
import type { WalletEntry } from "./config.ts";
import type { RpcClient } from "./rpc.ts";

export interface HolderAccount {
  owner: string;
  amount: bigint;
  /** false for program-derived addresses: pools, bonding curves, vaults. */
  onCurve: boolean;
}

const pct = (part: bigint, whole: bigint) => (whole > 0n ? Number((part * 1_000_000n) / whole) / 10_000 : 0);

/**
 * Real wallets among the largest token accounts, merged by owner and ranked.
 * Pools and other program accounts are dropped by the ed25519 on-curve test:
 * a program-derived address has no private key, so nobody "exits" from it.
 */
export function pickHolderWallets(accounts: HolderAccount[], supply: bigint, top: number): WalletEntry[] {
  const byOwner = new Map<string, bigint>();
  for (const a of accounts) if (a.onCurve) byOwner.set(a.owner, (byOwner.get(a.owner) ?? 0n) + a.amount);
  return [...byOwner.entries()]
    .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
    .slice(0, top)
    .map(([owner, amount], i) => ({ address: owner, label: `top-${i + 1} holder · ${pct(amount, supply).toFixed(1)}%` }));
}

export async function topHolderWallets(
  rpc: Pick<RpcClient, "getMultipleAccounts" | "getTokenLargestAccounts">,
  mint: string,
  top = 10,
): Promise<WalletEntry[]> {
  const [mintAcc] = await rpc.getMultipleAccounts([mint]);
  if (!mintAcc || mintAcc.data.length < 45) throw new Error("mint account not found");
  const supply = mintAcc.data.readBigUInt64LE(36);
  const largest = await rpc.getTokenLargestAccounts(mint);
  const accounts = await rpc.getMultipleAccounts(largest.map((a) => a.address));
  const holders: HolderAccount[] = [];
  largest.forEach((a, i) => {
    const acc = accounts[i];
    if (!acc || acc.data.length < 64) return;
    const owner = new PublicKey(acc.data.subarray(32, 64));
    holders.push({ owner: owner.toBase58(), amount: BigInt(a.amount), onCurve: PublicKey.isOnCurve(owner.toBytes()) });
  });
  return pickHolderWallets(holders, supply, top);
}
