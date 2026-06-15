import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { triageService } from '@/lib/services/triageService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import {
  InvalidTriageCursorError,
  TRIAGE_QUEUE_DEFAULT_LIMIT,
  TRIAGE_QUEUE_MAX_LIMIT,
  clampTriageLimit,
  decodeTriageCursor,
  encodeTriageCursor,
} from '@/lib/triage/triageQueue';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// Triage schema + read-exclusion invariant + the queue read (Subtask 6.11.3,
// per docs/decisions/triage-model.md). Real Postgres (the standing rule). The
// model: a submission IS a `work_item` carrying a `triagedAt` marker that hides
// it from EVERY normal read; the triage-queue read is the ONE read that returns
// only those items. createTestProject auto-seeds the default workflow (`todo`
// initial / category todo; `cancelled` terminal / category done).
//
// 6.11.8 ships the comprehensive parameterized read-set guard + the action
// post-states; THIS file locks the 6.11.3 deliverables — the exclusion at every
// read I threaded the shared fragment through, and the queue read's filters
// (snooze / terminal), cursor pagination, and submitter attribution.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

async function createItem(
  fx: WorkItemFixture,
  opts: { kind?: 'task' | 'bug'; title?: string; descriptionMd?: string } = {},
) {
  return workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: opts.kind ?? 'task',
      title: opts.title ?? 'Item',
      descriptionMd: opts.descriptionMd ?? null,
    },
    fx.ctx,
  );
}

/**
 * Mark an existing work item as a triage submission (stand-in for the 6.11.4
 * intake path, which doesn't exist yet). Tests may write the repo/db directly.
 */
async function markTriage(
  id: string,
  opts: {
    triagedAt?: Date;
    snoozedUntil?: Date | null;
    status?: string;
    external?: { name: string; email: string };
  } = {},
) {
  await db.workItem.update({
    where: { id },
    data: {
      triagedAt: opts.triagedAt ?? new Date(),
      snoozedUntil: opts.snoozedUntil ?? null,
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.external
        ? { externalSubmitterName: opts.external.name, externalSubmitterEmail: opts.external.email }
        : {}),
    },
  });
}

const SORT = { column: 'key', direction: 'asc' } as const;

