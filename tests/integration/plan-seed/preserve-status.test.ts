import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { DEFAULT_STATUS_KEYS } from '@/lib/workflows/defaultWorkflow';
import {
  applyPreservedStatuses,
  planIdFromTitle,
  snapshotLiveStatuses,
} from '@/scripts/plan-seed/preserveStatus';
import { truncateAuthTables } from '../../helpers/db';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';

// Subtask 7.8.7 — the seed-loader status-preservation flip. Status authority
// moved seed → live DB: a seed status is INITIAL-ONLY now, and a reseed
// PRESERVES the live workflow status of items that already existed. The two
// halves of that behaviour are extracted into scripts/plan-seed/preserveStatus
// .ts so they're testable WITHOUT importing seed.ts (which runs main() against a
// real DB on import — the same reason mapItem.ts was extracted for 2.7.7). The
// pure `planIdFromTitle` cases need no DB; the snapshot/apply round-trip drives
// the real Postgres and proves the AC: a moved status survives a reseed, a new
// item gets its seed status, and a status gone from the workflow falls back.

describe('planIdFromTitle — recover the dotted plan id from a seed title prefix', () => {
  it('parses the leaf / story / epic / root-bug title shapes the loader builds', () => {
    expect(planIdFromTitle('7.8.7 Reseed preserves live statuses')).toBe('7.8.7');
    expect(planIdFromTitle('7.8 Motir MCP server')).toBe('7.8');
    expect(planIdFromTitle('Epic 7: AI planning layer')).toBe('7');
    // A root bug is `<int> <title>` — matched as a leaf id, distinct from the
    // epic's `Epic <int>: …` prefix so `Epic 7` and root bug `7` don't collide.
    expect(planIdFromTitle('9 A parentless bug')).toBe('9');
  });

  it('returns null for a title with no dotted-id prefix (a hand-created item)', () => {
    expect(planIdFromTitle('Just a note someone typed')).toBeNull();
    expect(planIdFromTitle('')).toBeNull();
  });

  it('does not mistake an epic title for a leaf id (the collision guard)', () => {
    // `Epic 7: …` → the epic id `7`, NOT the leaf parse that would also see `7`.
    expect(planIdFromTitle('Epic 2: PM core')).toBe('2');
  });
});

