// Telegram topics the setup assistant created for an application it has not saved yet, so a
// retry after a failure, even after the app restarts, reuses the topic instead of adding another
// to the group. Cleared once the application is saved. A store failure only loses the reuse.

import { LazyStore } from "@tauri-apps/plugin-store";

const store = new LazyStore("setup.json");
const KEY = "createdTopics";

async function read(): Promise<Record<string, number>> {
  try {
    const value = await store.get<unknown>(KEY);
    return value !== null && typeof value === "object" ? (value as Record<string, number>) : {};
  } catch {
    return {};
  }
}

async function write(topics: Record<string, number>): Promise<void> {
  try {
    await store.set(KEY, topics);
    await store.save();
  } catch {
    // The topic still works; only a later retry may add another.
  }
}

export async function createdTopic(key: string): Promise<number | null> {
  const topicId = (await read())[key];
  return typeof topicId === "number" ? topicId : null;
}

export async function rememberTopic(key: string, topicId: number): Promise<void> {
  await write({ ...(await read()), [key]: topicId });
}

export async function forgetCreatedTopics(): Promise<void> {
  await write({});
}
