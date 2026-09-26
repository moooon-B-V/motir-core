import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { dispatchRunOpenedSchema } from '@/lib/api/v1/workLoop/schema';
import { verifyMcpToken } from '@/lib/mcp/auth';
import { runCredentialService } from '@/lib/services/runCredentialService';
import { workItemsService } from '@/lib/services/workItemsService';
import { bearer, createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// A hosted run's OWN Motir credential at the `/api/v1` doors (MOTIR-688,
// `docs/decisions/hosted-agent-run.md` §3) — against real Postgres, through the
// real bearer path (`withV1Route` → `authenticateApiToken` → `apiTokensService.verify`).
//
// ⚠️ EVERY REFUSAL IS DRIVEN, NOT ONLY THE HAPPY PATH. A run token holds
// `work_item:edit`, which on its own reaches every card in the project. What
// narrows it is the run BINDING, and a binding nobody proves is refused is a
// binding that does not exist: the failure mode (a run token reaching another
// run or card) is silent unless a test asserts the refusal. So each door the
// token could knock on is knocked on here.

const BASE = 'http://localhost:3000/api/v1';

function post(path: string, headers: Record<string, string>, body: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function openRun(headers: Record<string, string>, body: unknown): Promise<Response> {
  const { POST } = await import('@/app/api/v1/dispatch-runs/route');
  return POST(post('/dispatch-runs', headers, body), { params: Promise.resolve({}) });
}

async function appendEvents(headers: Record<string, string>, id: string): Promise<Response> {
  const { POST } = await import('@/app/api/v1/dispatch-runs/[id]/events/route');
  return POST(
    post(`/dispatch-runs/${id}/events`, headers, {
      events: [{ kind: 'log', body: 'agent says hello' }],
    }),
    { params: Promise.resolve({ id }) },
  );
}

async function closeRun(headers: Record<string, string>, id: string): Promise<Response> {
  const { POST } = await import('@/app/api/v1/dispatch-runs/[id]/close/route');
  return POST(post(`/dispatch-runs/${id}/close`, headers, { stopReason: 'completed' }), {
    params: Promise.resolve({ id }),
  });
}

async function dispatchPrompt(headers: Record<string, string>, key: string): Promise<Response> {
  const { GET } = await import('@/app/api/v1/work-items/[key]/dispatch-prompt/route');
  return GET(new Request(`${BASE}/work-items/${key}/dispatch-prompt`, { headers }), {
    params: Promise.resolve({ key }),
  });
}

async function codeOf(res: Response): Promise<string | undefined> {
  return ((await res.json()) as { code?: string }).code;
}

async function seedCard(caller: V1ProjectCaller, title: string): Promise<string> {
  const item = await workItemsService.createWorkItem(
    { projectId: caller.fixture.projectId, kind: 'task', title },
    caller.fixture.ctx,
  );
  return item.identifier;
}

/** Open a run over one fresh card with the caller's ordinary PAT. */
async function seedRun(
  caller: V1ProjectCaller,
  title: string,
): Promise<{ id: string; key: string }> {
  const key = await seedCard(caller, title);
  const res = await openRun(caller.headers, {
    projectKey: caller.projectKey,
    command: 'run',
    origin: 'hosted',
    cards: [{ key, disposition: 'queued' }],
  });
  expect(res.status, 'seeding a run').toBe(201);
  return { id: dispatchRunOpenedSchema.parse(await res.json()).run.id, key };
}

describe('a hosted run credential at the /api/v1 doors (MOTIR-688)', () => {
  let caller: V1ProjectCaller;
  let own: { id: string; key: string };
  let other: { id: string; key: string };
  let runToken: string;
  let runHeaders: Record<string, string>;

  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
    caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    own = await seedRun(caller, 'the card this run builds');
    other = await seedRun(caller, 'somebody else’s card');
    ({ token: runToken } = await runCredentialService.mintRunCredential({
      dispatchRunId: own.id,
      dispatcherUserId: caller.fixture.owner.id,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    }));
    runHeaders = bearer(runToken);
  });

  describe('AC 1 — its own run’s ingest, and nothing else', () => {
    it('posts events to its OWN run (200) and closes it (200)', async () => {
      expect((await appendEvents(runHeaders, own.id)).status).toBe(200);
      expect((await closeRun(runHeaders, own.id)).status).toBe(200);
    });

    it('is refused 403 on ANOTHER run’s events and close, and the other run is untouched', async () => {
      const append = await appendEvents(runHeaders, other.id);
      expect(append.status).toBe(403);
      expect(await codeOf(append)).toBe('DISPATCH_RUN_TOKEN_OUT_OF_SCOPE');

      const close = await closeRun(runHeaders, other.id);
      expect(close.status).toBe(403);
      expect(await codeOf(close)).toBe('DISPATCH_RUN_TOKEN_OUT_OF_SCOPE');

      // Still open: the owner's PAT can append to it.
      expect((await appendEvents(caller.headers, other.id)).status).toBe(200);
    });

    it('answers a run that does not exist with the SAME 403 — no existence oracle', async () => {
      const res = await appendEvents(runHeaders, 'no-such-run');
      expect(res.status).toBe(403);
      expect(await codeOf(res)).toBe('DISPATCH_RUN_TOKEN_OUT_OF_SCOPE');
    });

    it('is refused 403 on POST /api/v1/dispatch-runs — the server opens hosted runs', async () => {
      const res = await openRun(runHeaders, {
        projectKey: caller.projectKey,
        command: 'run',
        cards: [{ key: own.key, disposition: 'queued' }],
      });
      expect(res.status).toBe(403);
      expect(await codeOf(res)).toBe('RUN_TOKEN_NOT_ALLOWED');
    });
  });

  describe('AC 2 — its own card’s dispatch prompt, and nothing else', () => {
    it('reads its OWN card’s prompt (200)', async () => {
      expect((await dispatchPrompt(runHeaders, own.key)).status).toBe(200);
    });

    it('gets 404 for another card — the same answer as a card it cannot see', async () => {
      const res = await dispatchPrompt(runHeaders, other.key);
      expect(res.status).toBe(404);
      expect(await codeOf(res)).toBe('WORK_ITEM_NOT_FOUND');

      const missing = await dispatchPrompt(runHeaders, `${caller.projectKey}-9999`);
      expect(missing.status).toBe(404);
      expect(await codeOf(missing)).toBe('WORK_ITEM_NOT_FOUND');
    });
  });

  describe('every OTHER door refuses it, whatever its grant holds', () => {
    it('a work-item write its `work_item:edit` would otherwise admit → 403', async () => {
      const { PATCH } = await import('@/app/api/v1/work-items/[key]/route');
      const res = await PATCH(
        new Request(`${BASE}/work-items/${own.key}`, {
          method: 'PATCH',
          headers: { ...runHeaders, 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'renamed by an agent' }),
        }),
        { params: Promise.resolve({ key: own.key }) },
      );
      expect(res.status).toBe(403);
      expect(await codeOf(res)).toBe('RUN_TOKEN_NOT_ALLOWED');
    });

    it('a read its `project:browse` would otherwise admit → 403', async () => {
      const { GET } = await import('@/app/api/v1/me/route');
      const res = await GET(new Request(`${BASE}/me`, { headers: runHeaders }));
      expect(res.status).toBe(403);
      expect(await codeOf(res)).toBe('RUN_TOKEN_NOT_ALLOWED');
    });

    it('the MCP surface rejects it exactly as an unknown token', async () => {
      const req = new Request('http://localhost:3000/api/mcp', { headers: runHeaders });
      expect(await verifyMcpToken(req, runToken)).toBeUndefined();
      // Control: the owner's ordinary PAT is accepted by the same gate.
      expect(await verifyMcpToken(req, caller.token)).toBeDefined();
    });
  });

  describe('AC 3 — dead after revoke or expiry: 401 on every door it reached', () => {
    it('after revokeRunCredential', async () => {
      expect(await runCredentialService.revokeRunCredential(own.id)).toEqual({ revoked: 1 });

      const append = await appendEvents(runHeaders, own.id);
      expect(append.status).toBe(401);
      expect((await closeRun(runHeaders, own.id)).status).toBe(401);
      expect((await dispatchPrompt(runHeaders, own.key)).status).toBe(401);
    });

    it('past its expiresAt', async () => {
      // Minted two hours ago for one hour: already dead.
      const past = new Date(Date.now() - 2 * 60 * 60_000);
      const { token } = await runCredentialService.mintRunCredential(
        {
          dispatchRunId: own.id,
          dispatcherUserId: caller.fixture.owner.id,
          expiresAt: new Date(past.getTime() + 60 * 60_000),
        },
        past,
      );
      const expired = bearer(token);

      expect((await appendEvents(expired, own.id)).status).toBe(401);
      expect((await closeRun(expired, own.id)).status).toBe(401);
      expect((await dispatchPrompt(expired, own.key)).status).toBe(401);
    });
  });

  it('AC 6 — the owner’s ordinary PAT still reaches every run (unchanged)', async () => {
    expect((await appendEvents(caller.headers, own.id)).status).toBe(200);
    expect((await appendEvents(caller.headers, other.id)).status).toBe(200);
    expect((await dispatchPrompt(caller.headers, other.key)).status).toBe(200);
  });
});
