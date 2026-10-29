import { describe, expect, it, vi } from "vitest";

import { createPairingCode, readPairingStatus, waitForPairing } from "./pairing";
import type { ServerRequest } from "./remote";

const server: ServerRequest = {
  host: "h",
  user: "u",
  port: 22,
  identityFile: "/k",
  dockerNetwork: "n",
  deploymentDir: "/d",
};
const paired = {
  status: "paired",
  chatId: -1001234567890,
  chatTitle: "Ops",
  adminUserId: 42,
  pairedAt: "2026-10-15T10:00:00.000Z",
};

describe("pairing", () => {
  it("creates a code through the pairing-create command", async () => {
    const control = vi.fn().mockResolvedValue({ code: "ABCD-2345", expiresAt: "2026-10-15T10:10:00.000Z" });
    await expect(createPairingCode(server, control)).resolves.toEqual({
      code: "ABCD-2345",
      expiresAt: "2026-10-15T10:10:00.000Z",
    });
    expect(control).toHaveBeenCalledWith(server, { kind: "pairing-create" });
  });

  it("rejects a malformed code", async () => {
    const control = vi.fn().mockResolvedValue({ code: "abcd", expiresAt: "2026-10-15T10:10:00.000Z" });
    await expect(createPairingCode(server, control)).rejects.toThrow("pairing-invalid-reply");
  });

  it("accepts a paired forum supergroup", async () => {
    await expect(readPairingStatus(server, vi.fn().mockResolvedValue(paired))).resolves.toEqual(paired);
  });

  it("refuses a basic group id", async () => {
    const control = vi.fn().mockResolvedValue({ ...paired, chatId: -4567 });
    await expect(readPairingStatus(server, control)).rejects.toThrow("pairing-not-forum-supergroup");
  });

  it("rejects an unknown status", async () => {
    await expect(readPairingStatus(server, vi.fn().mockResolvedValue({ status: "weird" }))).rejects.toThrow(
      "pairing-invalid-reply",
    );
  });

  it("polls until paired", async () => {
    const control = vi
      .fn()
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValueOnce(paired);
    const wait = vi.fn().mockResolvedValue(undefined);
    await expect(waitForPairing(server, { control, wait })).resolves.toEqual(paired);
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it("fails when the code expires", async () => {
    const control = vi.fn().mockResolvedValue({ status: "expired" });
    await expect(waitForPairing(server, { control, wait: async () => {} })).rejects.toThrow("pairing-expired");
  });

  it("times out after maxPolls", async () => {
    const control = vi.fn().mockResolvedValue({ status: "pending" });
    await expect(waitForPairing(server, { control, wait: async () => {}, maxPolls: 2 })).rejects.toThrow(
      "pairing-timeout",
    );
  });
});
