import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { workItemDetailSchema } from '@/lib/api/v1/workItems/schema';
import { workItemsService } from '@/lib/services/workItemsService';
import { createTestWorkItem } from '../../fixtures';
import { createTestUser } from '../../fixtures/userFixtures';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// POST /api/v1/projects/{projectKey}/work-items + PATCH /api/v1/work-items/{key}
// (Story 11.2 · Subtask 11.2.6 — MOTIR-2046). The two mutations that make
// `/api/v1` a write surface rather than a read-only mirror.

const CUID = /\bc[a-z0-9]{24}\b/g;

async function post(
  caller: V1ProjectCaller,
  body: unknown,
  projectKey = caller.projectKey,
): Promise<Response> {
  const { POST } = await import('@/app/api/v1/projects/[projectKey]/work-items/route');
  return POST(
    new Request(`http://localhost:3000/api/v1/projects/${projectKey}/work-items`, {
      method: 'POST',
      headers: { ...caller.headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ projectKey }) },
  );
}

async function patch(
  caller: { headers: Record<string, string> },
  key: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const { PATCH } = await import('@/app/api/v1/work-items/[key]/route');
  return PATCH(
    new Request(`http://localhost:3000/api/v1/work-items/${key}`, {
      method: 'PATCH',
      headers: { ...caller.headers, 'content-type': 'application/json', ...extraHeaders },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ key }) },
  );
}

async function getItem(
  caller: { headers: Record<string, string> },
  key: string,
): Promise<Response> {
  const { GET } = await import('@/app/api/v1/work-items/[key]/route');
  return GET(
    new Request(`http://localhost:3000/api/v1/work-items/${key}`, { headers: caller.headers }),
    {
      params: Promise.resolve({ key }),
    },
  );
}

