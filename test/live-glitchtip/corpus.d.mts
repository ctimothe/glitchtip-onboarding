export type Scenario = {
  id: string;
  project: string;
  platform: string;
  environment: string;
  type?: string;
  value?: string;
  message?: string;
  events: number;
  users: number;
  expect: { kind: string; priority: string };
};
export const SCENARIOS: Scenario[];
export const PROJECTS: Array<{ slug: string; platform: string }>;
