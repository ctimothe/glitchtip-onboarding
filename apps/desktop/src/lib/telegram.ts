// Telegram Bot API check for the setup assistant: the bot token is validated
// here; pairing, topics and test messages run through the relay on the server.
//
// Every function takes an injected `fetchFn` so tests run on mocked fetch,
// mirroring the read-path convention in `lib/glitchtip.ts`. The token is
// always placed into the URL with `encodeURIComponent` — a token containing
// `/`, `?`, or `&` must never break the path or leak into the query string
// (asserted in `telegram.test.ts` by spying the called URL).

const API = "https://api.telegram.org";

function botUrl(token: string, method: string): string {
  return `${API}/bot${encodeURIComponent(token)}/${method}`;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Confirm the token belongs to a bot. Resolves with the bot username, or
 * throws `invalid-bot-token` when Telegram answers ok:false or the result
 * carries no username.
 */
export async function validateBotToken(
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchFn(botUrl(token, "getMe"));
  const body = (await readJson(res)) as {
    ok?: unknown;
    result?: { username?: unknown };
  } | null;
  const username = body?.ok === true ? body.result?.username : undefined;
  if (typeof username === "string" && username !== "") return username;
  throw new Error("invalid-bot-token");
}
