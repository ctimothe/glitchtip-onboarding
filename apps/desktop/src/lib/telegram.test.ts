import { describe, expect, it } from "vitest";
import { validateBotToken } from "./telegram";

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function recordingFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as typeof fetch;
  return { fetchFn, calls };
}

describe("validateBotToken", () => {
  it("returns the bot username when getMe answers ok", async () => {
    const { fetchFn, calls } = recordingFetch(() =>
      jsonResponse(200, { ok: true, result: { username: "glitchtip_relay_bot" } }),
    );
    await expect(validateBotToken("123:ABC", fetchFn)).resolves.toBe(
      "glitchtip_relay_bot",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.telegram.org/bot123%3AABC/getMe");
  });

  it("throws invalid-bot-token when Telegram answers ok:false", async () => {
    const { fetchFn } = recordingFetch(() =>
      jsonResponse(401, { ok: false, description: "Unauthorized" }),
    );
    await expect(validateBotToken("bogus", fetchFn)).rejects.toThrow(
      "invalid-bot-token",
    );
  });

  it("throws invalid-bot-token when the result carries no username", async () => {
    const { fetchFn } = recordingFetch(() =>
      jsonResponse(200, { ok: true, result: {} }),
    );
    await expect(validateBotToken("123:ABC", fetchFn)).rejects.toThrow(
      "invalid-bot-token",
    );
  });

  it("URL-encodes the token segment of the getMe URL", async () => {
    const token = "123:ABC/def?x&y";
    const { fetchFn, calls } = recordingFetch(() =>
      jsonResponse(200, { ok: true, result: { username: "b" } }),
    );
    await validateBotToken(token, fetchFn);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      `https://api.telegram.org/bot${encodeURIComponent(token)}/getMe`,
    );
  });
});
