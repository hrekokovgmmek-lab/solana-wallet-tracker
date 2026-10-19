type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Send one HTML message through the Telegram Bot API. On 429 waits as long as
 * Telegram asks (`retry_after`). Errors never include the bot token.
 */
export async function sendTelegram(
  token: string,
  chatId: string,
  html: string,
  fetchImpl: FetchLike = fetch,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return;
    if (res.status === 429) {
      const body = (await res.json().catch(() => ({}))) as { parameters?: { retry_after?: number } };
      await wait((body.parameters?.retry_after ?? 3) * 1000);
      continue;
    }
    throw new Error(`Telegram sendMessage: HTTP ${res.status}`);
  }
  throw new Error("Telegram sendMessage: still rate-limited after 3 attempts");
}
