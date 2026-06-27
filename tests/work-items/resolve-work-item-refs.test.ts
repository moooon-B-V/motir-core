import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { inngest } from '@/lib/jobs/client';
import { workItemsService } from '@/lib/services/workItemsService';
import { parseWorkItemRefs } from '@/lib/mentions/workItemRefs';
import type { WorkItemDto } from '@/lib/dto/workItems';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture } from '../fixtures';
import { truncateAuthTables } from '../helpers/db';

// Read-side reference resolution (Story 5.8 · Subtask 5.8.6) — the batched
// `workItemsService.resolveReferenceSummaries`, which turns the references
// parsed out of a body / title into the LIVE summaries the internal-link chip +
// title-linkify render (current key · title · status · archived / accessible
// state). Real Postgres; the only stubbed seam is Inngest `send()` (post-commit
// events the create hooks fan out, irrelevant here). Items are created through
// `workItemsService.createWorkItem` so each carries a valid fractional position.

beforeEach(async () => {
  await truncateAuthTables();
  vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

function makeItem(
  projectId: string,
  ctx: ServiceContext,
  title: string,
  extra: Record<string, unknown> = {},
): Promise<WorkItemDto> {
  return workItemsService.createWorkItem({ projectId, kind: 'task', title, ...extra }, ctx);
}

describe('resolveReferenceSummaries', () => {
  it('resolves a token id to the live summary, keyed by id AND current identifier', async () => {
    const fx = await makeWorkItemFixture();
    const target = await makeItem(fx.projectId, fx.ctx, 'Issue-tree generation');

    const map = await workItemsService.resolveReferenceSummaries(
      { ids: [target.id], keys: [] },
      fx.projectId,
      fx.ctx,
    );

    const byId = map[target.id];
    expect(byId?.accessible).toBe(true);
    if (byId?.accessible) {
      expect(byId.identifier).toBe(target.identifier);
      expect(byId.title).toBe('Issue-tree generation');
      expect(byId.archived).toBe(false);
      expect(byId.status).not.toBeNull();
      expect(byId.status?.category).toBe('todo'); // initial status category
    }
    // Also keyed by the current identifier (the title bare-key path).
    expect(map[target.identifier]).toEqual(byId);
  });

  it('marks an archived target accessible + archived (still resolvable)', async () => {
    const fx = await makeWorkItemFixture();
    const target = await makeItem(fx.projectId, fx.ctx, 'Old approach');
    await workItemsService.archiveWorkItem(target.id, fx.ctx);

    const map = await workItemsService.resolveReferenceSummaries(
      { ids: [target.id], keys: [] },
      fx.projectId,
      fx.ctx,
    );
    const s = map[target.id];
    expect(s?.accessible).toBe(true);
    if (s?.accessible) expect(s.archived).toBe(true);
  });

  it('omits a deleted / unresolvable id (rendered as a struck-through bare key)', async () => {
    const fx = await makeWorkItemFixture();
    const map = await workItemsService.resolveReferenceSummaries(
      { ids: ['cmdoesnotexist000'], keys: [] },
      fx.projectId,
      fx.ctx,
    );
    expect(map['cmdoesnotexist000']).toBeUndefined();
  });

  it('resolves a bare project key parsed from a title', async () => {
    const fx = await makeWorkItemFixture();
    const target = await makeItem(fx.projectId, fx.ctx, 'Generation engine');

    const refs = parseWorkItemRefs(
      `Wire ${target.identifier} into onboarding`,
      fx.projectIdentifier,
    );
    expect(refs.keys).toContain(target.identifier);

    const map = await workItemsService.resolveReferenceSummaries(refs, fx.projectId, fx.ctx);
    const s = map[target.identifier];
    expect(s?.accessible).toBe(true);
    if (s?.accessible) expect(s.title).toBe('Generation engine');
  });

  it('returns an empty map for no references', async () => {
    const fx = await makeWorkItemFixture();
    const map = await workItemsService.resolveReferenceSummaries(
      { ids: [], keys: [] },
      fx.projectId,
      fx.ctx,
    );
    expect(map).toEqual({});
  });
});
