import { scrubValue } from "./scrub.js";

export function normalizeMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const message = value.trim();
    return message.length > 0 ? message : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string") return new Error(normalizeMessage(value) ?? "Unknown error");

  try {
    const serialized = JSON.stringify(scrubValue(value));
    return new Error(serialized && serialized !== "{}" ? `Non-Error thrown: ${serialized}` : "Unknown error");
  } catch {
    return new Error("Unknown error");
  }
}
