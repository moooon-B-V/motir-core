import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from './fixtures/workItemFixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// MOTIR-7503 — the back-fill of `dispatch_run_card.model` for legs written before
// the writer (MOTIR-7502) was live.
//
// ⚠️ THIS FILE EXECUTES THE MIGRATION'S OWN SQL, READ FROM THE MIGRATION (the
// precedent is `project-pr-merge-mode-backfill.test.ts`): a retyped UPDATE would
// stay green while the shipped statement drifted. The events are seeded straight
// into the table, NOT through `appendEvents`, because the writer would fill the
// column itself and leave the back-fill nothing to do — the legs this migration
// exists for are exactly the ones the writer never saw.

const MIGRATION = path.join(
  process.cwd(),
  'prisma/migrations/20261003220000_dispatch_run_card_model_backfill/migration.sql',
);

function backfillStatement(): string {
  const statements = readFileSync(MIGRATION, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  expect(statements, 'the migration is exactly ONE UPDATE').toHaveLength(1);
  expect(statements[0]).toMatch(/^UPDATE\b/);
  return statements[0]!;
}

async function runBackfill(): Promise<number> {
  return adminDb.$executeRawUnsafe(backfillStatement());
}

let fixture: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fixture = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A run whose legs are named, so each case reads its own row. */
async function openRun(names: string[]): Promise<{ runId: string; legs: Map<string, string> }> {
  const keys: string[] = [];
  for (const name of names) {
    const item = await workItemsService.createWorkItem(
      { projectId: fixture.projectId, kind: 'task', title: name },
      fixture.ctx,
    );
    keys.push(item.identifier);
  }
  const { run } = await dispatchRunService.open(
    {
      projectKey: fixture.projectIdentifier,
      command: 'batch',
      cards: keys.map((key) => ({ key, disposition: 'queued' as const })),
    },
    fixture.ctx,
  );
  const rows = await adminDb.dispatchRunCard.findMany({ where: { dispatchRunId: run.id } });
  const legs = new Map<string, string>();
  names.forEach((name, i) => legs.set(name, rows.find((r) => r.workItemKey === keys[i])!.id));
  return { runId: run.id, legs };
}

let nextSeq = 0;

/** An event written straight into the table — the shape an older server stored. */
async function seedEvent(
  runId: string,
  legId: string,
  kind: 'agent_exited' | 'card_settled',
  data: unknown,
): Promise<void> {
  nextSeq += 1;
  await adminDb.dispatchRunEvent.create({
    data: {
      workspaceId: fixture.workspaceId,
      dispatchRunId: runId,
      dispatchRunCardId: legId,
      seq: nextSeq,
      kind,
      ...(data === undefined ? {} : { data: data as never }),
    },
  });
}

async function modelOf(legId: string): Promise<string | null> {
  return (await adminDb.dispatchRunCard.findUniqueOrThrow({ where: { id: legId } })).model;
}

describe('the leg-model back-fill migration', () => {
  it('fills each leg from its latest valid `agent_exited` model, and nothing else', async () => {
    const cases = [
      'reported',
      'retried',
      'null',
      'missing',
      'number',
      'blank',
      'too long',
      'padded',
      'no event',
      'already set',
      'other kind',
      'latest invalid',
      'no data',
    ];
    const { runId, legs } = await openRun(cases);
    const leg = (name: string) => legs.get(name)!;

    await seedEvent(runId, leg('reported'), 'agent_exited', {
      model: 'claude-opus-5-5',
      signal: null,
    });
    await seedEvent(runId, leg('retried'), 'agent_exited', { model: 'gpt-5' });
    await seedEvent(runId, leg('retried'), 'agent_exited', { model: 'claude-opus-5-5' });
    await seedEvent(runId, leg('null'), 'agent_exited', { model: null });
    await seedEvent(runId, leg('missing'), 'agent_exited', { signal: 'SIGTERM' });
    await seedEvent(runId, leg('number'), 'agent_exited', { model: 42 });
    await seedEvent(runId, leg('blank'), 'agent_exited', { model: '   ' });
    await seedEvent(runId, leg('too long'), 'agent_exited', { model: 'm'.repeat(201) });
    await seedEvent(runId, leg('padded'), 'agent_exited', { model: ' gpt-5 ' });
    await seedEvent(runId, leg('already set'), 'agent_exited', { model: 'gpt-5' });
    await seedEvent(runId, leg('other kind'), 'card_settled', { model: 'gpt-5' });
    await seedEvent(runId, leg('latest invalid'), 'agent_exited', { model: 'gpt-5' });
    await seedEvent(runId, leg('latest invalid'), 'agent_exited', { model: '' });
    await seedEvent(runId, leg('no data'), 'agent_exited', undefined);
    await adminDb.dispatchRunCard.update({
      where: { id: leg('already set') },
      data: { model: 'x' },
    });
    // A run-level model is never a source: its legs with no event stay null.
    await adminDb.dispatchRun.update({ where: { id: runId }, data: { model: 'run-level' } });

    expect(await runBackfill()).toBe(4);

    expect(await modelOf(leg('reported'))).toBe('claude-opus-5-5');
    expect(await modelOf(leg('retried'))).toBe('claude-opus-5-5');
    expect(await modelOf(leg('padded'))).toBe('gpt-5');
    // The writer's no-erase rule: an exit with no valid model never hides an
    // earlier one.
    expect(await modelOf(leg('latest invalid'))).toBe('gpt-5');
    expect(await modelOf(leg('already set'))).toBe('x');
    for (const name of [
      'null',
      'missing',
      'number',
      'blank',
      'too long',
      'no event',
      'other kind',
      'no data',
    ]) {
      expect(await modelOf(leg(name)), name).toBeNull();
    }

    // Idempotent: a second run changes zero rows.
    expect(await runBackfill()).toBe(0);
  });

  it('accepts exactly 200 characters, measured after the trim', async () => {
    const { runId, legs } = await openRun(['at limit']);
    await seedEvent(runId, legs.get('at limit')!, 'agent_exited', {
      model: `\t${'m'.repeat(200)}\n`,
    });

    expect(await runBackfill()).toBe(1);
    expect(await modelOf(legs.get('at limit')!)).toBe('m'.repeat(200));
  });
});
