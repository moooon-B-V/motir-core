import { describe, expect, it } from 'vitest';
import { coprimeStride } from '@/scripts/seedLargeBoard';
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

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}
