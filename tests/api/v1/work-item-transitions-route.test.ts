import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { workItemDetailSchema } from '@/lib/api/v1/workItems/schema';
import { workItemsService } from '@/lib/services/workItemsService';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// GET + POST /api/v1/work-items/{key}/transitions
// (Story 11.2 · Subtask 11.2.7 — MOTIR-2048).

type Handler = (
  req: Request,
  args: { params: Promise<Record<string, string>> },
) => Promise<Response>;

async function call(
  modulePath: string,
  method: 'GET' | 'POST' | 'DELETE',
  key: string,
  caller: { headers: Record<string, string> },
  opts: { body?: unknown; query?: string } = {},
): Promise<Response> {
  const mod = (await import(/* @vite-ignore */ modulePath)) as Record<string, Handler>;
  const handler = mod[method];
  if (!handler) throw new Error(`${modulePath} exports no ${method}`);
  const url = `http://localhost:3000/api/v1/work-items/${key}/x${opts.query ?? ''}`;
  return handler(
    new Request(url, {
      method,
      headers: { ...caller.headers, 'content-type': 'application/json' },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    }),
    { params: Promise.resolve({ key }) },
  );
}

/**
 * Create a work item through the SERVICE, so it lands in the project workflow's
 * INITIAL status.
 *
 * ⚠️ `createTestWorkItem` writes through the repository edge and does not set a
 * status, so the row takes the column default `open` — a value NO project
 * workflow defines. Items created that way legitimately have nowhere to move
 * (both `canTransition` and the transitions list agree they do not), which is
 * correct product behaviour but useless as a fixture for testing MOVES.
 */
async function seedItem(
  caller: V1ProjectCaller,
  title: string,
): Promise<{ id: string; identifier: string }> {
  const created = await workItemsService.createWorkItem(
    { projectId: caller.fixture.projectId, kind: 'task', title },
    caller.ctx,
  );
  return { id: created.id, identifier: created.identifier };
}

const TRANSITIONS = '@/app/api/v1/work-items/[key]/transitions/route';

interface Target {
  key: string;
  label: string;
  category: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 11.2.7 — transitions
// ─────────────────────────────────────────────────────────────────────────────

describe('GET + POST /api/v1/work-items/{key}/transitions', () => {
  let caller: V1ProjectCaller;

  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
    caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
  });

  it('lists exactly the targets legal from HERE — every one drives successfully', async () => {
    const item = await seedItem(caller, 'Movable');

    const listed = (await (await call(TRANSITIONS, 'GET', item.identifier, caller)).json()) as {
      transitions: Target[];
    };

    expect(listed.transitions.length).toBeGreaterThan(0);

    // The assertion that makes the list MEAN something: each advertised target
    // actually works. Driven on a fresh item per target so one move does not
    // invalidate the next.
    for (const target of listed.transitions) {
      const fresh = await seedItem(caller, 'Probe');
      const res = await call(TRANSITIONS, 'POST', fresh.identifier, caller, {
        body: { status: target.key },
      });
      expect(res.status, `advertised target '${target.key}' must be legal`).toBe(200);
    }
  });

  it('a legal move PERSISTS and is visible on a subsequent read', async () => {
    const item = await seedItem(caller, 'T');

    const moved = await call(TRANSITIONS, 'POST', item.identifier, caller, {
      body: { status: 'in_progress' },
    });
    const body = await moved.json();

    expect(moved.status).toBe(200);
    expect(body.status).toBe('in_progress');
    expect(workItemDetailSchema.safeParse(body).success).toBe(true);

    const { GET } = await import('@/app/api/v1/work-items/[key]/route');
    const reread = await GET(
      new Request(`http://localhost:3000/api/v1/work-items/${item.identifier}`, {
        headers: caller.headers,
      }),
      { params: Promise.resolve({ key: item.identifier }) },
    );
    await expect(reread.json()).resolves.toMatchObject({ status: 'in_progress' });
  });

  // ⚠️ The behaviour that makes the API self-teaching.
  it('an ILLEGAL move returns 422 + allowedTransitions EQUAL to what GET reports', async () => {
    const item = await seedItem(caller, 'T');
    // `todo → done` has no direct edge in the default workflow.
    const refused = await call(TRANSITIONS, 'POST', item.identifier, caller, {
      body: { status: 'done' },
    });
    const body = (await refused.json()) as {
      code: string;
      error: string;
      allowedTransitions: Target[];
    };

    expect(refused.status).toBe(422);
    expect(body.code).toBe('ILLEGAL_TRANSITION');
    // DATA, not prose — a machine client must not have to parse a sentence.
    expect(Array.isArray(body.allowedTransitions)).toBe(true);

    const listed = (await (await call(TRANSITIONS, 'GET', item.identifier, caller)).json()) as {
      transitions: Target[];
    };
    // The two surfaces are produced by different code paths and MUST agree.
    expect(body.allowedTransitions.map((t) => t.key).sort()).toEqual(
      listed.transitions.map((t) => t.key).sort(),
    );
    expect(body.allowedTransitions.map((t) => t.key)).not.toContain('done');
  });

  it('an UNKNOWN status is a DISTINCT code from an illegal move', async () => {
    const item = await seedItem(caller, 'T');

    const res = await call(TRANSITIONS, 'POST', item.identifier, caller, {
      body: { status: 'not_a_real_status' },
    });

    expect(res.status).toBe(422);
    // A typo and a workflow rule must be distinguishable — a client can fix
    // only one of them.
    await expect(res.json()).resolves.toMatchObject({ code: 'UNKNOWN_STATUS' });
  });

  it('a read-only token gets 200 on GET and 403 on POST — the scope split', async () => {
    const item = await seedItem(caller, 'T');
    const readOnly = await createV1ProjectCaller({ scopes: ['read'] });

    expect((await call(TRANSITIONS, 'GET', item.identifier, caller)).status).toBe(200);
    expect(
      (
        await call(TRANSITIONS, 'POST', item.identifier, readOnly, {
          body: { status: 'in_progress' },
        })
      ).status,
    ).toBe(403);
  });

  it('404s a cross-tenant target on BOTH methods', async () => {
    const other = await createV1ProjectCaller({ workspaceName: 'Theirs', identifier: 'OTHR' });
    const theirs = await workItemsService.createWorkItem(
      { projectId: other.fixture.projectId, kind: 'task', title: 'Theirs' },
      other.ctx,
    );

    expect((await call(TRANSITIONS, 'GET', theirs.identifier, caller)).status).toBe(404);
    expect(
      (
        await call(TRANSITIONS, 'POST', theirs.identifier, caller, {
          body: { status: 'in_progress' },
        })
      ).status,
    ).toBe(404);
  });
});
