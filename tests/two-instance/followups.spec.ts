import { randomUUID } from 'node:crypto';
import { describe, expect, inject, it } from 'vitest';
import { CLI_CLIENT_ID } from '@/lib/cliDevice/constants';
import { WORKBENCH_STREAM_FRAME, WORKBENCH_STREAM_POLL_MS } from '@/app/api/workbench/stream/route';
import { clientFor, type InstanceName } from './harness';
import {
  ORIGIN,
  countItemsTitled,
  seedMember,
  seedPlannedPlan,
  seedToken,
  signIn,
} from './fixtures/followups';

// THE FOLLOW-UP CASES (Story MOTIR-8547 · MOTIR-8618) — a request on one
// process and its follow-up on the other behave exactly as they would on one.
//
// Each case is shaped so a per-process implementation FAILS it: a session or a
// device grant held in memory is unknown to the other process, an in-process
// dedup lets the second write through, and a stream fed by an in-process event
// never hears a write made elsewhere. One process cannot show any of that,
// which is why these run in the two-instance lane.
//
// ⚠️ The file name: the card names `followups.test.ts`; it is `.spec.ts` for the
// same reason as `limits.spec.ts` — the default lane would run a `.test.ts` here
// with no servers (`vitest.two-instance.config.ts`).

const address = inject('twoInstanceApp');
const app = clientFor(address);

/**
 * The case's two responses came from two DIFFERENT processes. The client picks
 * the process by port, and the harness read back which pid announced which port
 * (`harness.spec.ts`'s smoke case), so a response's port names its process.
 */
function expectDifferentProcesses(first: Response, second: Response): void {
  const machineOf = (res: Response): InstanceName => {
    const port = Number(new URL(res.url).port);
    if (port === address.A.port) return 'A';
    if (port === address.B.port) return 'B';
    throw new Error(`response from an unknown port ${port}`);
  };
  const [one, two] = [machineOf(first), machineOf(second)];
  expect(one).not.toBe(two);
  expect(address[one].pid).not.toBe(address[two].pid);
}

// ── MCP over HTTP ────────────────────────────────────────────────────────────

let rpcId = 0;

/** POST one JSON-RPC message to `/api/mcp` and read its result. */
async function mcp(
  machine: InstanceName,
  token: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ res: Response; body: { result?: Record<string, unknown>; error?: unknown } }> {
  rpcId += 1;
  const res = await app.sendTo(machine, '/api/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, params }),
  });
  const text = await res.text();
  // The transport may answer as JSON or as one SSE `data:` frame.
  const json = (res.headers.get('content-type') ?? '').includes('text/event-stream')
    ? text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('')
    : text;
  return { res, body: JSON.parse(json) as { result?: Record<string, unknown>; error?: unknown } };
}

/** The text a `tools/call` result carries. */
function toolText(result: Record<string, unknown> | undefined): string {
  const content = (result?.['content'] ?? []) as Array<{ type: string; text?: string }>;
  return content.map((c) => c.text ?? '').join('\n');
}

describe('(a) a session signed in on A is honoured on B', () => {
  it('loads an authed page on B with the session cookie A issued', async () => {
    const member = await seedMember('session');
    const cookie = await signIn(app, 'A', member);

    // The session read on A, then the authed page on B.
    const onA = await app.sendTo('A', '/api/auth/get-session', {
      headers: { cookie, origin: ORIGIN },
    });
    let page = await app.sendTo('B', '/workbench', { headers: { cookie } });
    expectDifferentProcesses(onA, page);
    expect(((await onA.json()) as { user?: { email?: string } }).user?.email).toBe(member.email);

    // `/workbench` hops to its landing tab with a redirect of its own. That hop is
    // a signed-in answer; a signed-out one is a redirect to `/sign-in`.
    if (page.status >= 300 && page.status < 400) {
      const location = new URL(page.headers.get('location') ?? '', address.B.origin);
      expect(location.pathname).not.toMatch(/sign-in/);
      page = await app.sendTo('B', location.pathname + location.search, { headers: { cookie } });
    }
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(member.name);
  });
});

