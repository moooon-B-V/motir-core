import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { dispatchPromptService } from '@/lib/services/dispatchPromptService';
import { HOW_TO_TEST_TOOL_NAME } from '@/lib/dispatch/promptTemplate';
import { createTestWorkItem, makeWorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// WHO publishes How to test, as the SERVICE resolves it (Story MOTIR-4906 ·
// MOTIR-5334): the dispatch prompt learns its item's RUN TARGET from the running
// run that carries the item, on real Postgres. A card inside a scoped run is told
// not to publish (the close-out writes on the scope); a card carried by an
// unscoped run, or by none, is its own target and is told to publish on itself.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('dispatchPromptService — the run target decides who publishes How to test', () => {
  it('a card carried by a RUNNING scoped run is told the scope is the run target', async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'Story' });
    const card = await createTestWorkItem(fx, {
      kind: 'subtask',
      type: 'code',
      title: 'Child',
      parentId: story.id,
    });
    await adminDb.dispatchRun.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        command: 'run_scope',
        status: 'running',
        scopeWorkItemId: story.id,
        cards: { create: { workspaceId: fx.workspaceId, workItemId: card.id, position: 0 } },
      },
    });

    const { prompt } = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      card.identifier,
      fx.ctx,
    );
    expect(prompt).not.toContain(HOW_TO_TEST_TOOL_NAME);
    expect(prompt.replace(/\n\s+/g, ' ')).toContain(
      `onto ${story.identifier}, by the run's close-out step`,
    );
  });

  it('a FINISHED scoped run no longer claims the card, and an unscoped run makes the card its own target', async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'Story' });
    const card = await createTestWorkItem(fx, {
      kind: 'subtask',
      type: 'code',
      title: 'Child',
      parentId: story.id,
    });
    const leg = { create: { workspaceId: fx.workspaceId, workItemId: card.id, position: 0 } };
    await adminDb.dispatchRun.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        command: 'run_scope',
        status: 'succeeded',
        scopeWorkItemId: story.id,
        cards: leg,
      },
    });
    await adminDb.dispatchRun.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        command: 'auto',
        status: 'running',
        cards: leg,
      },
    });

    const { prompt } = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      card.identifier,
      fx.ctx,
    );
    expect(prompt.replace(/\n\s+/g, ' ')).toContain(
      `ONCE, on ${card.identifier} (this item is the run's target)`,
    );
  });
});