describe('triage read-exclusion — a triage item is absent from EVERY normal read', () => {
  it('the shared not-in-triage fragment hides a triage item across tree / list / board / ready / search / backlog / picker, while a normal item stays', async () => {
    const fx = await makeWorkItemFixture();
    const normal = await createItem(fx, { kind: 'task', title: 'Normal planned work' });
    const triaged = await createItem(fx, { kind: 'bug', title: 'Normal planned work too' });
    await markTriage(triaged.id);

    const status = normal.status; // the workflow initial status key (category todo)

    // Each runner returns the ids the read surfaces. The triage item must be in
    // NONE of them; the normal item in all (it satisfies each read's shape).
    const reads: Array<{ name: string; ids: () => Promise<string[]> }> = [
      {
        name: 'findProjectForest (tree)',
        ids: async () =>
          (await workItemRepository.findProjectForest(fx.projectId, fx.workspaceId)).map(
            (r) => r.id,
          ),
      },
      {
        name: 'findProjectTreeLevel (lazy tree roots)',
        ids: async () =>
          (
            await workItemRepository.findProjectTreeLevel(
              fx.projectId,
              fx.workspaceId,
              null,
              SORT,
              {
                take: 100,
                offset: 0,
              },
            )
          ).map((r) => r.id),
      },
      {
        name: 'findProjectIssuesFlat (list)',
        ids: async () =>
          (await workItemRepository.findProjectIssuesFlat(fx.projectId, fx.workspaceId, SORT)).map(
            (r) => r.id,
          ),
      },
      {
        name: 'findColumnCards (board column)',
        ids: async () =>
          (
            await workItemRepository.findColumnCards(
              fx.projectId,
              fx.workspaceId,
              [status],
              'position',
              {
                limit: 100,
              },
            )
          ).map((r) => r.id),
      },
      {
        name: 'findReadyCandidates (ready set)',
        ids: async () =>
          (
            await workItemRepository.findReadyCandidates(fx.projectId, fx.workspaceId, {
              limit: 100,
            })
          ).map((r) => r.id),
      },
      {
        name: 'quickSearch (search)',
        ids: async () =>
          (
            await workItemRepository.quickSearch(fx.workspaceId, [fx.projectId], 'planned', 100)
          ).map((r) => r.id),
      },
      {
        name: 'findBacklogPage (backlog)',
        ids: async () =>
          (
            await workItemRepository.findBacklogPage(fx.projectId, fx.workspaceId, { take: 100 })
          ).map((r) => r.id),
      },
      {
        name: 'findByProjectAndKinds (parent picker)',
        ids: async () =>
          (
            await workItemRepository.findByProjectAndKinds(
              fx.projectId,
              ['task', 'bug', 'story', 'epic'],
              fx.workspaceId,
            )
          ).map((r) => r.id),
      },
    ];

    for (const read of reads) {
      const ids = await read.ids();
      expect(ids, `${read.name} must exclude the triage item`).not.toContain(triaged.id);
      expect(ids, `${read.name} must still return the normal item`).toContain(normal.id);
    }

    // Counts track their list reads.
    expect(await workItemRepository.countProjectIssues(fx.projectId, fx.workspaceId)).toBe(1);
    expect(await workItemRepository.countBacklog(fx.projectId, fx.workspaceId)).toBe(1);

    // The queue read is the ONE inclusion read: triage in, normal out.
    const queue = await workItemRepository.findTriageQueue(fx.projectId, fx.workspaceId, {
      limit: 100,
    });
    expect(queue.map((r) => r.id)).toEqual([triaged.id]);
  });

  it('a FilterAST search read also excludes triage (the fragment is ANDed outside the user filter)', async () => {
    const fx = await makeWorkItemFixture();
    const normal = await createItem(fx, { kind: 'bug', title: 'Findable bug alpha' });
    const triaged = await createItem(fx, { kind: 'bug', title: 'Findable bug beta' });
    await markTriage(triaged.id);

    // A kind=bug FilterAST over the flat list (the saved-filter/search path).
    const filter = {
      ast: {
        combinator: 'and' as const,
        conditions: [{ field: 'kind' as const, operator: 'is_any_of' as const, value: ['bug'] }],
      },
    };
    const rows = await workItemRepository.findProjectIssuesFlat(
      fx.projectId,
      fx.workspaceId,
      SORT,
      filter,
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(normal.id);
    expect(ids).not.toContain(triaged.id);
  });
});

describe('findTriageQueue — the active inbox read', () => {
  it('excludes currently-snoozed items but includes ones whose snooze has elapsed', async () => {
    const fx = await makeWorkItemFixture();
    const active = await createItem(fx, { title: 'Active triage item' });
    const snoozedFuture = await createItem(fx, { title: 'Snoozed into the future' });
    const snoozedPast = await createItem(fx, { title: 'Snooze already elapsed' });
    await markTriage(active.id);
    await markTriage(snoozedFuture.id, { snoozedUntil: new Date(Date.now() + 60 * 60 * 1000) });
    await markTriage(snoozedPast.id, { snoozedUntil: new Date(Date.now() - 60 * 60 * 1000) });

    const ids = (
      await workItemRepository.findTriageQueue(fx.projectId, fx.workspaceId, { limit: 100 })
    ).map((r) => r.id);
    expect(ids).toContain(active.id);
    expect(ids).toContain(snoozedPast.id);
    expect(ids).not.toContain(snoozedFuture.id);
  });

  it('excludes declined/merged items (terminal `cancelled`, category done) while they stay out of the tree', async () => {
    const fx = await makeWorkItemFixture();
    const declined = await createItem(fx, { kind: 'bug', title: 'Declined submission' });
    // Decline = cancel to a terminal status but KEEP the triage marker (ADR §5).
    await markTriage(declined.id, { status: 'cancelled' });

    const queueIds = (
      await workItemRepository.findTriageQueue(fx.projectId, fx.workspaceId, { limit: 100 })
    ).map((r) => r.id);
    expect(queueIds).not.toContain(declined.id);

    // …and still absent from the planned tree (the marker, not the status, gates it).
    const treeIds = (await workItemRepository.findProjectForest(fx.projectId, fx.workspaceId)).map(
      (r) => r.id,
    );
    expect(treeIds).not.toContain(declined.id);
  });

  it('orders newest-first and pages deterministically via the (triagedAt, id) cursor', async () => {
    const fx = await makeWorkItemFixture();
    const a = await createItem(fx, { title: 'Oldest' });
    const b = await createItem(fx, { title: 'Middle' });
    const c = await createItem(fx, { title: 'Newest' });
    await markTriage(a.id, { triagedAt: new Date('2026-06-10T00:00:00.000Z') });
    await markTriage(b.id, { triagedAt: new Date('2026-06-11T00:00:00.000Z') });
    await markTriage(c.id, { triagedAt: new Date('2026-06-12T00:00:00.000Z') });

    const page1 = await triageService.getTriageQueue(fx.projectId, { limit: 2 }, fx.ctx);
    expect(page1.items.map((i) => i.id)).toEqual([c.id, b.id]); // newest-first
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await triageService.getTriageQueue(
      fx.projectId,
      { limit: 2, cursor: page1.nextCursor! },
      fx.ctx,
    );
    expect(page2.items.map((i) => i.id)).toEqual([a.id]);
    expect(page2.nextCursor).toBeNull();
  });

  it('attributes a member submission to its reporter and an external one to its captured identity', async () => {
    const fx = await makeWorkItemFixture();
    const member = await createItem(fx, { title: 'Reported in-app' });
    const external = await createItem(fx, { title: 'Reported via portal' });
    await markTriage(member.id);
    await markTriage(external.id, {
      external: { name: 'Outside Person', email: 'outsider@example.com' },
    });

    const page = await triageService.getTriageQueue(fx.projectId, { limit: 100 }, fx.ctx);
    const byId = new Map(page.items.map((i) => [i.id, i]));

    const memberItem = byId.get(member.id)!;
    expect(memberItem.submitter.kind).toBe('member');
    expect(memberItem.submitter.userId).toBe(fx.ownerId);

    const externalItem = byId.get(external.id)!;
    expect(externalItem.submitter.kind).toBe('external');
    expect(externalItem.submitter.userId).toBeNull();
    expect(externalItem.submitter.email).toBe('outsider@example.com');
    expect(externalItem.submitter.name).toBe('Outside Person');
  });

  it('returns a bounded, ellipsised body snippet (never the full blob); null body → null snippet', async () => {
    const fx = await makeWorkItemFixture();
    const longBody = 'x'.repeat(500);
    const withBody = await createItem(fx, { title: 'Has a long body', descriptionMd: longBody });
    const noBody = await createItem(fx, { title: 'Has no body' });
    await markTriage(withBody.id);
    await markTriage(noBody.id);

    const page = await triageService.getTriageQueue(fx.projectId, { limit: 100 }, fx.ctx);
    const byId = new Map(page.items.map((i) => [i.id, i]));

    const snippet = byId.get(withBody.id)!.descriptionSnippet!;
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet.length).toBeLessThan(longBody.length); // bounded, not the full blob
    expect(byId.get(noBody.id)!.descriptionSnippet).toBeNull();
  });
});