describe('(b) MCP initialize on A, then tools/list and a write on B', () => {
  it('serves both on B and the written item reads back through either process', async () => {
    const member = await seedMember('mcp');
    const token = await seedToken(member);

    const init = await mcp('A', token, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'two-instance', version: '1.0.0' },
    });
    expect(init.res.status).toBe(200);
    expect(init.body.result?.['serverInfo']).toBeDefined();

    const list = await mcp('B', token, 'tools/list');
    expectDifferentProcesses(init.res, list.res);
    expect(list.res.status).toBe(200);
    const tools = (list.body.result?.['tools'] ?? []) as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toContain('create_work_item');

    const title = `two-instance mcp write ${randomUUID()}`;
    const created = await mcp('B', token, 'tools/call', {
      name: 'create_work_item',
      arguments: { projectKey: member.projectKey, kind: 'task', title },
    });
    expect(created.res.status).toBe(200);
    expect(created.body.result?.['isError'], toolText(created.body.result)).not.toBe(true);
    const key = toolText(created.body.result).match(new RegExp(`${member.projectKey}-\\d+`))?.[0];
    expect(key, toolText(created.body.result)).toBeDefined();

    for (const machine of ['A', 'B'] as const) {
      const read = await mcp(machine, token, 'tools/call', {
        name: 'get_work_item',
        arguments: { key },
      });
      expect(read.body.result?.['isError'], toolText(read.body.result)).not.toBe(true);
      expect(toolText(read.body.result)).toContain(title);
    }
  });
});

describe('(c1) a repeated write with the same idempotency key is applied once', () => {
  // The write route that honours an idempotency key: `POST /api/v1/dispatch-runs`
  // (`dispatchRunService.open`, `idempotencyKey` in the body). No other write
  // door takes one — see the commit for the search.
  it('opens ONE dispatch run when the same key is sent to A and then B', async () => {
    const member = await seedMember('idem');
    const token = await seedToken(member);
    const idempotencyKey = `two-instance-${randomUUID()}`;
    const open = (machine: InstanceName) =>
      app.sendTo(machine, '/api/v1/dispatch-runs', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ projectKey: member.projectKey, command: 'next', idempotencyKey }),
      });

    const first = await open('A');
    const second = await open('B');
    expectDifferentProcesses(first, second);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const one = (await first.json()) as { run: { id: string }; created: boolean };
    const two = (await second.json()) as { run: { id: string }; created: boolean };
    expect(one.created).toBe(true);
    // The replay, not a second run.
    expect(two.created).toBe(false);
    expect(two.run.id).toBe(one.run.id);
  });
});