describe('POST /api/v1/projects/{projectKey}/work-items', () => {
  let caller: V1ProjectCaller;

  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
    caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
  });

  it('creates the item, returns 201 + Location, and the body parses against the schema', async () => {
    const res = await post(caller, { kind: 'task', title: 'Wire the webhook' });

    expect(res.status).toBe(201);
    const body = await res.json();
    const parsed = workItemDetailSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.data?.title).toBe('Wire the webhook');
    expect(res.headers.get('location')).toBe(`/api/v1/work-items/${parsed.data?.key}`);
    expect(res.headers.get('etag')).toBeTruthy();
  });

  // ⚠️ The whole reason MOTIR-2044 is a prerequisite of this endpoint.
  it('stamps planningSource = api SERVER-SIDE, read back from the row', async () => {
    const res = await post(caller, { kind: 'task', title: 'Attributed' });
    const { key } = (await res.json()) as { key: string };

    const row = await db.workItem.findFirst({ where: { identifier: key } });

    expect(row?.planningSource).toBe('api');
  });

  it('does not let a CLIENT claim a provenance it did not have', async () => {
    // `.strict()` on the request schema: provenance is not an accepted field, so
    // an attempt to self-report is a 422 rather than a silent, false attribution.
    const res = await post(caller, {
      kind: 'task',
      title: 'Liar',
      provenance: { planning: { source: 'native' } },
    });

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ code: 'INVALID_BODY' });
  });

  it('resolves parentKey to the parent, and never puts a cuid on the wire', async () => {
    const parent = await createTestWorkItem(caller.fixture, { kind: 'story', title: 'Parent' });

    const res = await post(caller, {
      kind: 'subtask',
      title: 'Child',
      parentKey: parent.identifier,
    });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.parentKey).toBe(parent.identifier);

    const allowed = new Set(
      [body.assigneeId, body.reporterId, body.sprintId].filter(
        (v): v is string => typeof v === 'string',
      ),
    );
    const leaked = (JSON.stringify(body).match(CUID) ?? []).filter((id) => !allowed.has(id));
    expect(leaked, 'parentKey included — no cuid names a work item').toEqual([]);
  });

  it('carries the leaf-authoring fields through', async () => {
    const res = await post(caller, {
      // `task`, not `subtask`: the kind-parent matrix requires a subtask to have
      // a parent, and this case is about the leaf-authoring FIELDS.
      kind: 'task',
      title: 'Fully specified',
      type: 'code',
      executor: 'coding_agent',
      storyPoints: 3,
      estimateMinutes: 45,
      priority: 'high',
    });
    const body = await res.json();

    expect(body).toMatchObject({
      type: 'code',
      executor: 'coding_agent',
      storyPoints: 3,
      estimateMinutes: 45,
      priority: 'high',
    });
  });

  it('maps a domain error rather than producing a bare 500', async () => {
    // An epic cannot be a subtask's parent — the kind-parent matrix. The service
    // raises a typed error; the row in DOMAIN_ERROR_STATUS is what turns it into
    // a 422 instead of an unexplained 500.
    const epic = await createTestWorkItem(caller.fixture, { kind: 'epic', title: 'Epic' });

    const res = await post(caller, {
      kind: 'epic',
      title: 'Nested epic',
      parentKey: epic.identifier,
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBeTruthy();
    expect(body.code).not.toBe('INTERNAL');
  });

  it('404s an unknown parentKey — not a 500', async () => {
    const res = await post(caller, {
      kind: 'subtask',
      title: 'Orphan',
      parentKey: `${caller.projectKey}-999999`,
    });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ code: 'WORK_ITEM_NOT_FOUND' });
  });

  it('403s a READ-ONLY token — and the refusal is not a 200 with an empty body', async () => {
    const readOnly = await createV1ProjectCaller({ scopes: ['read'] });

    const res = await post(readOnly, { kind: 'task', title: 'Nope' });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ code: 'INSUFFICIENT_SCOPE' });
  });

  it('404s a project in another workspace', async () => {
    const other = await createV1ProjectCaller({ workspaceName: 'Theirs', identifier: 'OTHR' });

    const res = await post(caller, { kind: 'task', title: 'Trespass' }, other.projectKey);

    expect(res.status).toBe(404);
  });

  it('422s a malformed body and an unknown field', async () => {
    expect((await post(caller, { kind: 'task' })).status).toBe(422); // no title
    expect((await post(caller, { kind: 'nonsense', title: 'x' })).status).toBe(422);
    expect((await post(caller, { kind: 'task', title: 'x', nope: 1 })).status).toBe(422);
  });
});

