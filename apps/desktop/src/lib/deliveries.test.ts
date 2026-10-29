import { describe, expect, it, vi } from "vitest";

import { readDeliveries, waitForDelivery } from "./deliveries";

// Records as the relay writes them (assets/relay/server.js writeAudit), oldest first.
const delivered = {
  eventId: "e1:error",
  applicationId: "web",
  state: "error",
  status: "delivered",
  at: "2026-10-29T10:00:00.000Z",
  retryCount: 0,
  relayVersion: "1.4.0",
  configRevision: "r1",
  telegramMessageId: 41,
};

describe("delivery records", () => {
  it("reads the relay's records newest first", () => {
    const later = { ...delivered, eventId: "e2:warning", state: "warning", at: "2026-10-29T10:05:00.000Z" };
    expect(readDeliveries([delivered, later])).toEqual([
      { at: later.at, applicationId: "web", state: "warning", status: "delivered", attempt: 1, failure: null, nextRetryAt: null },
      { at: delivered.at, applicationId: "web", state: "error", status: "delivered", attempt: 1, failure: null, nextRetryAt: null },
    ]);
  });

  it("counts the send that finally went through", () => {
    expect(readDeliveries([{ ...delivered, retryCount: 2 }])[0].attempt).toBe(3);
  });

  it("says which send failed, why, and when the next one runs", () => {
    const retrying = {
      ...delivered,
      status: "retrying",
      retryCount: 1,
      failureCode: "telegram-403",
      nextRetryAt: "2026-10-29T10:01:00.000Z",
    };
    expect(readDeliveries([retrying])[0]).toMatchObject({
      status: "retrying",
      attempt: 1,
      failure: "telegram",
      nextRetryAt: "2026-10-29T10:01:00.000Z",
    });
  });

  it.each([
    ["telegram-401", "bot-token"],
    ["telegram-400", "telegram"],
    ["telegram-404", "telegram"],
    ["telegram-429", "temporary"],
    ["telegram-500", "temporary"],
    ["network-error", "temporary"],
    ["invalid-response", "relay"],
    ["delivery-failed", "relay"],
  ])("reads %s as a %s failure", (failureCode, failure) => {
    expect(readDeliveries([{ ...delivered, status: "retrying", retryCount: 1, failureCode }])[0].failure).toBe(failure);
  });

  it("reads an agent prompt without an attempt", () => {
    expect(readDeliveries([{ ...delivered, status: "prompt-sent" }])[0]).toMatchObject({ status: "prompt-sent", attempt: null });
  });

  it("keeps a record with a state this app does not know, without the state", () => {
    expect(readDeliveries([{ ...delivered, state: "something-new" }])[0].state).toBeNull();
  });

  it("skips records it cannot place", () => {
    expect(
      readDeliveries([
        { ...delivered, status: "archived" },
        { ...delivered, at: null },
        { ...delivered, applicationId: 7 },
      ]),
    ).toEqual([]);
  });
});

describe("waiting for one delivery", () => {
  const record = { ...delivered, eventId: "t1:test", state: "test" };
  const retry = (failureCode: string) => ({ ...record, status: "retrying", retryCount: 1, failureCode });
  const noSleep = async () => undefined;

  function tailOf(...polls: Array<Array<Record<string, unknown>>>) {
    let call = 0;
    return async () => polls[Math.min(call++, polls.length - 1)];
  }

  it("waits until the relay names the event, then reads its delivery", async () => {
    const other = { ...delivered, eventId: "e9:error" };
    const result = await waitForDelivery("t1:test", tailOf([other], [other, record]), { sleep: noSleep });
    expect(result).toMatchObject({ status: "delivered", state: "test" });
  });

  it("stops at a failure that will not pass by itself", async () => {
    const tail = tailOf([retry("telegram-403")], [retry("telegram-403"), record]);
    expect(await waitForDelivery("t1:test", tail, { sleep: noSleep })).toMatchObject({ status: "retrying", failure: "telegram" });
  });

  it("rides out a passing outage until the retry goes through", async () => {
    const tail = tailOf([retry("telegram-429")], [retry("telegram-429"), record]);
    expect(await waitForDelivery("t1:test", tail, { sleep: noSleep })).toMatchObject({ status: "delivered" });
  });

  it("gives up at the timeout with the last retry, or nothing when the event never appeared", async () => {
    const options = { sleep: noSleep, timeoutMs: 4_000, intervalMs: 2_000 };
    expect(await waitForDelivery("t1:test", tailOf([retry("network-error")]), options)).toMatchObject({ failure: "temporary" });
    const tail = vi.fn(async () => [] as Record<string, unknown>[]);
    expect(await waitForDelivery("t1:test", tail, options)).toBeNull();
    expect(tail).toHaveBeenCalledTimes(3);
  });
});
