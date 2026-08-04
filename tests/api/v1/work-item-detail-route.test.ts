import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import {
  decodeWorkItemETag,
  encodeWorkItemETag,
  presentWorkItemDetail,
  presentWorkItemSummary,
  workItemDetailSchema,
} from '@/lib/api/v1/workItems/schema';
import { workItemsService } from '@/lib/services/workItemsService';
import { createTestLink, createTestWorkItem } from '../../fixtures';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// GET /api/v1/work-items/{key} + the v1 work-item SCHEMA MODULE
// (Story 11.2 · Subtask 11.2.2 — MOTIR-2040).
//
// The schema is the assertion. A body is checked by `parse`ing it against
// `workItemDetailSchema` rather than by a hand-written `toEqual`, so a mapper
// that emits a `Date`, a `null` where the contract says otherwise, or a field
// the schema never declared, fails HERE rather than reaching a client.

const BASE = 'http://localhost:3000/api/v1/work-items';

function url(key: string): string {
  return `${BASE}/${encodeURIComponent(key)}`;
}

/** Drive the real route handler the way Next.js does — params as a promise. */
async function get(key: string, caller: { headers: Record<string, string> }): Promise<Response> {
  const { GET } = await import('@/app/api/v1/work-items/[key]/route');
  return GET(new Request(url(key), { headers: caller.headers }), {
    params: Promise.resolve({ key }),
  });
}

/**
 * A cuid, as Prisma mints them (`c` + 24 base-36 chars) — the shape §7 forbids
 * as a WORK-ITEM identifier on the wire.
 */
const CUID = /\bc[a-z0-9]{24}\b/g;

