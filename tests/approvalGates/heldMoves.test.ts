import { describe, expect, it } from 'vitest';
import { heldMoves } from '@/lib/approvalGates/heldMoves';
import type { StatusIntent } from '@/lib/workflows/statusIntent';

// THE ONE RULE (MOTIR-5526 / MOTIR-5528; ADR `approval-gates.md` §6d rules 1 and
// 2b) — pure, so each arm is asserted without a database. The guard and the status
// control both call it; the integration suites prove each caller hands it the
// right inputs.

const statuses = [
  { key: 'todo', category: 'todo' as const },
  { key: 'in_review', category: 'in_progress' as const },
  { key: 'approved', category: 'in_progress' as const },
  { key: 'done', category: 'done' as const },
  { key: 'cancelled', category: 'done' as const },
];
const DONE: StatusIntent = { key: 'done', category: 'done' };
const intentOf = (kind: string): StatusIntent | null => (kind === 'design_result' ? DONE : null);

describe('heldMoves', () => {
  it('no pull request, an awaiting design gate → Done waits on the decision', () => {
    expect(
      heldMoves({
        statuses,
        hasOpenPullRequest: false,
        awaitingGates: [{ id: 'g1', kind: 'design_result' }],
        intentOf,
      }),
    ).toEqual([
      { statusKey: 'done', waitingOn: 'decision', gateId: 'g1', gateKind: 'design_result' },
    ]);
  });

  it('an open pull request → Approved waits on the decision, Done on the merge; Cancelled is never held', () => {
    const held = heldMoves({
      statuses,
      hasOpenPullRequest: true,
      awaitingGates: [{ id: 'g2', kind: 'pull_request_approval' }],
      intentOf,
    });
    expect(held).toEqual([
      {
        statusKey: 'approved',
        waitingOn: 'decision',
        gateId: 'g2',
        gateKind: 'pull_request_approval',
      },
      { statusKey: 'done', waitingOn: 'merge', gateId: 'g2', gateKind: 'pull_request_approval' },
    ]);
  });

  it('an open pull request with no gate raised yet names the pull-request kind and no gate', () => {
    const held = heldMoves({ statuses, hasOpenPullRequest: true, awaitingGates: [], intentOf });
    expect(held.map((h) => [h.statusKey, h.gateId, h.gateKind])).toEqual([
      ['approved', null, 'pull_request_approval'],
      ['done', null, 'pull_request_approval'],
    ]);
  });

  it('with a pull request open, Done stays the MERGE’s even when a design gate also owns it', () => {
    const held = heldMoves({
      statuses,
      hasOpenPullRequest: true,
      awaitingGates: [{ id: 'g1', kind: 'design_result' }],
      intentOf,
    });
    expect(held.find((h) => h.statusKey === 'done')?.waitingOn).toBe('merge');
  });

  it('the deciding gate never holds its own write — Approved passes, and its own owned status passes', () => {
    expect(
      heldMoves({
        statuses,
        hasOpenPullRequest: true,
        awaitingGates: [{ id: 'g2', kind: 'pull_request_approval' }],
        intentOf,
        decidingGateId: 'g2',
      }).map((h) => h.statusKey),
    ).toEqual(['done']);
    expect(
      heldMoves({
        statuses,
        hasOpenPullRequest: false,
        awaitingGates: [{ id: 'g1', kind: 'design_result' }],
        intentOf,
        decidingGateId: 'g1',
      }),
    ).toEqual([]);
  });

  it('a gate whose kind owns nothing (unregistered, or a null intent) holds nothing', () => {
    expect(
      heldMoves({
        statuses,
        hasOpenPullRequest: false,
        awaitingGates: [{ id: 'g3', kind: 'pull_request_merge' }],
        intentOf,
      }),
    ).toEqual([]);
  });

  it('a workflow with no `approved` status holds only Done on a pull request', () => {
    expect(
      heldMoves({
        statuses: statuses.filter((s) => s.key !== 'approved'),
        hasOpenPullRequest: true,
        awaitingGates: [],
        intentOf,
      }).map((h) => h.statusKey),
    ).toEqual(['done']);
  });
});
