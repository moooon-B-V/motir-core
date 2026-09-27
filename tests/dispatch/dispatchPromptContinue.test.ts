import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { ContinueFromInvalidError } from '@/lib/dispatchRuns/errors';
import { dispatchPromptService } from '@/lib/services/dispatchPromptService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';
import { connectRepairRepo, deliveredPr, setStatus } from '../helpers/repairFixtures';

// `dispatch-prompt?continueFrom=` (Story MOTIR-6526 · MOTIR-6531) — the SERVICE
// half: the run it names is validated against the item, and the branch is the
// open pull request's head, else the one the run recorded on `checkout_ready`.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function runOver(
  fx: WorkItemFixture,
  key: string,
  branch: string | null,
  close: 'halted' | 'completed' | null,
) {
  const { run } = await dispatchRunService.open(
    { projectKey: fx.projectIdentifier, command: 'run', cards: [{ key, disposition: 'queued' }] },
    fx.ctx,
  );
  await dispatchRunService.appendEvents(
    run.id,
    [{ kind: 'checkout_ready', workItemKey: key, disposition: 'running', data: { branch } }],
    fx.ctx,
  );
  if (close) await dispatchRunService.close(run.id, { stopReason: close }, fx.ctx);
  return run.id;
}

const prompt = (fx: WorkItemFixture, key: string, continueFrom: string) =>
  dispatchPromptService.getDispatchPrompt(fx.projectId, key, fx.ctx, { continueFrom });

describe('getDispatchPrompt with continueFrom', () => {
  it('continues a dead run on the branch its checkout_ready recorded', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'the card' });
    await setStatus(card.id, 'in_progress');
    const runId = await runOver(fx, card.identifier, 'subtask/recorded-branch', 'halted');

    const dto = await prompt(fx, card.identifier, runId);

    expect(dto.branch).toBe('subtask/recorded-branch');
    expect(dto.prompt).toContain('CONTINUE — you are carrying on a run that DIED');
    expect(dto.prompt).toContain('It ended: the agent exited with an error.');
    expect(dto.prompt).toContain('git worktree add ');
    expect(dto.prompt).toContain(' subtask/recorded-branch');
  });

  it('prefers the item’s OPEN pull request head', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'the card' });
    await setStatus(card.id, 'in_progress');
    const runId = await runOver(fx, card.identifier, 'subtask/recorded-branch', 'halted');
    const repo = await connectRepairRepo(fx, `web-${randomToken(4)}`);
    await deliveredPr(fx, card.id, repo, {
      headRef: 'subtask/the-pr',
      baseRef: 'main',
      checks: {},
    });

    const dto = await prompt(fx, card.identifier, runId);

    expect(dto.branch).toBe('subtask/the-pr');
    expect(dto.prompt).toContain(`acme/${repo.name} #`);
  });

  it('refuses a run that is still open, one that succeeded, and one that is not this item’s', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'the card' });
    const other = await createTestWorkItem(fx, { kind: 'task', title: 'another card' });

    const open = await runOver(fx, card.identifier, 'b1', null);
    const succeeded = await runOver(fx, card.identifier, 'b2', 'completed');
    const foreign = await runOver(fx, other.identifier, 'b3', 'halted');

    for (const [runId, why] of [
      [open, 'still_running'],
      [succeeded, 'succeeded'],
      [foreign, 'unknown'],
      ['run_does_not_exist', 'unknown'],
    ] as const) {
      const err = await prompt(fx, card.identifier, runId).catch((e: unknown) => e);
      expect(err, runId).toBeInstanceOf(ContinueFromInvalidError);
      expect((err as ContinueFromInvalidError).why).toBe(why);
    }
  });

  it('refuses another WORKSPACE’s run exactly as an unknown one', async () => {
    const fx = await makeWorkItemFixture();
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'the card' });
    const theirs = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const theirCard = await createTestWorkItem(theirs, { kind: 'task', title: 'theirs' });
    const theirRun = await runOver(theirs, theirCard.identifier, 'b', 'halted');

    const err = await prompt(fx, card.identifier, theirRun).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContinueFromInvalidError);
    expect((err as ContinueFromInvalidError).code).toBe('CONTINUE_FROM_INVALID');
  });
});