describe('GET /api/v1/work-items/{key}', () => {
  let caller: V1ProjectCaller;

  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
    caller = await createV1ProjectCaller();
  });

  it('returns the detail resource, and the body PARSES against the schema', async () => {
    const item = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'Ship it' });

    const res = await get(item.identifier, caller);

    expect(res.status).toBe(200);
    const parsed = workItemDetailSchema.safeParse(await res.json());
    expect(parsed.success, JSON.stringify(parsed.error?.issues, null, 2)).toBe(true);
    expect(parsed.data?.key).toBe(item.identifier);
    expect(parsed.data?.title).toBe('Ship it');
  });

  it('is CASE-INSENSITIVE on the key, like every other Motir surface', async () => {
    const item = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'Lowercased' });

    const res = await get(item.identifier.toLowerCase(), caller);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ key: item.identifier });
  });

  it('carries lineage, children and the five link groups — empty groups as [], never absent', async () => {
    const epic = await createTestWorkItem(caller.fixture, { kind: 'epic', title: 'Epic' });
    const story = await createTestWorkItem(caller.fixture, {
      kind: 'story',
      title: 'Story',
      parentId: epic.id,
    });
    const child = await createTestWorkItem(caller.fixture, {
      kind: 'subtask',
      title: 'Child',
      parentId: story.id,
    });
    const blocker = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'Blocker' });
    await createTestLink({
      workspaceId: caller.fixture.workspaceId,
      fromId: story.id,
      toId: blocker.id,
      kind: 'is_blocked_by',
      createdById: caller.fixture.ownerId,
    });

    const res = await get(story.identifier, caller);
    const body = workItemDetailSchema.parse(await res.json());

    expect(body.parentKey).toBe(epic.identifier);
    expect(body.ancestorKeys).toEqual([epic.identifier]);
    expect(body.children.map((c) => c.key)).toEqual([child.identifier]);
    expect(body.links.blockedBy.map((b) => b.key)).toEqual([blocker.identifier]);
    // An absent key and an empty group are different things to a typed client.
    expect(body.links.blocks).toEqual([]);
    expect(body.links.relatesTo).toEqual([]);
    expect(body.links.duplicates).toEqual([]);
    expect(body.links.clones).toEqual([]);
    // The blocker is open, so the item is not ready and says which blocker.
    expect(body.readiness.ready).toBe(false);
    expect(body.readiness.openBlockers.map((b) => b.key)).toEqual([blocker.identifier]);
  });

  // ── ADR §7 — identifiers on the wire ──────────────────────────────────────
  it('names every WORK ITEM by its MOTIR-<n> key — no work-item cuid anywhere', async () => {
    const parent = await createTestWorkItem(caller.fixture, { kind: 'story', title: 'Parent' });
    const item = await createTestWorkItem(caller.fixture, {
      kind: 'subtask',
      title: 'Child',
      parentId: parent.id,
    });
    const linked = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'Linked' });
    await createTestLink({
      workspaceId: caller.fixture.workspaceId,
      fromId: item.id,
      toId: linked.id,
      kind: 'relates_to',
      createdById: caller.fixture.ownerId,
    });

    const body = await (await get(item.identifier, caller)).json();
    const serialised = JSON.stringify(body);

    // The EXACT ids this read touched, asserted individually — stronger than a
    // shape regex, because it names the leak rather than guessing at its form.
    for (const [label, id] of [
      ['the item itself', item.id],
      ['its parent', parent.id],
      ['a link target', linked.id],
    ] as const) {
      expect(serialised, `${label}'s cuid must not appear on the wire`).not.toContain(id);
    }

    // And nothing cuid-SHAPED survives ANYWHERE except the recorded keyless
    // exceptions — a USER id (assignee / reporter) and a SPRINT id, neither of
    // which has a `MOTIR-<n>` key to be named by. Enumerated rather than
    // pattern-excused: every remaining cuid must be one of these exact values,
    // so a NEW cuid appearing in a new field fails here.
    const allowed = new Set(
      [body.assigneeId, body.reporterId, body.sprintId].filter(
        (value): value is string => typeof value === 'string',
      ),
    );
    expect(allowed.has(caller.fixture.ownerId), 'reporterId is the owner').toBe(true);

    const leaked = (serialised.match(CUID) ?? []).filter((id) => !allowed.has(id));
    expect(leaked, `unexpected cuid(s) on the wire: ${leaked.join(', ')}`).toEqual([]);
  });

  // ── Existence-oracle behaviour: three causes, one answer ───────────────────
  it('answers 404 identically for unknown, cross-workspace, and unbrowsable', async () => {
    const mine = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'Mine' });
    const other = await createV1ProjectCaller({ workspaceName: 'Theirs', identifier: 'OTHR' });
    const theirs = await createTestWorkItem(other.fixture, { kind: 'task', title: 'Theirs' });

    const unknown = await get(`${caller.projectKey}-999999`, caller);
    const foreignItem = await get(theirs.identifier, caller);
    const foreignProject = await get(`${other.projectKey}-1`, caller);

    for (const [label, res] of [
      ['an unknown key', unknown],
      ['a key in another workspace', foreignItem],
      ['a project key in another workspace', foreignProject],
    ] as const) {
      expect(res.status, `${label} → 404`).toBe(404);
      const body = (await res.json()) as { code: string; error: string };
      expect(typeof body.code).toBe('string');
      expect(typeof body.error).toBe('string');
    }
    // Sanity: the same route DOES answer for the caller's own item, so the 404s
    // above are the isolation rule and not a broken route.
    expect((await get(mine.identifier, caller)).status).toBe(200);
  });

  it('422s a MALFORMED key before any service call', async () => {
    const spy = vi.spyOn(workItemsService, 'getIssueDetail');
    try {
      for (const bad of ['nonsense', 'PROD-', '-7', 'PROD-abc', '']) {
        const res = await get(bad, caller);
        expect(res.status, `'${bad}' is malformed → 422`).toBe(422);
        await expect(res.json()).resolves.toMatchObject({ code: 'INVALID_WORK_ITEM_KEY' });
      }
      expect(spy, 'no read may be attempted for a malformed key').not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('401s without a credential, and 403s a token lacking `read`', async () => {
    const item = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'Guarded' });
    const { GET } = await import('@/app/api/v1/work-items/[key]/route');

    const anonymous = await GET(new Request(url(item.identifier)), {
      params: Promise.resolve({ key: item.identifier }),
    });
    expect(anonymous.status).toBe(401);

    const wrongScope = await createV1ProjectCaller({ scopes: ['integration'] });
    const scoped = await get(item.identifier, wrongScope);
    expect(scoped.status).toBe(403);
    await expect(scoped.json()).resolves.toMatchObject({ code: 'INSUFFICIENT_SCOPE' });
  });

  // ── The ETag ──────────────────────────────────────────────────────────────
  it('issues an ETag that CHANGES when the item is updated', async () => {
    const item = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'Versioned' });

    const first = (await get(item.identifier, caller)).headers.get('etag');
    expect(first).toBeTruthy();

    await workItemsService.updateWorkItem(item.id, { title: 'Versioned again' }, caller.ctx);
    const second = (await get(item.identifier, caller)).headers.get('etag');

    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    // …and it pins the NEW version, which is what `If-Match` will assert.
    const before = decodeWorkItemETag(first as string);
    const after = decodeWorkItemETag(second as string);
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it('is OPAQUE — the timestamp cannot be read back out of it', async () => {
    const item = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'Opaque' });
    const detail = await workItemsService.getIssueDetail(
      caller.fixture.projectId,
      item.identifier,
      caller.ctx,
    );

    const etag = (await get(item.identifier, caller)).headers.get('etag') as string;

    // Neither the ISO string nor its parts survive into the validator, in any
    // of the encodings a client would actually try.
    const updatedAt = detail.item.updatedAt;
    expect(etag).not.toContain(updatedAt);
    expect(etag).not.toContain(String(Date.parse(updatedAt)));
    const decodedBytes = Buffer.from(etag.replace(/"/g, ''), 'base64url').toString('utf8');
    expect(decodedBytes).not.toContain(updatedAt.slice(0, 4)); // not even the year
    // But OUR decoder still recovers it — one function owns both directions.
    expect(decodeWorkItemETag(etag).toISOString()).toBe(new Date(updatedAt).toISOString());
  });
});

