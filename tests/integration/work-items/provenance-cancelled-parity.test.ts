import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { inngest } from '@/lib/jobs/client';
import { workItemsService } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import {
  CANCELLED_STATUS_KEY,
  MOTIR_SEED_BURST_END,
  classifyImplementationSource,
  type ProvenanceBackfillRow,
} from '@/lib/workItems/provenanceBackfill';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-2221 — "which TERMINAL statuses mean IMPLEMENTED?" is encoded TWICE:
// once in the LIVE lane (`workItemsService.applyStatusTransition`, which stamps
// `implementationSource = 'manual'` on a human/manual item reaching a terminal
// status) and once in the OFFLINE classifier
// (`provenanceBackfill.classifyImplementationSource`, whose `implementedStatusKeys`
// is "done-category MINUS cancelled").
//
// The two DISAGREED. `cancelled` is filed under `category: 'done'`
// (lib/workflows/defaultWorkflow.ts), so the live lane — which consulted only the
// CATEGORY — stamped `manual` onto CANCELLED work: a claim that a human
// implemented something that was, by the act of cancelling it, abandoned. The
// offline classifier was right, named a constant for it, and its doc comment even
// cited `workItemsService` as making the same exclusion, which it did not.
//
// Nothing tested the PAIR, which is why the disagreement survived. This file is
// that test: every assertion below drives BOTH encodings over the SAME terminal
// status set and asserts they agree, so the guard cannot be narrowed on one side
// without reddening here. Real Postgres, per CLAUDE.md — the live half runs the
// actual service against the actual DB, never a re-implementation of its rule
// (notes.html #162: a test that re-implements the logic it is named after proves
// the logic is thinkable, not that the code runs).

beforeEach(async () => {
  vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] } as never);
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

/** A leaf task with an explicit type/executor (both feed the manual lane's guard). */
async function typedTask(
  fx: WorkItemFixture,
  title: string,
  over: { type?: 'manual' | 'code'; executor?: 'human' | 'coding_agent' } = {},
) {
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title, ...over },
    fx.ctx,
  );
}

/** Read the stamp back through the service (the shape every surface renders). */
async function stampOf(fx: WorkItemFixture, id: string) {
  return (await workItemsService.getWorkItem(id, fx.ctx)).implementationSource;
}

/**
 * The OFFLINE classifier's verdict for the same situation the live lane just
 * decided — same status key, same type/executor, same (absent) evidence, and the
 * same per-project `implementedStatusKeys` the real backfill computes.
 */
async function offlineVerdict(
  fx: WorkItemFixture,
  status: string,
  over: Partial<ProvenanceBackfillRow> = {},
) {
  const terminalKeys = await workflowsService.getTerminalStatusKeys(fx.projectId, fx.workspaceId);
  const implementedStatusKeys = new Set(
    [...terminalKeys].filter((key) => key !== CANCELLED_STATUS_KEY),
  );
  const row: ProvenanceBackfillRow = {
    id: 'row',
    identifier: 'PROD-1',
    createdAt: MOTIR_SEED_BURST_END,
    status,
    type: null,
    executor: 'human',
    planningSource: null,
    implementationSource: null,
    hasLinkedPr: false,
    sessionBranch: null,
    ...over,
  };
  return classifyImplementationSource(row, {
    seedBurstEnd: MOTIR_SEED_BURST_END,
    implementedStatusKeys,
  });
}