describe('PATCH /api/v1/work-items/{key}', () => {
  let caller: V1ProjectCaller;

  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
    caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
  });

  it('applies a partial update and leaves OMITTED fields untouched', async () => {
    const item = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'Before' });
    await workItemsService.updateWorkItem(
      item.id,
      { descriptionMd: 'keep me', priority: 'high' },
      caller.ctx,
    );

    const res = await patch(caller, item.identifier, { title: 'After' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.title).toBe('After');
    expect(body.descriptionMd, 'an omitted field is untouched').toBe('keep me');
    expect(body.priority).toBe('high');
    expect(workItemDetailSchema.safeParse(body).success).toBe(true);
  });

  it('CLEARS a nullable field on an explicit null — absent and null are different', async () => {
    const item = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'T' });
    await workItemsService.updateWorkItem(
      item.id,
      { descriptionMd: 'to be cleared', estimateMinutes: 30 },
      caller.ctx,
    );

    // Absent → untouched.
    const untouched = await (await patch(caller, item.identifier, { title: 'T2' })).json();
    expect(untouched.descriptionMd).toBe('to be cleared');
    expect(untouched.estimateMinutes).toBe(30);

    // Explicit null → cleared. This is the commonest PATCH defect, so both
    // directions are asserted per field class rather than assumed.
    const cleared = await (
      await patch(caller, item.identifier, { descriptionMd: null, estimateMinutes: null })
    ).json();
    expect(cleared.descriptionMd).toBeNull();
    expect(cleared.estimateMinutes).toBeNull();
  });

  it('re-files via parentKey and re-classifies via kind', async () => {
    const epic = await createTestWorkItem(caller.fixture, { kind: 'epic', title: 'Epic' });
    const item = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'Movable' });

    const refiled = await (
      await patch(caller, item.identifier, { kind: 'story', parentKey: epic.identifier })
    ).json();

    expect(refiled.kind).toBe('story');
    expect(refiled.parentKey).toBe(epic.identifier);
  });

  // ── If-Match / 412 ────────────────────────────────────────────────────────
  it('412s a STALE If-Match, succeeds with a fresh one, and succeeds without one', async () => {
    const item = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'Contended' });

    const stale = (await getItem(caller, item.identifier)).headers.get('etag') as string;
    expect(stale).toBeTruthy();

    // Someone else writes — the real concurrent update this guard exists for.
    await workItemsService.updateWorkItem(item.id, { title: 'Moved underneath' }, caller.ctx);

    const refused = await patch(caller, item.identifier, { title: 'Mine' }, { 'if-match': stale });
    expect(refused.status).toBe(412);
    await expect(refused.json()).resolves.toMatchObject({ code: 'STALE_WORK_ITEM' });

    // A FRESH validator succeeds…
    const fresh = (await getItem(caller, item.identifier)).headers.get('etag') as string;
    expect(fresh).not.toBe(stale);
    const accepted = await patch(caller, item.identifier, { title: 'Mine' }, { 'if-match': fresh });
    expect(accepted.status).toBe(200);

    // …and omitting If-Match is legal — last-write-wins, unchanged behaviour.
    const unconditional = await patch(caller, item.identifier, { title: 'No precondition' });
    expect(unconditional.status).toBe(200);
    await expect(unconditional.json()).resolves.toMatchObject({ title: 'No precondition' });
  });

  it('422s a malformed If-Match rather than silently ignoring the precondition', async () => {
    const item = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'T' });

    const res = await patch(caller, item.identifier, { title: 'X' }, { 'if-match': '"nonsense"' });

    // Dropping a precondition the client asked for is worse than refusing it.
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ code: 'INVALID_IF_MATCH' });
  });

  it('the ETag the READ issues is exactly what the WRITE accepts (one owner, both directions)', async () => {
    const item = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'Round trip' });

    const issued = (await getItem(caller, item.identifier)).headers.get('etag') as string;
    const res = await patch(caller, item.identifier, { title: 'Accepted' }, { 'if-match': issued });

    expect(res.status).toBe(200);
    // …and the write INVALIDATES the previous validator.
    const after = res.headers.get('etag');
    expect(after).not.toBe(issued);
    const replay = await patch(caller, item.identifier, { title: 'Again' }, { 'if-match': issued });
    expect(replay.status).toBe(412);
  });

  // ── Guards ────────────────────────────────────────────────────────────────
  it('403s a read-only token', async () => {
    const item = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'T' });
    const readOnly = await createV1ProjectCaller({ scopes: ['read'] });

    // NOTE: the read-only caller is a DIFFERENT tenant, so this also proves the
    // scope gate fires before anything tenant-specific could 404 first.
    const res = await patch(readOnly, item.identifier, { title: 'Nope' });

    expect(res.status).toBe(403);
  });

  it('404s an item in another workspace', async () => {
    const other = await createV1ProjectCaller({
      scopes: ['read', 'work_items:write'],
      workspaceName: 'Theirs',
      identifier: 'OTHR',
    });
    const theirs = await createTestWorkItem(other.fixture, { kind: 'task', title: 'Theirs' });

    const res = await patch(caller, theirs.identifier, { title: 'Trespass' });

    expect(res.status).toBe(404);
  });

  it('422s an unknown field rather than silently ignoring it', async () => {
    const item = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'T' });

    const res = await patch(caller, item.identifier, { titel: 'typo' });

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ code: 'INVALID_BODY' });
  });

  it('maps ASSIGNEE_NOT_IN_WORKSPACE rather than 500ing', async () => {
    const item = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'T' });
    const stranger = await createTestUser();

    const res = await patch(caller, item.identifier, { assigneeId: stranger.id });

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ code: 'ASSIGNEE_NOT_IN_WORKSPACE' });
  });
});
