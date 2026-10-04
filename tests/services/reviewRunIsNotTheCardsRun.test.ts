import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { howToTestService } from '@/lib/services/howToTestService';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';
import { setStatus } from '../helpers/repairFixtures';

// A REVIEW RUN IS NOT THE CARD'S RUN (Story MOTIR-1626 · found by MOTIR-6827's receipt;
// `hosted-agent-run.md` §8.1 / §8.3), over real Postgres.
//
// A review run reads a green card's pull requests and returns one verdict. It builds
// nothing, pushes nothing and holds no card, so no read that asks "what is this card's
// run?" may answer with it:
//   · the latest-run read behind To fix `run_died` and the continue claim — a review that
//     ended without a verdict is NOT a run that died on the card, and a review opened after
//     a build died must not hide that death;
//   · How to test's *Owed by* — a review writes no How to test and owes none.
// A `fix` repair keeps its own treatment (How to test already skips it; its death on an
// In Review card never reads `run_died`, the status refusal's rule — MOTIR-6928).

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function inProgressCard(fx: WorkItemFixture) {
  const card = await createTestWorkItem(fx, { kind: 'task', title: `card ${randomToken(4)}` });
  await setStatus(card.id, 'in_progress');
  return card;
}

async function open(fx: WorkItemFixture, key: string, command: 'run' | 'review') {
  const { run } = await dispatchRunService.open(
    {
      projectKey: fx.projectIdentifier,
      command,
      reportedBy: 'cli',
      origin: 'hosted',
      agent: 'opencode',
      model: 'm',
      idempotencyKey: `${command}-${randomToken(6)}`,
      cards: [{ key, disposition: 'queued' }],
    },
    fx.ctx,
  );
  return run.id;
}

/** A build run that pushed a branch — so its death is continuable. */
async function buildRun(fx: WorkItemFixture, key: string) {
  const runId = await open(fx, key, 'run');
  await dispatchRunService.appendEvents(
    runId,
    [
      {
        kind: 'checkout_ready',
        workItemKey: key,
        disposition: 'running',
        data: { branch: `subtask/${key}-work` },
      },
    ],
    fx.ctx,
  );
  return runId;
}

const fixReasonOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).fixReason;

describe('the latest-run read never answers with a review run', () => {
  it('a review run that ends without a verdict does not put run_died on the card', async () => {
    const fx = await makeWorkItemFixture();
    const card = await inProgressCard(fx);
    const reviewId = await open(fx, card.identifier, 'review');

    await dispatchRunService.close(reviewId, { stopReason: 'halted' }, fx.ctx);

    expect(await fixReasonOf(card.id)).toBeNull();
    const latest = await withWorkspaceContext(fx.ctx, (tx) =>
      dispatchRunRepository.findLatestForWorkItem(card.id, tx),
    );
    expect(latest).toBeNull();
  });

  it('a review run opened after a build died does not hide the death', async () => {
    const fx = await makeWorkItemFixture();
    const card = await inProgressCard(fx);
    const buildId = await buildRun(fx, card.identifier);
    await dispatchRunService.close(buildId, { stopReason: 'halted' }, fx.ctx);
    expect(await fixReasonOf(card.id)).toBe('run_died');

    const reviewId = await open(fx, card.identifier, 'review');
    expect(await fixReasonOf(card.id)).toBe('run_died');
    await dispatchRunService.close(reviewId, { stopReason: 'completed' }, fx.ctx);

    expect(await fixReasonOf(card.id)).toBe('run_died');
    const latest = await withWorkspaceContext(fx.ctx, (tx) =>
      dispatchRunRepository.findLatestForWorkItem(card.id, tx),
    );
    expect(latest).toMatchObject({ id: buildId, command: 'run' });
  });
});

describe('How to test is never owed by a review run', () => {
  it('names the build run behind the newer review run', async () => {
    const fx = await makeWorkItemFixture();
    const card = await inProgressCard(fx);
    const buildId = await buildRun(fx, card.identifier);
    await dispatchRunService.close(buildId, { stopReason: 'completed' }, fx.ctx);
    const reviewId = await open(fx, card.identifier, 'review');
    await dispatchRunService.close(reviewId, { stopReason: 'completed' }, fx.ctx);

    const dto = await howToTestService.getForWorkItem(card.id, fx.ctx);

    expect(dto.state).toBe('record_missing');
    expect(dto.owedBy?.runId).toBe(buildId);
  });

  it('owes nothing when a review run is the only run', async () => {
    const fx = await makeWorkItemFixture();
    const card = await inProgressCard(fx);
    const reviewId = await open(fx, card.identifier, 'review');
    await dispatchRunService.close(reviewId, { stopReason: 'completed' }, fx.ctx);

    const dto = await howToTestService.getForWorkItem(card.id, fx.ctx);

    expect(dto.owedBy).toBeNull();
  });
});
