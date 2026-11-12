import type { Scenario } from "./corpus.mjs";

export const BASE: string;
export const TOKEN: string;
export const ORG: string;
export function ensureProjects(): Promise<Record<string, { id: string; key: string }>>;
export function buildEvent(scenario: Scenario, n?: number): Record<string, unknown> & { event_id: string };
export function send(project: { id: string; key: string }, event: Record<string, unknown>): Promise<void>;
export function fire(options?: { only?: string[] | null; events?: number | null }): Promise<{ scenarios: number; sent: number }>;
