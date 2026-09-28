import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { parentStatusRollupService } from '@/lib/services/parentStatusRollupService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// A MARKED parent meets the parent rollup (Story MOTIR-6575 · MOTIR-6681) — against
// a REAL Postgres. A marked card stays finished, and `{ system: true }` does not
// exempt the mark, so the BACKWARD arm's set from a reopened child is refused; the
// rollup records `held_by_mark` instead of failing. Lives beside the rollup's own
// suites so the approved-status coverage lane
// (`vitest.coverage.approved-status.config.ts`), which measures
// `parentStatusRollupService.ts`, sees it. The job-level half (the run completes,
// nothing emitted) is `tests/integration/work-items/obsolescenceMovers.test.ts`.

const DB_TEST_TIMEOUT_MS = 30_000;

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function statusOf(id: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
}

describe('a marked parent stays finished', () => {
  it.each(['todo', 'in_progress', 'implemented'])(
    'a child back at `%s` would set the parent back — the rollup answers `held_by_mark` and moves nothing',
    { timeout: DB_TEST_TIMEOUT_MS },
    async (childStatus) => {
      const story = await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title: 'Story' },
        fx.ctx,
      );
      const child = await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'subtask', parentId: story.id, title: 'Child' },
        fx.ctx,
      );
      await adminDb.workItem.updateMany({
        where: { id: { in: [story.id, child.id] } },
        data: { status: 'done' },
      });
      await workItemsService.updateWorkItem(story.id, { obsolescence: 'deprecated' }, fx.ctx);
      await adminDb.workItem.update({ where: { id: child.id }, data: { status: childStatus } });

      const out = await parentStatusRollupService.recomputeParent(story.id, fx.workspaceId);

      expect(out).toMatchObject({ outcome: 'held_by_mark', parentId: story.id });
      expect(await statusOf(story.id)).toBe('done');
    },
  );
});