describe('triageService.getTriageQueue — gate + cursor validation', () => {
  it('throws ProjectNotFoundError for a cross-workspace project (no existence leak)', async () => {
    const fx = await makeWorkItemFixture({ name: 'Tenant A', identifier: 'AAA' });
    const other = await makeWorkItemFixture({ name: 'Tenant B', identifier: 'BBB' });
    await expect(
      // fx's project id, but other tenant's ctx → must 404, never leak.
      triageService.getTriageQueue(fx.projectId, {}, other.ctx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('rejects a malformed cursor token', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      triageService.getTriageQueue(fx.projectId, { cursor: 'not-a-real-cursor' }, fx.ctx),
    ).rejects.toBeInstanceOf(InvalidTriageCursorError);
  });
});

describe('triage cursor codec + limit clamp (pure unit)', () => {
  it('round-trips a (voteCount, triagedAt, id) position', () => {
    const token = encodeTriageCursor({
      voteCount: 3,
      triagedAt: '2026-06-12T00:00:00.000Z',
      id: 'wi_1',
    });
    expect(decodeTriageCursor(token)).toEqual({
      voteCount: 3,
      triagedAt: '2026-06-12T00:00:00.000Z',
      id: 'wi_1',
    });
  });

  it('rejects malformed tokens (bad base64/JSON, bad vote count, bad date, empty id)', () => {
    expect(() => decodeTriageCursor('@@@not-base64@@@')).toThrow(InvalidTriageCursorError);
    expect(() => decodeTriageCursor(Buffer.from('{}', 'utf8').toString('base64url'))).toThrow(
      InvalidTriageCursorError,
    );
    // Legacy 2-tuple token (pre-6.12.6) is now malformed — must be rejected.
    expect(() =>
      decodeTriageCursor(
        Buffer.from('["2026-06-12T00:00:00.000Z","wi_1"]', 'utf8').toString('base64url'),
      ),
    ).toThrow(InvalidTriageCursorError);
    // Non-integer / negative vote count.
    expect(() =>
      decodeTriageCursor(
        Buffer.from('["x","2026-06-12T00:00:00.000Z","wi_1"]', 'utf8').toString('base64url'),
      ),
    ).toThrow(InvalidTriageCursorError);
    expect(() =>
      decodeTriageCursor(
        Buffer.from('[-1,"2026-06-12T00:00:00.000Z","wi_1"]', 'utf8').toString('base64url'),
      ),
    ).toThrow(InvalidTriageCursorError);
    expect(() =>
      decodeTriageCursor(Buffer.from('[0,"not-a-date","wi_1"]', 'utf8').toString('base64url')),
    ).toThrow(InvalidTriageCursorError);
    expect(() =>
      decodeTriageCursor(
        Buffer.from('[0,"2026-06-12T00:00:00.000Z",""]', 'utf8').toString('base64url'),
      ),
    ).toThrow(InvalidTriageCursorError);
  });

  it('clamps the limit into [1, MAX], defaulting a missing/invalid value', () => {
    expect(clampTriageLimit(undefined)).toBe(TRIAGE_QUEUE_DEFAULT_LIMIT);
    expect(clampTriageLimit(0)).toBe(TRIAGE_QUEUE_DEFAULT_LIMIT);
    expect(clampTriageLimit(-5)).toBe(TRIAGE_QUEUE_DEFAULT_LIMIT);
    expect(clampTriageLimit(10)).toBe(10);
    expect(clampTriageLimit(9999)).toBe(TRIAGE_QUEUE_MAX_LIMIT);
  });
});
