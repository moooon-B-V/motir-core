import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import {
  dispatchRunEventInputSchema,
  dispatchRunOpenBodySchema,
} from '@/lib/api/v1/workLoop/schema';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// THE STORY'S CROSS-SEAM ROUND TRIP (Story MOTIR-1789 · MOTIR-1798).
//
// ⚠️ THE SEAM NO SUBTASK OWNS: the ingest is unit-tested against a payload shape
// IT defines, and the surfaces are component-tested against a DTO THEY define.
// Both stay green while the route stores under one key what the page reads under
// another. So every payload here is parsed by the ROUTE'S OWN zod schema before
// it is applied by the real service and read back through the browser DTOs — a
// key that drifts along that chain fails here and nowhere else.
//
// ⚠️ WHAT THIS DELIBERATELY DOES **NOT** DO: import the CLI reporter. Two
// reasons, and the second is the load-bearing one.
//   · `CLAUDE.md`'s runner note: `packages/cli/test/**` runs under the package's
//     OWN vitest config, and a CLI-side assertion belongs there. The reporter's
//     shape, its offline behaviour and the log opt-in are asserted in
//     `packages/cli/test/dispatchRunReporterWiring.test.ts` and its siblings.
//   · The CLI↔server key drift this card worried about is closed by GENERATION,
//     not by a round trip: `tests/cli/generated-api-freshness.test.ts` asserts
//     the committed client matches the emitter AND that the emitter matches what
//     the world can fetch. A payload the CLI can type is a payload this schema
//     accepts, structurally. Re-testing it here would be theatre; what is NOT
//     covered anywhere else is everything below.

let fixture: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fixture = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedSet(): Promise<{ parentId: string; keys: string[] }> {
  const parent = await workItemsService.createWorkItem(
    { projectId: fixture.projectId, kind: 'story', title: 'A story a run works' },
    fixture.ctx,
  );
  const keys: string[] = [];
  for (const title of ['First', 'Second', 'Third']) {
    const child = await workItemsService.createWorkItem(
      { projectId: fixture.projectId, kind: 'subtask', parentId: parent.id, title },
      fixture.ctx,
    );
    keys.push(child.identifier);
  }
  return { parentId: parent.id, keys };
}

/**
 * Open a real multi-item run, move it, close it — with every payload PARSED by
 * the route's own schema first, so nothing here can assert against a shape the
 * ingest would refuse.
 */
async function roundTrip(opts: { withBody?: boolean } = {}) {
  const { keys } = await seedSet();

  const openBody = dispatchRunOpenBodySchema.parse({
    projectKey: fixture.projectIdentifier,
    command: 'run',
    scopeLabel: keys[0],
    agent: 'claude',
    model: 'claude-opus-5',
    cards: [
      { key: keys[0], disposition: 'queued' },
      // ⚠️ A leg already SKIPPED at the open, with its reason — the snapshot
      // shape a `batch` run reports, and what a set-order assertion needs.
      { key: keys[1], disposition: 'skipped', skipReason: 'needs_human' },
      { key: keys[2], disposition: 'queued' },
    ],
  });

  const wireEvents = [
    { kind: 'card_claimed', workItemKey: keys[0], disposition: 'running' },
    {
      kind: 'log',
      workItemKey: keys[0],
      // The opt-in half: a reporter WITHOUT `--report-log` strips this before it
      // leaves the machine, so the ingest simply never sees the field.
      ...(opts.withBody === true ? { body: 'the agent said something private' } : {}),
    },
    { kind: 'card_settled', workItemKey: keys[0], disposition: 'implemented', exitCode: 0 },
  ].map((e) => dispatchRunEventInputSchema.parse(e));

  const { run } = await dispatchRunService.open(
    {
      projectKey: openBody.projectKey,
      command: openBody.command,
      ...(openBody.scopeLabel === undefined ? {} : { scopeLabel: openBody.scopeLabel }),
      ...(openBody.agent === undefined ? {} : { agent: openBody.agent }),
      ...(openBody.model === undefined ? {} : { model: openBody.model }),
      cards: openBody.cards,
    },
    fixture.ctx,
  );
  await dispatchRunService.appendEvents(
    run.id,
    wireEvents as Parameters<typeof dispatchRunService.appendEvents>[1],
    fixture.ctx,
  );
  await dispatchRunService.close(run.id, { stopReason: 'drained' }, fixture.ctx);

  return { runId: run.id, keys, openBody, wireEvents };
}

describe('the payload the INGEST accepts is the payload the record stores', () => {
  it('the open body carries the SET, with the pre-skipped leg’s reason intact', async () => {
    const { openBody, keys } = await roundTrip();

    expect(openBody.cards.map((c) => c.key)).toEqual(keys);
    // A skip shown without its reason says nothing, and the migration's CHECK
    // constraint refuses the pair the other way round.
    expect(openBody.cards[1]).toMatchObject({ disposition: 'skipped', skipReason: 'needs_human' });
  });
});

