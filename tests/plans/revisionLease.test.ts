import { describe, expect, it } from 'vitest';
import {
  PLAN_REVISION_LEASE_MS,
  REVISION_ENDED_KIND,
  REVISION_STARTED_KIND,
  revisionLeaseOf,
  type RevisionLeaseRow,
} from '@/lib/planChange/revisionLease';

// Story MOTIR-3595 · Subtask MOTIR-3602 — the lease PREDICATE, as a pure unit.
//
// The service suites drive it through real transactions; this pins the shape of
// the reading itself, where every arm is one line and a wrong one is invisible
// in an integration assertion that only ever passes it a well-formed trail.

const T0 = new Date('2026-08-26T10:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

function row(kind: string, ms: number, over: Partial<RevisionLeaseRow> = {}): RevisionLeaseRow {
  return { changeKind: kind, changedAt: at(ms), ...over };
}

describe('revisionLeaseOf', () => {
  it('is NOT held on an empty trail, or one that never started a revision', () => {
    expect(revisionLeaseOf([], T0)).toBeNull();
    expect(revisionLeaseOf([row('created', 0), row('appended', 1)], T0)).toBeNull();
  });

  it('is HELD by a start with no terminator, inside the window', () => {
    const lease = revisionLeaseOf(
      [row('planned', 0), row(REVISION_STARTED_KIND, 1000, { actorHarness: 'Motir AI' })],
      at(2000),
    );
    expect(lease).not.toBeNull();
    expect(lease!.heldBy).toBe('Motir AI');
  });

  it('reports a NULL holder when the trail recorded no harness — not an invented one', () => {
    // The row is what it is: a revision the trail could not attribute. Reporting
    // a placeholder would put a name in a refusal that names nobody.
    const lease = revisionLeaseOf([row(REVISION_STARTED_KIND, 0)], at(1000));
    expect(lease!.heldBy).toBeNull();
  });

  it('is NOT held once a terminator follows the start', () => {
    expect(
      revisionLeaseOf([row(REVISION_STARTED_KIND, 0), row(REVISION_ENDED_KIND, 10)], at(20)),
    ).toBeNull();
  });

  it('the FIRST terminator walking backwards ends the search — a landed revision holds nothing', () => {
    // Two complete revisions in a row. A predicate that found the earliest start
    // rather than the latest would report the first one as still running.
    expect(
      revisionLeaseOf(
        [
          row(REVISION_STARTED_KIND, 0),
          row(REVISION_ENDED_KIND, 10),
          row(REVISION_STARTED_KIND, 20),
          row(REVISION_ENDED_KIND, 30),
        ],
        at(40),
      ),
    ).toBeNull();
  });

  it('a SECOND start after a terminator holds again', () => {
    const lease = revisionLeaseOf(
      [
        row(REVISION_STARTED_KIND, 0),
        row(REVISION_ENDED_KIND, 10),
        row(REVISION_STARTED_KIND, 20, { actorHarness: 'Motir AI' }),
      ],
      at(30),
    );
    expect(lease!.heldBy).toBe('Motir AI');
  });

  it('AGES OUT from the LATEST row, not from the start — the refresh is the whole point', () => {
    const started = row(REVISION_STARTED_KIND, 0);
    // A long revision that is still writing: the start is well past the window,
    // and the newest row is not. It is HELD.
    const working = [started, row('edited', PLAN_REVISION_LEASE_MS - 1000)];
    expect(revisionLeaseOf(working, at(PLAN_REVISION_LEASE_MS + 1000))).not.toBeNull();

    // The same revision, gone quiet. The clock runs down from its LAST sign of
    // life, which is exactly the condition the expiry exists to detect.
    expect(revisionLeaseOf(working, at(PLAN_REVISION_LEASE_MS * 2 + 1000))).toBeNull();
  });

  it('expires EXACTLY at the boundary, not a millisecond after', () => {
    const rows = [row(REVISION_STARTED_KIND, 0)];
    expect(revisionLeaseOf(rows, at(PLAN_REVISION_LEASE_MS - 1))).not.toBeNull();
    expect(revisionLeaseOf(rows, at(PLAN_REVISION_LEASE_MS))).toBeNull();
  });

  it('reports WHEN it expires, measured from the latest row', () => {
    const lease = revisionLeaseOf([row(REVISION_STARTED_KIND, 0), row('edited', 5000)], at(6000));
    expect(lease!.expiresAt.getTime()).toBe(at(5000).getTime() + PLAN_REVISION_LEASE_MS);
  });
});