describe('(c2) a plan approved on A and again on B materializes once', () => {
  /** The review read's gate stamp — what a reader presses Approve with. */
  async function stampOf(machine: InstanceName, cookie: string, planId: string): Promise<string> {
    const res = await app.sendTo(machine, `/api/plans/${planId}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const review = (await res.json()) as { gate?: { stamp?: string | null } | null };
    const stamp = review.gate?.stamp;
    if (!stamp) throw new Error(`plan ${planId} has no awaiting gate stamp`);
    return stamp;
  }

  function approve(machine: InstanceName, cookie: string, planId: string, stamp: string) {
    return app.sendTo(machine, `/api/plans/${planId}/approve`, {
      method: 'POST',
      headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ stamp }),
    });
  }

  it('sequential: the second approve is refused or returns the approved plan, one set of items', async () => {
    const member = await seedMember('approve-seq');
    const title = `two-instance proposal ${randomUUID()}`;
    const planId = await seedPlannedPlan(member, title);
    const cookie = await signIn(app, 'A', member);

    const stamp = await stampOf('A', cookie, planId);
    const first = await approve('A', cookie, planId, stamp);
    expect(first.status, await first.clone().text()).toBe(200);
    const second = await approve('B', cookie, planId, stamp);
    expectDifferentProcesses(first, second);
    // Never a 5xx, and never a second materialization.
    expect(second.status).toBeLessThan(500);
    expect(await countItemsTitled(member, title)).toBe(1);
  });

  it('concurrent: one approve to each process at once, one set of items', async () => {
    const member = await seedMember('approve-race');
    const title = `two-instance proposal ${randomUUID()}`;
    const planId = await seedPlannedPlan(member, title);
    const cookie = await signIn(app, 'A', member);

    const stamp = await stampOf('B', cookie, planId);
    const [onA, onB] = await Promise.all([
      approve('A', cookie, planId, stamp),
      approve('B', cookie, planId, stamp),
    ]);
    expectDifferentProcesses(onA, onB);
    const statuses = [onA.status, onB.status];
    expect(statuses, `${await onA.text()} | ${await onB.text()}`).toContain(200);
    for (const status of statuses) expect(status).toBeLessThan(500);
    expect(await countItemsTitled(member, title)).toBe(1);
  });
});

describe('(d) a device grant started on A, approved on B, redeemed on A', () => {
  it('issues a token on A that works on B', async () => {
    const member = await seedMember('device');
    const cookie = await signIn(app, 'B', member);

    const started = await app.sendTo('A', '/api/cli/device/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostname: 'two-instance' }),
    });
    expect(started.status).toBe(200);
    const grant = (await started.json()) as { device_code: string; user_code: string };

    // The approval page's read CLAIMS the grant for the signed-in user, then the
    // approve — both on B, a process that never saw the start.
    const described = await app.sendTo(
      'B',
      `/api/cli/device/grant?user_code=${encodeURIComponent(grant.user_code)}`,
      { headers: { cookie, origin: ORIGIN } },
    );
    expectDifferentProcesses(started, described);
    expect(described.status, await described.clone().text()).toBe(200);
    const approved = await app.sendTo('B', '/api/cli/device/approve', {
      method: 'POST',
      headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ userCode: grant.user_code, workspaceId: member.workspaceId }),
    });
    expect(approved.status, await approved.clone().text()).toBeLessThan(300);

    const polled = await app.sendTo('A', '/api/cli/device/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: grant.device_code,
        client_id: CLI_CLIENT_ID,
      }),
    });
    expect(polled.status, await polled.clone().text()).toBe(200);
    const issued = (await polled.json()) as { access_token: string; user: { id: string } };
    expect(issued.user.id).toBe(member.userId);

    const me = await app.sendTo('B', '/api/v1/me', {
      headers: { authorization: `Bearer ${issued.access_token}` },
    });
    expectDifferentProcesses(polled, me);
    expect(me.status).toBe(200);
  });
});

describe('(e) a write on B reaches a workbench stream held on A', () => {
  /** Read SSE frames off a streaming body, one event at a time. */
  function frames(res: Response) {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    return {
      async next(deadlineMs: number): Promise<{ event: string; data: unknown } | null> {
        const deadline = Date.now() + deadlineMs;
        for (;;) {
          const end = buffer.indexOf('\n\n');
          if (end >= 0) {
            const raw = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (raw.startsWith(':')) continue; // heartbeat comment
            const event = /^event: (.*)$/m.exec(raw)?.[1] ?? 'message';
            const data = /^data: (.*)$/m.exec(raw)?.[1];
            return { event, data: data === undefined ? null : JSON.parse(data) };
          }
          const left = deadline - Date.now();
          if (left <= 0) return null;
          const chunk = await Promise.race([
            reader.read(),
            new Promise<null>((r) => setTimeout(() => r(null), left)),
          ]);
          if (chunk === null) return null;
          if (chunk.done) return null;
          buffer += decoder.decode(chunk.value, { stream: true });
        }
      },
      cancel: () => reader.cancel(),
    };
  }

  it(`delivers a ${WORKBENCH_STREAM_FRAME} frame on A within the poll cadence plus a margin`, async () => {
    const member = await seedMember('stream');
    const token = await seedToken(member);
    const cookie = await signIn(app, 'A', member);

    const stream = await app.sendTo('A', '/api/workbench/stream', { headers: { cookie } });
    expect(stream.status, stream.status === 200 ? '' : await stream.text()).toBe(200);
    const reader = frames(stream);
    try {
      // The opening frame, written whether or not anything moved — it is how the
      // reader learns its cursor.
      const opening = await reader.next(5_000);
      expect(opening?.event).toBe(WORKBENCH_STREAM_FRAME);

      // The write, on the OTHER process: a task in the reader's project, which
      // the reader created and so is on their Workbench.
      const created = await mcp('B', token, 'tools/call', {
        name: 'create_work_item',
        arguments: {
          projectKey: member.projectKey,
          kind: 'task',
          title: `two-instance stream ${randomUUID()}`,
        },
      });
      expectDifferentProcesses(stream, created.res);
      expect(created.body.result?.['isError'], toolText(created.body.result)).not.toBe(true);

      // One poll of the stream after the write lands, plus 3 s for the read and
      // the write's own commit under a loaded runner. A frame later than that is
      // a stream that did not hear the write, not a slow one.
      const MARGIN_MS = 3_000;
      const frame = await reader.next(WORKBENCH_STREAM_POLL_MS + MARGIN_MS);
      expect(frame?.event).toBe(WORKBENCH_STREAM_FRAME);
      expect((frame?.data as { moved: string[] }).moved.length).toBeGreaterThan(0);
    } finally {
      await reader.cancel();
    }
  });
});