describe('the run READS BACK as the surfaces consume it', () => {
  it('the legs are in the run’s STORED order, with their dispositions and reason', async () => {
    const { runId, keys } = await roundTrip();

    const detail = await dispatchRunService.getRunDetail(runId, fixture.ctx);
    // ⚠️ Position order, never re-derived from the dependency graph: the order
    // is a fact about what the run DID, and the graph moves underneath it.
    expect(detail.cards.map((c) => c.key)).toEqual(keys);
    expect(detail.cards[0]).toMatchObject({ disposition: 'implemented' });
    expect(detail.cards[1]).toMatchObject({ disposition: 'skipped', skipReason: 'needs_human' });
    expect(detail.status).toBe('succeeded');
    expect(detail.stopReason).toBe('drained');
  });

  it('the stream returns the events in seq order, and `?since=N` returns exactly the gap', async () => {
    const { runId } = await roundTrip();

    const all = await dispatchRunService.readStreamPage(runId, 0, 500, fixture.ctx);
    const seqs = all.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);

    const cut = seqs[1]!;
    const rest = await dispatchRunService.readStreamPage(runId, cut, 500, fixture.ctx);
    // No duplicate and no hole: every seq after the cursor, and nothing at or
    // before it. That pair is what makes a reconnect safe.
    expect(rest.events.map((e) => e.seq)).toEqual(seqs.filter((s) => s > cut));
  });

  it('a leg whose work item was DELETED still reads back — SET NULL, not a crash', async () => {
    const { runId, keys } = await roundTrip();
    const gone = await adminDb.workItem.findFirst({ where: { identifier: keys[2]! } });
    await adminDb.workItem.delete({ where: { id: gone!.id } });

    const detail = await dispatchRunService.getRunDetail(runId, fixture.ctx);
    const leg = detail.cards.find((c) => c.key === keys[2]!);
    // The KEY survives the item, which is the whole reason it is stored beside
    // the id; only the link is gone.
    expect(leg).toBeTruthy();
    expect(leg!.workItemId).toBeNull();
    expect(leg!.key).toBe(keys[2]!);
  });

  it('the run appears in the history of an item it swept up but is not scoped to', async () => {
    const { runId, keys } = await roundTrip();

    // `keys[2]` is a MEMBER, not the scope — the scope is `keys[0]`.
    const history = await dispatchRunService.listRunsForWorkItemKey(
      keys[2]!,
      { take: 25 },
      fixture.ctx,
    );
    expect(history.map((r) => r.id)).toContain(runId);
  });
});

describe('⚠️ THE PRIVACY CONTRACT, asserted in BOTH directions', () => {
  it('WITHOUT the opt-in, no body reaches the record', async () => {
    const { runId, wireEvents } = await roundTrip();

    // Direction one: the field never appears on the wire. The REPORTER strips it
    // centrally (asserted in the CLI package, where that code runs); what this
    // asserts is the server half — an append with no body stores none.
    expect(wireEvents.every((e) => e.body === undefined)).toBe(true);

    // Direction two: nothing was stored either.
    const page = await dispatchRunService.readStreamPage(runId, 0, 500, fixture.ctx);
    expect(page.events.every((e) => e.body === null)).toBe(true);
    const rows = await adminDb.dispatchRunEvent.findMany({ where: { dispatchRunId: runId } });
    expect(rows.every((r) => r.body === null)).toBe(true);
  });

  it('WITH the opt-in, the body crosses and reads back — so the promise means something', async () => {
    const { runId, wireEvents } = await roundTrip({ withBody: true });

    expect(wireEvents.some((e) => e.body === 'the agent said something private')).toBe(true);
    const page = await dispatchRunService.readStreamPage(runId, 0, 500, fixture.ctx);
    expect(page.events.some((e) => e.body === 'the agent said something private')).toBe(true);
  });
});

describe('the two list reads agree about the same data', () => {
  it('the project list narrowed to live returns what the active read returns', async () => {
    const { keys } = await seedSet();
    const { run } = await dispatchRunService.open(
      {
        projectKey: fixture.projectIdentifier,
        command: 'run',
        cards: [{ key: keys[0]!, disposition: 'queued' }],
      },
      fixture.ctx,
    );

    const active = await dispatchRunService.listActiveRunsForProject(
      fixture.projectIdentifier,
      fixture.ctx,
    );
    const listed = await dispatchRunService.listRunsForProject(
      fixture.projectIdentifier,
      { take: 25, statuses: ['running'] },
      fixture.ctx,
    );

    const activeIds = active.map((r) => r.id);
    expect(activeIds).toContain(run.id);
    // ⚠️ TWO READS, ONE ANSWER. The index's live section and the active read are
    // different queries over the same fact; a surface that showed one and a
    // badge that counted the other is how they start disagreeing.
    expect(listed.map((r) => r.id)).toEqual(activeIds);
  });
});