describe('snapshotLiveStatuses + applyPreservedStatuses (real Postgres)', () => {
  beforeEach(async () => {
    await db.$executeRawUnsafe(
      'TRUNCATE TABLE "work_item_link", "work_item" RESTART IDENTITY CASCADE',
    );
    await truncateAuthTables();
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  /** Create a leaf with a plan-id title prefix and force its status. (Uses the
   * parentless-legal `task` kind — the plan-id parse is kind-independent.) */
  async function seedItem(fx: WorkItemFixture, planId: string, status: string): Promise<string> {
    const row = await createTestWorkItem(fx, { kind: 'task', title: `${planId} A leaf` });
    await db.$transaction((tx) => workItemRepository.update(row.id, { status }, tx));
    return row.id;
  }

  it('snapshots the live status of every plan item keyed by dotted plan id', async () => {
    const fx = await makeWorkItemFixture();
    await seedItem(fx, '7.8.5', 'done');
    await seedItem(fx, '7.8.7', 'in_progress');
    // A hand-created item (no plan-id prefix) is ignored by the snapshot.
    const hand = await createTestWorkItem(fx, { kind: 'task', title: 'Ad-hoc chore' });
    await db.$transaction((tx) => workItemRepository.update(hand.id, { status: 'todo' }, tx));

    const snapshot = await snapshotLiveStatuses([fx.workspaceId]);

    expect(snapshot.get('7.8.5')).toBe('done');
    expect(snapshot.get('7.8.7')).toBe('in_progress');
    expect(snapshot.has('Ad-hoc chore')).toBe(false);
    expect(snapshot.size).toBe(2);
  });

  it('returns an empty snapshot (nothing preserved) for a first-ever seed', async () => {
    const snapshot = await snapshotLiveStatuses([]);
    expect(snapshot.size).toBe(0);
    const result = await applyPreservedStatuses({ snapshot, idMap: new Map() });
    expect(result).toEqual({ preserved: 0, fellBack: 0, warnings: [] });
  });

  it('round-trip: a moved status survives a reseed, a new item keeps its seed status', async () => {
    // ── Phase 1: the LIVE tenant. An agent moved 7.8.7 to in_progress. ──
    const live = await makeWorkItemFixture({ name: 'Live' });
    await seedItem(live, '7.8.5', 'done');
    await seedItem(live, '7.8.7', 'in_progress');
    const snapshot = await snapshotLiveStatuses([live.workspaceId]);

    // ── Phase 2: the RESEED. The tree is recreated with SEED statuses; a brand
    // new item (7.8.99) appears. idMap is the loader's planId → new work_item id.
    const reseed = await makeWorkItemFixture({ name: 'Reseed', identifier: 'RSD' });
    const new785 = await seedItem(reseed, '7.8.5', 'todo'); // seed status
    const new787 = await seedItem(reseed, '7.8.7', 'todo'); // seed status (would clobber!)
    const newNew = await seedItem(reseed, '7.8.99', 'todo'); // NEW item, no snapshot
    const idMap = new Map([
      ['7.8.5', new785],
      ['7.8.7', new787],
      ['7.8.99', newNew],
    ]);

    const result = await applyPreservedStatuses({ snapshot, idMap });

    // The two pre-existing items keep their LIVE status (preserved), the new one
    // keeps its seed status.
    expect((await workItemRepository.findById(new785))?.status).toBe('done');
    expect((await workItemRepository.findById(new787))?.status).toBe('in_progress');
    expect((await workItemRepository.findById(newNew))?.status).toBe('todo');
    expect(result.preserved).toBe(2);
    expect(result.fellBack).toBe(0);
  });

  it('falls back to the seed status (with a warning) for a status gone from the workflow', async () => {
    const fx = await makeWorkItemFixture();
    const newId = await seedItem(fx, '6.6.6', 'todo'); // reseeded item, seed status
    // A snapshot carrying a custom status the reseeded default workflow lacks.
    const customStatus = 'archived_2024';
    expect(DEFAULT_STATUS_KEYS.has(customStatus)).toBe(false);
    const snapshot = new Map([['6.6.6', customStatus]]);

    const result = await applyPreservedStatuses({ snapshot, idMap: new Map([['6.6.6', newId]]) });

    // The item keeps its SEED status (not the gone-from-workflow custom one)…
    expect((await workItemRepository.findById(newId))?.status).toBe('todo');
    // …and the loader is warned.
    expect(result.preserved).toBe(0);
    expect(result.fellBack).toBe(1);
    expect(result.warnings[0]).toContain('6.6.6');
    expect(result.warnings[0]).toContain(customStatus);
  });

  it('ignores a snapshot entry whose plan id is no longer in the reseeded tree', async () => {
    const fx = await makeWorkItemFixture();
    const keptId = await seedItem(fx, '2.1.1', 'todo');
    // '2.1.2' was preserved last time but has since been removed from the plan —
    // it has no idMap entry, so it is silently skipped (not an error).
    const snapshot = new Map([
      ['2.1.1', 'done'],
      ['2.1.2', 'in_progress'],
    ]);

    const result = await applyPreservedStatuses({
      snapshot,
      idMap: new Map([['2.1.1', keptId]]),
    });

    expect((await workItemRepository.findById(keptId))?.status).toBe('done');
    expect(result.preserved).toBe(1);
    expect(result.fellBack).toBe(0);
  });

  it('is idempotent across a double reseed (re-applies the same preserved values)', async () => {
    // First reseed preserved 7.8.7 = in_progress. The SECOND reseed snapshots
    // that preserved value and re-applies it — same result, no drift.
    const fx = await makeWorkItemFixture();
    const id = await seedItem(fx, '7.8.7', 'in_progress'); // state after reseed #1
    const snapshot = await snapshotLiveStatuses([fx.workspaceId]);
    expect(snapshot.get('7.8.7')).toBe('in_progress');

    // Reseed #2: recreate with the seed status, then preserve.
    const reseeded = await seedItem(fx, '7.8.7', 'todo');
    const result = await applyPreservedStatuses({
      snapshot,
      idMap: new Map([['7.8.7', reseeded]]),
    });

    expect((await workItemRepository.findById(reseeded))?.status).toBe('in_progress');
    expect(result.preserved).toBe(1);
    // `id` (the reseed-#1 row) is untouched by this apply — only the idMap row moved.
    expect(id).not.toBe(reseeded);
  });
});
