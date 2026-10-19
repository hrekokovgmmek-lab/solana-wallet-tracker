# solana-wallet-tracker

Real-time alerts when the Solana wallets you watch buy or sell — any token, on any DEX.
Read-only: no keys, no trading. Runs on free RPC.

## What it does

1. Opens one WebSocket to a Solana RPC node: a `logsSubscribe` for every watched wallet, plus a slot heartbeat.
2. For every confirmed transaction that mentions a wallet, fetches it and reads the wallet's balance changes.
3. Turns them into **BUY / SELL / SWAP / transfer** with amounts and the price in SOL.
4. Prints an alert, optionally sends it to Telegram and appends it to a JSONL file.
5. With `--holders-of <mint>` it also watches the token's largest real holders — who is exiting.

## Sample output

A live run on 19 Oct 2026, watching 11 wallets that had just traded on fresh PumpSwap pools, on the public RPC with
`MIN_SOL=0.01` and `RPC_MAX_RPS=1`:

```
2026-10-19T10:07:42.730Z connected, watching 11 wallet(s)
[BUY] trader 9 (FHpc…7wCT) · 0.023 SOL → 2.76 USDC @ 8.209e-3 SOL · tx 4ERY…MccX · 10:07:48 UTC
[BUY] trader 5 (GU3W…3QfT) · 0.082 SOL → 56.34 EMe6…pump @ 1.454e-3 SOL · tx 43Fq…XMbQ · 10:08:03 UTC
2026-10-19T10:08:12.529Z falling behind: 1 notification(s) dropped at 1 req/s — use a faster RPC and raise RPC_MAX_RPS
```

In two minutes the stream delivered 275 transactions for these 11 wallets. One of them traded every second; the
tracker said so instead of queueing lookups forever.

## Why balance changes, not instructions

Every DEX and router encodes a swap differently, but every swap changes the same two balances: the wallet's SOL and
its token accounts. Reading those makes the tracker work the same for pump.fun, PumpSwap, Raydium, Jupiter routes or
a program that does not exist yet. The details that keep the numbers honest:

- **Token account rent.** A buy that creates a token account parks ~0.002 SOL of rent in it; a sell that closes it gets
  the rent back. The wallet's token accounts are counted as its own money, so rent does not distort the price.
- **Wrapped SOL** lives in a token account's lamports and is counted as SOL.
- **The network fee** is added back when the watched wallet paid it, and only then.
- **Failed transactions** and SOL-only movements are not reported.

## Engineering notes

- **Heartbeat.** A `slotSubscribe` runs next to the wallet subscriptions; if slots stop for a minute, the socket is
  replaced. Reconnects use exponential backoff with jitter that resets only after a stable connection, and every wallet
  is subscribed again.
- **Version 1 transactions.** `getTransaction` asks for `maxSupportedTransactionVersion: 1`; without it the node refuses
  transactions in the new format. Found during live testing.
- **The node may lag the stream.** A confirmed signature can arrive before the transaction is served, so it is read up
  to four times, 1.5 s apart.
- **Backpressure.** At most 50 lookups wait in line; beyond that the tracker drops and warns rather than drifting
  minutes behind real time.
- **RPC discipline.** Lookups are serialized under `RPC_MAX_RPS`, retried on 429 and 5xx; API keys and bot tokens are
  masked in every log line; a signature seen twice for a wallet is reported once.
- **Holders mode.** The largest token accounts are mapped to their owners; owners that are program-derived addresses
  (pools, bonding curves) are dropped by the ed25519 on-curve test, and accounts of one owner are merged.

## Quick start

Requires Node.js 22.9 or newer.

```bash
npm install
cp .env.example .env
cp wallets.example.json wallets.json
```

Put real addresses into `wallets.json`, then:

```bash
npm start
```

```bash
npm start -- --holders-of <mint address> --top 10
```

```bash
npm run inspect -- <transaction signature> <wallet address>
```

```bash
npm test
```

`npm start` watches the wallets in `wallets.json`; `--holders-of` adds the token's largest holders (this needs a
provider RPC endpoint — public ones refuse `getTokenLargestAccounts`); `npm run inspect` explains one transaction for
one wallet; `npm test` runs 19 tests, two of them on real mainnet transactions saved with `npm run fixture`.

### Telegram alerts

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Send any message to the bot, open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `chat.id`.
3. Put `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` into `.env`.

## Limitations

- The price per token includes that trade's fees and slippage.
- USDC and USDT are named; other tokens show a short address with a link (no metadata lookup).
- A public RPC serves about one lookup per second; wallets that trade every second need a faster endpoint.
- Alerts are information, not trading advice.

## По-русски

Бот следит за кошельками Solana в реальном времени и сообщает, когда они покупают или продают любой токен на любой
бирже: сколько SOL, сколько токенов, по какой цене. Сделка определяется по изменению балансов кошелька, поэтому работает
с pump.fun, PumpSwap, Raydium, Jupiter и любыми другими программами. Режим `--holders-of` следит за крупнейшими
держателями монеты. Только чтение: без ключей и торговли.

## Author

Artem Vartanov · [t.me/artemvartanov](https://t.me/artemvartanov). Built with AI assistance (Claude Code). MIT licence.
