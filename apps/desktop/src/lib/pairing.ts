// Telegram pairing client. The relay (assets/relay/pairing.js) owns the code
// and the result; the Mac creates a ten-minute code through the relay control
// channel and reads the outcome. Every reply crosses a trust boundary, so each
// is validated strictly and anything unexpected throws a fixed error code.

import { relayControl, type RelayCommand, type ServerRequest } from "./remote";

export type PairingCode = { code: string; expiresAt: string };

export type PairingStatus =
  | { status: "none" | "pending" | "expired" }
  | { status: "paired"; chatId: number; chatTitle: string; adminUserId: number; pairedAt: string };

export type ControlFn = (request: ServerRequest, command: RelayCommand) => Promise<unknown>;

const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;
// Forum supergroup ids only (-100…); basic groups and private chats are refused.
const SUPERGROUP_RE = /^-100[1-9]\d*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export async function createPairingCode(
  request: ServerRequest,
  control: ControlFn = relayControl,
): Promise<PairingCode> {
  const reply = await control(request, { kind: "pairing-create" });
  if (!isRecord(reply) || typeof reply.code !== "string" || !CODE_RE.test(reply.code) || !isIso(reply.expiresAt)) {
    throw new Error("pairing-invalid-reply");
  }
  return { code: reply.code, expiresAt: reply.expiresAt };
}

export async function readPairingStatus(
  request: ServerRequest,
  control: ControlFn = relayControl,
): Promise<PairingStatus> {
  const reply = await control(request, { kind: "pairing-status" });
  if (!isRecord(reply)) throw new Error("pairing-invalid-reply");
  const { status } = reply;
  if (status === "none" || status === "pending" || status === "expired") return { status };
  if (status === "paired") {
    const { chatId, chatTitle, adminUserId, pairedAt } = reply;
    if (
      typeof chatId !== "number" ||
      !Number.isSafeInteger(chatId) ||
      !SUPERGROUP_RE.test(String(chatId))
    ) {
      throw new Error("pairing-not-forum-supergroup");
    }
    if (
      typeof chatTitle !== "string" ||
      typeof adminUserId !== "number" ||
      !Number.isSafeInteger(adminUserId) ||
      adminUserId <= 0 ||
      !isIso(pairedAt)
    ) {
      throw new Error("pairing-invalid-reply");
    }
    return { status: "paired", chatId, chatTitle, adminUserId, pairedAt };
  }
  throw new Error("pairing-invalid-reply");
}

/**
 * Poll until the relay reports `paired` or the code expires. `wait` is
 * injected so tests do not sleep.
 */
export async function waitForPairing(
  request: ServerRequest,
  options: {
    control?: ControlFn;
    wait?: (ms: number) => Promise<void>;
    intervalMs?: number;
    maxPolls?: number;
  } = {},
): Promise<Extract<PairingStatus, { status: "paired" }>> {
  const {
    control = relayControl,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    intervalMs = 3000,
    maxPolls = 200,
  } = options;
  for (let poll = 0; poll < maxPolls; poll += 1) {
    const current = await readPairingStatus(request, control);
    if (current.status === "paired") return current;
    if (current.status === "expired" || current.status === "none") throw new Error("pairing-expired");
    await wait(intervalMs);
  }
  throw new Error("pairing-timeout");
}
