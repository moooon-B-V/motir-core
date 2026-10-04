import type { APIRequestContext } from '@playwright/test';
import { expect, request } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { adminDb } from '@/tests/helpers/adminDb';

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

/**
 * A PAT-authenticated context that speaks `/api/v1`, exactly as the CLI does.
 *
 * ⚠️ `baseURL` IS PLAYWRIGHT'S, PASSED IN BY THE SPEC — never the `BASE_URL`
 * constant from `cli-connect-seed`. That constant falls back to
 * `http://localhost:3000`, and the acceptance lane deliberately runs on a port
 * of its own so it cannot collide with the main and billing lanes. Reading it
 * here made every request in this file die as
 * `apiRequestContext.post: connect ECONNREFUSED ::1:3000` — instantly and
 * identically in every test, which reads like the server never started rather
 * than like a spec pointed at the wrong door.
 *
 * `agent-authored-plan-seed.ts` carries the same warning for the MCP transport,
 * where the same mistake surfaces as `TypeError: fetch failed`. The origin the
 * RUNNER knows is Playwright's own `baseURL` — the value the browser is already
 * pointed at — so the spec reads it from the fixtures and hands it over.
 */
export async function ingestContext(token: string, baseURL: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL,
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

/** Report the run alive, as the reporter's heartbeat timer does (MOTIR-6528). */
export async function heartbeat(api: APIRequestContext, runId: string): Promise<void> {
  const res = await api.post(`/api/v1/dispatch-runs/${runId}/heartbeat`);
  const text = await res.text();
  expect(res.status(), `heartbeat → ${text.slice(0, 400)}`).toBe(204);
}

/**
 * THE ONE SEEDED FIELD (MOTIR-6536): move a run's `lastHeartbeatAt` into the past,
 * so the liveness rule reads it lapsed. A lapse is five minutes of silence; a spec
 * cannot wait five minutes, and no server clock is moved — so the record is set to
 * what five minutes of silence would have left behind, and nothing else is touched.
 */
export async function lapseRun(runId: string, minutesAgo: number): Promise<void> {
  await adminDb.dispatchRun.update({
    where: { id: runId },
    data: { lastHeartbeatAt: new Date(Date.now() - minutesAgo * 60_000) },
  });
}

// ── AN AGENT THAT REPORTS ITSELF (Story MOTIR-7446 · MOTIR-7453) ───────────
//
// The run above is opened by a stand-in for the CLI's reporter, over `/api/v1`.
// An agent-reported run is opened by the AGENT, over the MCP, with the three run
// tools (`docs/decisions/agent-reported-runs.md`). So the stand-in here is an MCP
// client over the REAL streamable-HTTP transport, with the PAT a plugin sends —
// no stub, for the reason `agent-authored-plan-seed.ts` gives: a stubbed transport
// would prove the harness, not the permission map or the run record.

/** An MCP session as an agent opens one. `baseURL` is Playwright's — see `ingestContext`. */
export async function agentMcpSession(token: string, baseURL: string): Promise<Client> {
  const client = new Client({ name: 'agent-reported-run-e2e', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/api/mcp', baseURL), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

/**
 * Call one Motir tool and return its structured answer.
 *
 * ⚠️ THE TOOL'S OWN ANSWER IS THE AUTHORITATIVE SIGNAL. Every write here commits
 * before the tool answers, so asserting the answer (not an error, the outcome
 * the step expects) is what lets the page assertion that follows wait on a fact
 * that is already stored rather than race one in flight.
 */
export async function callMotirTool<T>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = result.content
    .map((c) => (c.type === 'text' ? c.text : ''))
    .join(' ')
    .slice(0, 400);
  expect(result.isError ?? false, `${name} → ${text}`).toBe(false);
  return result.structuredContent as T;
}

/** The events of a run, in `seq` order — what the record holds, read as the test's own admin. */
export async function runEvents(
  runId: string,
): Promise<{ kind: string; body: string | null; reportedBy: string }[]> {
  return adminDb.dispatchRunEvent.findMany({
    where: { dispatchRunId: runId },
    orderBy: { seq: 'asc' },
    select: { kind: true, body: true, reportedBy: true },
  });
}
