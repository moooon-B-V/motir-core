import { describe, expect, it } from 'vitest';
import {
  DERIVED_PARENT_STATUS_WARNING,
  markDerivedParentStatuses,
} from '@/lib/import/engine/importDerivedStatus';
import type { ImportPlan, ImportPlanRow } from '@/lib/import/engine/types';

// Unit tests for the import preview's derived-parent-status disclosure
// (MOTIR-2974 · `docs/decisions/status-derivation.md` §3c). Pure — no DB.
//
// The rule under test is deliberately about the row's SHAPE after the run, not
// about whether a write happens: a parent's status is a function of its
// children (§3), so the file's status column does not govern it — whether or
// not the derived value differs from the mapped one.

function row(
  externalId: string,
  overrides: {
    parentExternalId?: string | null;
    existingWorkItemId?: string | null;
    plan?: ImportPlan;
    warnings?: string[];
  } = {},
): ImportPlanRow {
  return {
    externalId,
    plan: overrides.plan ?? 'create',
    payload: {
      kind: 'task',
      title: externalId,
      descriptionMd: null,
      priority: 'medium',
      statusKey: 'todo',
      assigneeId: null,
      reporterId: null,
      reporterEmail: null,
      labels: [],
      comments: [],
      attachments: [],
      parentExternalId: overrides.parentExternalId ?? null,
      links: [],
      createdAt: null,
      closedAt: null,
    },
    warnings: overrides.warnings ?? [],
    sourceHash: `h-${externalId}`,
    existingWorkItemId: overrides.existingWorkItemId ?? null,
  };
}

const marked = (rows: ImportPlanRow[]): string[] =>
  rows.filter((r) => r.warnings.includes(DERIVED_PARENT_STATUS_WARNING)).map((r) => r.externalId);

describe('markDerivedParentStatuses', () => {
  it('marks a row another row in the same import names as its parent — and only that row', () => {
    // The shipped E2E fixture's shape: ACME-2 parents to ACME-1, so ACME-1
    // becomes a parent and its CSV status stops governing it. ACME-3 is a leaf.
    const rows = [row('ACME-1'), row('ACME-2', { parentExternalId: 'ACME-1' }), row('ACME-3')];

    markDerivedParentStatuses(rows, { autoRollupParentStatus: true });

    expect(marked(rows)).toEqual(['ACME-1']);
  });

  it('marks a matched row that ALREADY has children in Motir, even with no imported child', () => {
    // A re-run touching a parent whose children were imported last time: this
    // run gives it no new child, and its status is still derived from the ones
    // it has.
    const rows = [row('ACME-1', { plan: 'update', existingWorkItemId: 'wi-1' }), row('ACME-9')];

    markDerivedParentStatuses(rows, {
      autoRollupParentStatus: true,
      existingParentIds: new Set(['wi-1']),
    });

    expect(marked(rows)).toEqual(['ACME-1']);
  });

  it('marks a SKIP row that a created row parents to — nothing is written for it, but it gains a child', () => {
    const rows = [
      row('ACME-1', { plan: 'skip', existingWorkItemId: 'wi-1' }),
      row('ACME-2', { parentExternalId: 'ACME-1' }),
    ];

    markDerivedParentStatuses(rows, {
      autoRollupParentStatus: true,
      existingParentIds: new Set(),
    });

    expect(marked(rows)).toEqual(['ACME-1']);
  });

  it('marks a parent ONCE when it both gains an imported child and already has children', () => {
    const rows = [
      row('ACME-1', { plan: 'update', existingWorkItemId: 'wi-1' }),
      row('ACME-2', { parentExternalId: 'ACME-1' }),
    ];

    markDerivedParentStatuses(rows, {
      autoRollupParentStatus: true,
      existingParentIds: new Set(['wi-1']),
    });

    expect(rows[0]!.warnings).toEqual([DERIVED_PARENT_STATUS_WARNING]);
  });

  it('marks nothing when the project has autoRollupParentStatus OFF', () => {
    // §3a's toggle gates every trigger; with it off nothing is derived, so
    // there is nothing to disclose.
    const rows = [row('ACME-1'), row('ACME-2', { parentExternalId: 'ACME-1' })];

    markDerivedParentStatuses(rows, {
      autoRollupParentStatus: false,
      existingParentIds: new Set(['wi-1']),
    });

    expect(marked(rows)).toEqual([]);
  });

  it('marks nothing when no row is a parent', () => {
    const rows = [row('ACME-1'), row('ACME-2'), row('ACME-3')];

    markDerivedParentStatuses(rows, { autoRollupParentStatus: true });

    expect(marked(rows)).toEqual([]);
  });

  it('ignores a parentExternalId naming a row that is not in this import', () => {
    // The resolver already warns about an unresolvable parent; this pass must
    // not invent a marked row for one.
    const rows = [row('ACME-2', { parentExternalId: 'NOT-IMPORTED-1' })];

    markDerivedParentStatuses(rows, { autoRollupParentStatus: true });

    expect(marked(rows)).toEqual([]);
  });

  it('APPENDS to the resolver warnings rather than replacing them', () => {
    const rows = [
      row('ACME-1', { warnings: ['unmapped priority "urgent" → medium'] }),
      row('ACME-2', { parentExternalId: 'ACME-1' }),
    ];

    markDerivedParentStatuses(rows, { autoRollupParentStatus: true });

    expect(rows[0]!.warnings).toEqual([
      'unmapped priority "urgent" → medium',
      DERIVED_PARENT_STATUS_WARNING,
    ]);
  });

  it('never marks a row for being a CHILD', () => {
    const rows = [row('ACME-1'), row('ACME-2', { parentExternalId: 'ACME-1' })];

    markDerivedParentStatuses(rows, { autoRollupParentStatus: true });

    expect(rows[1]!.warnings).toEqual([]);
  });
});
