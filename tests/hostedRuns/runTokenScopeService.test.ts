import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { DispatchRunTokenOutOfScopeError } from '@/lib/dispatchRuns/errors';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { runTokenScopeService } from '@/lib/services/runTokenScopeService';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// WHICH CARDS A RUN TOKEN MAY TOUCH (MOTIR-6557) — coverage top-up (MOTIR-692).
//
// `tests/api/v1/run-credential-legs.test.ts` already drives this service
// exhaustively through every route a run token reaches, over a run that
// EXISTS. What it never has reason to construct is the run's OWN absence, or
// a leg with no card at all — both real shapes `assertReachesWorkItemsIn`
// defends against, and neither reachable from a route whose binding already
// requires the run to exist. Direct calls, against a real Postgres.

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('assertReachesWorkItems — a no-op for anything that is not a run token', () => {
  it('does nothing when the context carries no tokenDispatchRunId', async () => {
    await expect(
      runTokenScopeService.assertReachesWorkItems(['anything'], {
        userId: fx.ownerId,
        workspaceId: fx.workspaceId,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('a run token naming a run this transaction cannot find', () => {
  it('reaches nothing — every requested card is refused, not merely the missing run', async () => {
    const card = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'a card' },
      fx.ctx,
    );
    await expect(
      runTokenScopeService.assertReachesWorkItems([card.id], {
        userId: fx.ownerId,
        workspaceId: fx.workspaceId,
        tokenDispatchRunId: 'no-such-run',
      }),
    ).rejects.toBeInstanceOf(DispatchRunTokenOutOfScopeError);
  });
});

describe('a leg recorded with no work item at all', () => {
  it('contributes nothing reachable — a skipped leg is not a back door to its neighbours', async () => {
    const card = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'a real leg' },
      fx.ctx,
    );
    const outside = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'outside the run' },
      fx.ctx,
    );
    const { run } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run',
        reportedBy: 'cli',
        origin: 'hosted',
        model: 'claude-opus-5-5',
        cards: [{ key: card.identifier, disposition: 'queued' as const }],
      },
      fx.ctx,
    );
    // A second leg with no work item — the shape a skipped/unresolved card
    // takes on the run's own row set.
    await adminDb.dispatchRunCard.create({
      data: {
        workspaceId: fx.workspaceId,
        dispatchRunId: run.id,
        workItemKey: 'SKIPPED-1',
        workItemId: null,
        position: 1,
        disposition: 'skipped',
        skipReason: 'needs_planning',
      },
    });

    const ctx = { userId: fx.ownerId, workspaceId: fx.workspaceId, tokenDispatchRunId: run.id };
    // The real leg is reachable…
    await expect(
      withWorkspaceContext(ctx, (tx) =>
        runTokenScopeService.assertReachesWorkItemsIn([card.id], ctx, tx),
      ),
    ).resolves.toBeUndefined();
    // …a card outside the run still is not, and the null-work-item leg added
    // nothing to what is reachable.
    await expect(
      withWorkspaceContext(ctx, (tx) =>
        runTokenScopeService.assertReachesWorkItemsIn([outside.id], ctx, tx),
      ),
    ).rejects.toBeInstanceOf(DispatchRunTokenOutOfScopeError);
  });
});