describe('the manual implementation stamp: done means implemented, cancelled means abandoned', () => {
  it('BOTH DIRECTIONS, one place: cancelled leaves the stamp null, done still writes manual', async () => {
    const fx = await makeWorkItemFixture();

    // ── cancelled ──────────────────────────────────────────────────────────
    // A `type: manual` / `executor: human` card whose work never started. This
    // is MOTIR-2149's exact shape, and it FAILS on the pre-MOTIR-2221 lane.
    const abandoned = await typedTask(fx, 'Never started', {
      type: 'manual',
      executor: 'human',
    });
    await workItemsService.updateStatus(abandoned.id, 'cancelled', fx.ctx);
    expect(await stampOf(fx, abandoned.id)).toBeNull();

    // ── done ───────────────────────────────────────────────────────────────
    // The SAME kind of card, taken to `done` instead — MOTIR-1685's shipped
    // behaviour, unchanged. Asserting the pair here is the point of the file:
    // narrowing the guard to cover both, or neither, reddens this test.
    const finished = await typedTask(fx, 'Actually done by hand', {
      type: 'manual',
      executor: 'human',
    });
    await workItemsService.updateStatus(finished.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(finished.id, 'in_review', fx.ctx);
    await workItemsService.updateStatus(finished.id, 'done', fx.ctx);
    expect(await stampOf(fx, finished.id)).toBe('manual');

    // ── the offline classifier decides the SAME two ways ────────────────────
    expect(await offlineVerdict(fx, 'cancelled', { type: 'manual' })).toBeNull();
    expect(await offlineVerdict(fx, 'done', { type: 'manual' })).toBe('manual');
  });

  it('an `executor: human` card (no manual type) is cancelled without a stamp too', async () => {
    // The lane's guard is an OR — either arm reaches it — so both arms need the
    // cancelled exclusion, not just the `type: manual` one.
    const fx = await makeWorkItemFixture();
    const a = await typedTask(fx, 'Human-executed, cancelled mid-flight', { executor: 'human' });
    await workItemsService.updateStatus(a.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(a.id, 'cancelled', fx.ctx);
    expect(await stampOf(fx, a.id)).toBeNull();
    expect(await offlineVerdict(fx, 'cancelled')).toBeNull();
  });

  it('cancelling STILL clears sessionBranch — the fix narrows the stamp, not the branch reset', async () => {
    // The `done`-category branch does two things; only ONE of them was wrong.
    // The 7.8.11 invariant (a terminal item leaves no stale lineage for
    // dependents to inherit) is if anything MORE right for an abandoned card.
    const fx = await makeWorkItemFixture();
    const a = await typedTask(fx, 'Integrated, then abandoned', { executor: 'human' });
    await workItemsService.updateStatus(a.id, 'in_progress', fx.ctx);
    await workItemsService.markIntegrated(a.id, 'session/abandoned', fx.ctx);
    expect((await db.workItem.findUniqueOrThrow({ where: { id: a.id } })).sessionBranch).toBe(
      'session/abandoned',
    );

    await workItemsService.updateStatus(a.id, 'cancelled', fx.ctx);
    const row = await db.workItem.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.status).toBe('cancelled');
    expect(row.sessionBranch).toBeNull();
  });
});

describe('the other three guards are untouched by the cancelled exclusion', () => {
  it('an existing stamp is never overwritten — at done OR at cancelled', async () => {
    const fx = await makeWorkItemFixture();

    // A byok report that arrived at in_review survives the human close-out...
    const merged = await typedTask(fx, 'Human item, agent-reported', { executor: 'human' });
    await workItemsService.updateStatus(merged.id, 'in_progress', fx.ctx);
    await workItemsService.markIntegrated(merged.id, 'session/keep', fx.ctx, {
      harness: 'Claude Code',
      model: 'claude',
    });
    await workItemsService.updateStatus(merged.id, 'done', fx.ctx);
    expect(await stampOf(fx, merged.id)).toBe('byok');

    // ...and equally survives a CANCEL. Real evidence outranks the status: the
    // work WAS done by an agent, whatever the card's fate afterwards. This is
    // also why the data migration's predicate pins `implementationSource =
    // 'manual'` rather than clearing every cancelled row's stamp.
    const abandonedAfterWork = await typedTask(fx, 'Agent-reported, then cancelled', {
      executor: 'human',
    });
    await workItemsService.updateStatus(abandonedAfterWork.id, 'in_progress', fx.ctx);
    await workItemsService.markIntegrated(abandonedAfterWork.id, 'session/dropped', fx.ctx, {
      harness: 'Codex',
      model: 'openai',
    });
    await workItemsService.updateStatus(abandonedAfterWork.id, 'cancelled', fx.ctx);
    expect(await stampOf(fx, abandonedAfterWork.id)).toBe('byok');

    expect(await offlineVerdict(fx, 'done', { implementationSource: 'byok' })).toBeNull();
    expect(await offlineVerdict(fx, 'cancelled', { implementationSource: 'byok' })).toBeNull();
  });

  it('a `system` bulk set never stamps — reaching done or cancelled on import', async () => {
    const fx = await makeWorkItemFixture();

    const imported = await typedTask(fx, 'Imported closed', { type: 'manual', executor: 'human' });
    await workItemsService.setImportedStatus(imported.id, 'done', fx.ctx);
    expect(await stampOf(fx, imported.id)).toBeNull();

    const importedCancelled = await typedTask(fx, 'Imported wontfix', {
      type: 'manual',
      executor: 'human',
    });
    await workItemsService.setImportedStatus(importedCancelled.id, 'cancelled', fx.ctx);
    expect(await stampOf(fx, importedCancelled.id)).toBeNull();
  });

  it('a coding_agent item reaching done without a report still keeps null', async () => {
    const fx = await makeWorkItemFixture();
    const a = await typedTask(fx, 'Agent task', { type: 'code' }); // seeds coding_agent
    await workItemsService.updateStatus(a.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(a.id, 'in_review', fx.ctx);
    await workItemsService.updateStatus(a.id, 'done', fx.ctx);
    expect(await stampOf(fx, a.id)).toBeNull();
    expect(await offlineVerdict(fx, 'done', { type: 'code', executor: 'coding_agent' })).toBeNull();
  });
});

describe('parity over the WHOLE terminal set — neither encoding may drift alone', () => {
  it('for every done-category status, the live lane and the offline classifier agree', async () => {
    const fx = await makeWorkItemFixture();
    const terminal = [
      ...(await workflowsService.getTerminalStatusKeys(fx.projectId, fx.workspaceId)),
    ];

    // The premise the whole bug rests on: `cancelled` IS a done-category status,
    // so "category === done" can never be the discriminator on its own.
    expect(terminal).toContain('cancelled');
    expect(terminal).toContain('done');

    for (const status of terminal) {
      const item = await typedTask(fx, `human → ${status}`, { type: 'manual', executor: 'human' });
      // `todo → cancelled` and `todo → in_progress` are both legal; `done` needs
      // the in_progress → in_review → done walk.
      if (status === 'done') {
        await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
        await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);
      }
      await workItemsService.updateStatus(item.id, status, fx.ctx);

      const live = await stampOf(fx, item.id);
      const offline = await offlineVerdict(fx, status, { type: 'manual' });
      expect(live, `live lane and offline classifier disagree on terminal status "${status}"`).toBe(
        offline,
      );
    }
  });
});
