import type { APIRequestContext } from '@playwright/test';
import { expect, request } from '@playwright/test';
import { BASE_URL } from './cli-connect-seed';

// DRIVING A RUN WITHOUT AN AGENT (Story MOTIR-1789 · MOTIR-1800).
//
// ⚠️ THE SPEC DOES NOT SHELL OUT TO `motir run`. A real dispatch spawns a coding
// agent: non-deterministic, minutes long, and needing a provider key. What it
// DOES do is call the same PAT-authenticated `/api/v1` ingest operations the
// reporter calls — open with an ordered SET, append events, close with a stop
// reason — so the system under test stays the real server, the real UI and the
// real SSE. The only thing stubbed is the thing the browser was never going to
// run.
//
// ⚠️ EVERY CALL ASSERTS ITS COMMITTED RESPONSE. A fire-and-forget POST followed
// by a UI assertion is the race `CLAUDE.md`'s E2E rule exists to stop: the page
// would be racing a write that may not have landed, and the failure would look
// like a rendering bug.

/** A PAT-authenticated context that speaks `/api/v1`, exactly as the CLI does. */
export async function ingestContext(token: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
}

export interface OpenRunArgs {
  projectKey: string;
  command: 'next' | 'run' | 'run_scope' | 'batch' | 'auto';
  scopeKey?: string;
  agent?: string;
  model?: string;
  cards: { key: string; disposition?: string; skipReason?: string }[];
}

/** Open a run with its whole SET, at the one moment the set exists. */
export async function openRun(api: APIRequestContext, args: OpenRunArgs): Promise<string> {
  const res = await api.post('/api/v1/dispatch-runs', { data: args });
  const body = await res.text();
  expect(res.status(), `open run → ${body.slice(0, 400)}`).toBe(201);
  return (JSON.parse(body) as { run: { id: string } }).run.id;
}

export interface RunEvent {
  kind: string;
  workItemKey?: string;
  data?: unknown;
  body?: string;
  disposition?: string;
  skipReason?: string;
  sessionBranch?: string;
  exitCode?: number;
}

/** Append a batch, and assert the server committed it before anything is read. */
export async function appendEvents(
  api: APIRequestContext,
  runId: string,
  events: RunEvent[],
): Promise<number> {
  const res = await api.post(`/api/v1/dispatch-runs/${runId}/events`, { data: { events } });
  const text = await res.text();
  expect(res.status(), `append → ${text.slice(0, 400)}`).toBe(200);
  return (JSON.parse(text) as { seq: number }).seq;
}

/** Close the run with the reason a reader will see in the modal's header. */
export async function closeRun(
  api: APIRequestContext,
  runId: string,
  stopReason: string,
): Promise<void> {
  const res = await api.post(`/api/v1/dispatch-runs/${runId}/close`, { data: { stopReason } });
  const text = await res.text();
  expect(res.status(), `close → ${text.slice(0, 400)}`).toBe(200);
}
