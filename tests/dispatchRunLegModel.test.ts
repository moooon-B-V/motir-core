import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { DispatchRunEventModelNotAllowedError } from '@/lib/dispatchRuns/errors';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from './fixtures/workItemFixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// The leg's self-reported model (MOTIR-7502) — its one writer, the
// `agent_exited` append, against a real Postgres. The precedence (top-level,
// else `data.model`), the no-erase rule and the refusal are each asserted on the
// committed row, because each is a property of the transaction and not of a
// function a unit test could call.

let fixture: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fixture = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function openRun(): Promise<{ runId: string; key: string }> {
  const item = await workItemsService.createWorkItem(
    { projectId: fixture.projectId, kind: 'task', title: 'A card a run works' },
    fixture.ctx,
  );
  const { run } = await dispatchRunService.open(
    {
      projectKey: fixture.projectIdentifier,
      command: 'run',
      cards: [{ key: item.identifier, disposition: 'queued' }],
    },
    fixture.ctx,
  );
  return { runId: run.id, key: item.identifier };
}

async function legOf(runId: string) {
  return adminDb.dispatchRunCard.findFirstOrThrow({ where: { dispatchRunId: runId } });
}

describe('appendEvents writes the leg’s model from `agent_exited`', () => {
  it('a new leg reads `model = null`', async () => {
    const { runId } = await openRun();
    expect((await legOf(runId)).model).toBeNull();
  });

  it('writes the top-level model in the same transaction as the event and its exit code', async () => {
    const { runId, key } = await openRun();

    const result = await dispatchRunService.appendEvents(
      runId,
      [{ kind: 'agent_exited', workItemKey: key, exitCode: 0, model: 'claude-opus-5-5' }],
      fixture.ctx,
    );

    expect(result.cards).toEqual([
      expect.objectContaining({ key, exitCode: 0, model: 'claude-opus-5-5' }),
    ]);
    expect(await legOf(runId)).toMatchObject({ exitCode: 0, model: 'claude-opus-5-5' });
    expect(await adminDb.dispatchRunEvent.count({ where: { dispatchRunId: runId } })).toBe(1);
  });

  it('reads `data.model` when no top-level model is sent — the shape every installed CLI sends', async () => {
    const { runId, key } = await openRun();

    await dispatchRunService.appendEvents(
      runId,
      [
        {
          kind: 'agent_exited',
          workItemKey: key,
          exitCode: 1,
          data: { model: 'gpt-5', signal: null },
        },
      ],
      fixture.ctx,
    );

    expect(await legOf(runId)).toMatchObject({ exitCode: 1, model: 'gpt-5' });
  });

  it('prefers the top-level model over `data.model`, and trims what it writes', async () => {
    const { runId, key } = await openRun();

    await dispatchRunService.appendEvents(
      runId,
      [
        {
          kind: 'agent_exited',
          workItemKey: key,
          model: '  claude-opus-5-5 ',
          data: { model: 'gpt-5' },
        },
      ],
      fixture.ctx,
    );

    expect((await legOf(runId)).model).toBe('claude-opus-5-5');
  });

  it.each([
    ['blank', { model: '' }],
    ['whitespace-only', { model: '   ' }],
    ['non-string', { model: 42 }],
    ['over 200 characters', { model: 'm'.repeat(201) }],
    ['blank in data', { data: { model: '' } }],
    ['whitespace-only in data', { data: { model: '   ' } }],
    ['non-string in data', { data: { model: 42 } }],
    ['over 200 characters in data', { data: { model: 'm'.repeat(201) } }],
  ] as const)('an invalid model (%s) leaves the leg’s model as it was', async (_label, extra) => {
    const { runId, key } = await openRun();
    await dispatchRunService.appendEvents(
      runId,
      [{ kind: 'agent_exited', workItemKey: key, model: 'first-model' }],
      fixture.ctx,
    );

    await dispatchRunService.appendEvents(
      runId,
      [{ kind: 'agent_exited', workItemKey: key, exitCode: 2, ...extra }],
      fixture.ctx,
    );

    // The exit code still lands — only the model is left alone.
    expect(await legOf(runId)).toMatchObject({ exitCode: 2, model: 'first-model' });
  });

  it('a later `agent_exited` with no model never erases one the leg already carries', async () => {
    const { runId, key } = await openRun();
    await dispatchRunService.appendEvents(
      runId,
      [{ kind: 'agent_exited', workItemKey: key, model: 'claude-opus-5-5' }],
      fixture.ctx,
    );

    await dispatchRunService.appendEvents(
      runId,
      [
        { kind: 'agent_exited', workItemKey: key, exitCode: 0 },
        { kind: 'agent_exited', workItemKey: key, model: null, data: { model: null } },
      ],
      fixture.ctx,
    );

    expect((await legOf(runId)).model).toBe('claude-opus-5-5');
  });

  it('a valid later report replaces an earlier one — the leg holds the latest agent’s model', async () => {
    const { runId, key } = await openRun();
    await dispatchRunService.appendEvents(
      runId,
      [
        { kind: 'agent_exited', workItemKey: key, model: 'gpt-5' },
        { kind: 'agent_exited', workItemKey: key, model: 'claude-opus-5-5' },
      ],
      fixture.ctx,
    );

    expect((await legOf(runId)).model).toBe('claude-opus-5-5');
  });

  it('a RUN-scoped `agent_exited` names no leg and writes nothing', async () => {
    const { runId } = await openRun();
    await dispatchRunService.appendEvents(
      runId,
      [{ kind: 'agent_exited', model: 'claude-opus-5-5' }],
      fixture.ctx,
    );

    expect((await legOf(runId)).model).toBeNull();
  });

  it('never reads `data.model` off any other kind', async () => {
    const { runId, key } = await openRun();
    await dispatchRunService.appendEvents(
      runId,
      [{ kind: 'card_settled', workItemKey: key, data: { model: 'gpt-5' } }],
      fixture.ctx,
    );

    expect((await legOf(runId)).model).toBeNull();
  });

  it('refuses `model` on any other kind by name, and writes NO event of the batch', async () => {
    const { runId, key } = await openRun();

    const refusal = dispatchRunService.appendEvents(
      runId,
      [
        { kind: 'agent_exited', workItemKey: key, model: 'claude-opus-5-5' },
        { kind: 'agent_started', workItemKey: key, model: 'claude-opus-5-5' },
      ],
      fixture.ctx,
    );
    await expect(refusal).rejects.toBeInstanceOf(DispatchRunEventModelNotAllowedError);
    await expect(refusal).rejects.toMatchObject({
      code: 'DISPATCH_RUN_EVENT_MODEL_NOT_ALLOWED',
      field: 'model',
      kind: 'agent_started',
    });

    expect(await adminDb.dispatchRunEvent.count({ where: { dispatchRunId: runId } })).toBe(0);
    expect((await legOf(runId)).model).toBeNull();
  });

  it('the run read returns each leg’s model', async () => {
    const { runId, key } = await openRun();
    await dispatchRunService.appendEvents(
      runId,
      [{ kind: 'agent_exited', workItemKey: key, model: 'claude-opus-5-5' }],
      fixture.ctx,
    );

    const run = await dispatchRunService.getRun(runId, fixture.ctx);
    expect(run.cards.map((c) => c.model)).toEqual(['claude-opus-5-5']);
  });
});
