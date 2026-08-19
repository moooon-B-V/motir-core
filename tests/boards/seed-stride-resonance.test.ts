import { describe, expect, it } from 'vitest';
import { coprimeStride, partitionSprintScope } from '@/scripts/seedLargeBoard';
import { DEFAULT_STATUSES } from '@/lib/workflows/defaultWorkflow';

// THE SEED'S TWO CYCLES MUST NOT RESONATE (MOTIR-2427).
//
// `seedLargeBoard` assigns statuses `spreadIdx % statusCount` in creation order.
// `seedLargeScrumSprint` then partitions the SAME creation order `i % stride`
// into sprint vs backlog. When those two cycles share a factor, one status lands
// in the backlog slot every time — that column is EMPTY in the sprint scope, and
// the seed's own promise that "the sprint inherits the full column spread" is
// quietly false.
//
// ⚠️ It held for two years by COINCIDENCE: six statuses, a stride of 7. Adding a
// seventh (`Planning`) made them equal, and a board E2E failed on a column that
// legitimately had nothing in it — a seed defect wearing a product defect's
// clothes. This asserts the property rather than the lucky pair.

describe('coprimeStride — the backlog stride can never align with the status cycle', () => {
  it('leaves an already-coprime stride alone', () => {
    expect(coprimeStride(7, 6)).toBe(7);
    expect(coprimeStride(7, 5)).toBe(7);
  });

  it('steps past a stride that shares a factor with the status count', () => {
    // The exact collision this card hit: 7 statuses, stride 7.
    expect(coprimeStride(7, 7)).toBe(8);
    // …and the ones a future workflow could hit.
    expect(coprimeStride(7, 14)).toBe(9);
    expect(coprimeStride(4, 6)).toBe(5);
    expect(coprimeStride(6, 9)).toBe(7);
  });

  it('is coprime with EVERY status count a workflow could plausibly have', () => {
    for (let statusCount = 2; statusCount <= 24; statusCount += 1) {
      for (let stride = 2; stride <= 12; stride += 1) {
        const chosen = coprimeStride(stride, statusCount);
        expect(gcd(chosen, statusCount), `stride ${stride} × ${statusCount} statuses`).toBe(1);
        expect(chosen).toBeGreaterThanOrEqual(stride);
      }
    }
  });

  it('holds for the SHIPPED default workflow, whatever its size becomes', () => {
    // Reads the real status list rather than a literal, so a workflow that grows
    // again fails here — in a millisecond — instead of in a browser lane.
    const chosen = coprimeStride(7, DEFAULT_STATUSES.length);
    expect(gcd(chosen, DEFAULT_STATUSES.length)).toBe(1);
  });

  it('never returns a degenerate stride', () => {
    // A stride below 2 would put EVERY issue in the backlog and empty the sprint.
    expect(coprimeStride(1, 7)).toBeGreaterThanOrEqual(2);
    expect(coprimeStride(0, 7)).toBeGreaterThanOrEqual(2);
  });
});

// ⚠️ AND COPRIMALITY IS NOT ENOUGH (MOTIR-2999). The stride not resonating with
// the status cycle stops one status from being taken EVERY time; it says nothing
// about a status that holds exactly ONE card and loses it to the stride once.
// That is the ordinary shape of the E2E fixtures — ~8 spread cards over the whole
// workflow — and adding an eighth status re-dealt them so the single Cancelled
// card landed in the backlog slice. `board-scrum-at-scale-interaction` then failed
// on an empty column: a seed defect wearing a product defect's clothes, for the
// second time. So the invariant is enforced in `partitionSprintScope` and
// asserted here, over every fixture size rather than the one we happened to ship.

describe('partitionSprintScope — every column the board has, the sprint has', () => {
  /** `n` cards dealt round-robin over `statusCount` statuses, in creation order —
   *  the exact distribution `seedLargeBoard` writes. */
  const deal = (n: number, statusCount: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `c${i}`, status: `s${i % statusCount}` }));

  it('keeps the stride — a representative slice is still OUT of the sprint', () => {
    const { sprintIds, backlogIds } = partitionSprintScope(deal(60, 8), 7);
    expect(backlogIds.length).toBeGreaterThan(0);
    expect(sprintIds.length + backlogIds.length).toBe(60);
    // No card is in both, and none was invented.
    expect(new Set([...sprintIds, ...backlogIds]).size).toBe(60);
  });

  it('recovers the column MOTIR-2999 lost — one card in a status, taken by the stride', () => {
    // The reproduction, at the size the E2E fixture actually is: 8 cards over 8
    // statuses, stride 7. Index 0 and index 7 go to the slice, and index 7 is the
    // ONLY card its status has.
    const rows = deal(8, 8);
    const statusOf = new Map(rows.map((r) => [r.id, r.status]));
    const { sprintIds } = partitionSprintScope(rows, 7);
    const covered = new Set(sprintIds.map((id) => statusOf.get(id)!));
    for (const s of new Set(rows.map((r) => r.status))) {
      expect(covered.has(s), `status ${s} has a sprint card`).toBe(true);
    }
  });

  it('holds for EVERY fixture size and stride a seed could be given', () => {
    for (let statusCount = 2; statusCount <= 10; statusCount += 1) {
      for (let n = statusCount; n <= statusCount * 4; n += 1) {
        for (const stride of [2, 3, 7, 8]) {
          const rows = deal(n, statusCount);
          const statusOf = new Map(rows.map((r) => [r.id, r.status]));
          const { sprintIds, backlogIds } = partitionSprintScope(rows, stride);
          const covered = new Set(sprintIds.map((id) => statusOf.get(id)!));
          expect(covered.size, `${n} cards / ${statusCount} statuses / stride ${stride}`).toBe(
            statusCount,
          );
          expect(sprintIds.length + backlogIds.length).toBe(n);
        }
      }
    }
  });

  it('takes back the MINIMUM — a status already in the sprint keeps its slice card', () => {
    // 24 cards over 4 statuses: every status has six, so the stride can take one
    // without emptying anything and NOTHING is recovered.
    const rows = deal(24, 4);
    const plain: string[] = [];
    rows.forEach((r, i) => (i % 7 === 0 ? plain.push(r.id) : null));
    const { backlogIds } = partitionSprintScope(rows, 7);
    expect(backlogIds).toEqual(plain);
  });
});

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}