describe('the v1 work-item ETag', () => {
  const AT = '2026-08-03T12:00:00.000Z';

  it('round-trips through encode → decode', () => {
    expect(decodeWorkItemETag(encodeWorkItemETag(AT)).toISOString()).toBe(AT);
  });

  it('accepts the weak-validator and unquoted forms a client may send back', () => {
    const etag = encodeWorkItemETag(AT);
    expect(decodeWorkItemETag(`W/${etag}`).toISOString()).toBe(AT);
    expect(decodeWorkItemETag(etag.replace(/"/g, '')).toISOString()).toBe(AT);
  });

  it('re-encodes the SAME instant to a DIFFERENT validator (fresh IV)', () => {
    // So two validators cannot be compared to infer that a row did not move.
    expect(encodeWorkItemETag(AT)).not.toBe(encodeWorkItemETag(AT));
  });

  it.each([
    ['garbage', 'not-a-validator'],
    ['empty', '""'],
    ['truncated', encodeWorkItemETag(AT).slice(0, 12) + '"'],
    ['tampered', `"${Buffer.from('x'.repeat(40), 'utf8').toString('base64url')}"`],
  ])('422s a %s validator rather than ignoring it', (_label, raw) => {
    // Never degrades to "no precondition": silently dropping an `If-Match` the
    // client sent would remove the exact guarantee it asked for.
    expect(() => decodeWorkItemETag(raw)).toThrowError(/valid ETag/);
  });
});

describe('the v1 work-item presenters', () => {
  it('shape FIELD BY FIELD — an unexpected DTO property does NOT reach the wire', () => {
    const summary = presentWorkItemSummary({
      identifier: 'PROD-1',
      kind: 'task',
      type: 'code',
      title: 'T',
      status: 'todo',
      priority: 'medium',
      assigneeId: null,
      reporterId: 'u1',
      dueDate: null,
      estimateMinutes: null,
      storyPoints: null,
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
      // A column a later migration adds, arriving through the DTO. It must NOT
      // become public API by accident — the hazard `GET /api/v1/me` records one
      // layer down when it refuses to spread a Prisma row.
      internalSecret: 'do-not-ship',
    } as Parameters<typeof presentWorkItemSummary>[0] & { internalSecret: string });

    expect(Object.keys(summary)).not.toContain('internalSecret');
    expect(JSON.stringify(summary)).not.toContain('do-not-ship');
  });

  it('leaves a parent it could not resolve as null rather than leaking the cuid', () => {
    // An ancestor outside what this read fetched. §7 forbids naming it by cuid
    // whatever the reason, so the reference degrades to null.
    const detail = presentWorkItemDetail(
      {
        item: {
          id: 'cmsdw87oz000004kvypsh8m9n',
          identifier: 'PROD-2',
          kind: 'subtask',
          type: null,
          title: 'Orphan',
          status: 'todo',
          priority: 'medium',
          assigneeId: null,
          reporterId: 'u1',
          dueDate: null,
          estimateMinutes: null,
          storyPoints: null,
          descriptionMd: null,
          sprintId: null,
          targetRepo: null,
          executor: null,
          planningSource: null,
          planningHarness: null,
          planningModel: null,
          implementationSource: null,
          implementationHarness: null,
          implementationModel: null,
          archivedAt: null,
          createdAt: '2026-08-03T00:00:00.000Z',
          updatedAt: '2026-08-03T00:00:00.000Z',
        },
        ancestors: [],
        parent: null,
        children: [
          {
            id: 'cmsdw87oz000004kvypsh8m9y',
            parentId: 'cmsdw87oz000004kvypsh8unk', // never resolved by this read
            kind: 'subtask',
            key: 3,
            identifier: 'PROD-3',
            title: 'Kid',
            status: 'todo',
            priority: 'medium',
            assigneeId: null,
            position: 'a0',
            estimateMinutes: null,
            storyPoints: null,
            archivedAt: null,
          },
        ],
        blockedBy: [],
        blocks: [],
        relatesTo: [],
        duplicates: [],
        clones: [],
        readiness: { ready: true, openBlockers: [], blockedByAncestor: null },
        labels: [],
        components: [],
      } as unknown as Parameters<typeof presentWorkItemDetail>[0],
      0,
    );

    expect(detail.children[0]?.parentKey).toBeNull();
    expect(JSON.stringify(detail)).not.toContain('cmsdw87oz000004kvypsh8unk');
  });
});
