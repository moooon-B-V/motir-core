// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { announceGateDecided } from '@/lib/approvals/decidedGates';
import {
  OptimisticStatusProvider,
  useDisplayedStatus,
} from '@/app/(authed)/items/[key]/_components/OptimisticStatusProvider';
import { DecidedGateStatusBridge } from '@/app/(authed)/items/[key]/_components/DecidedGateStatusBridge';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';

// A DECISION MADE IN THE OVERLAY REACHES THE PAGE'S STATUS RAIL (Story MOTIR-5215 ·
// Subtask MOTIR-5570).
//
// The overlay lives in the shell, outside the page's `OptimisticStatusProvider`;
// what joins them is the decided-gate store and the bridge rendered inside the
// provider. This suite mounts the REAL provider, a reader through the REAL
// `useDisplayedStatus` (the hook the core-fields rail draws from), and the REAL
// bridge, and drives the REAL store — so no half of the channel is a stand-in.
//
// ⚠️ PROVEN ABLE TO GO RED: with the bridge's `applyOptimisticStatus(...)` line
// removed, the first case fails on the rail still reading `in_progress`.
//
// The store is module-level, as it is in the product, so every case uses its own
// gate id.

const GATE: ApprovalGateDTO = {
  id: 'gate-x',
  workItemId: 'wi-1',
  kind: 'design_result',
  subjectId: 'ev-1',
  state: 'awaiting',
  decidedById: null,
  decidedAt: null,
  noteMd: null,
  supersededCause: null,
  subjectVersion: '9840d00ea1b2',
  decidedByLabel: null,
  routedToId: 'user-2',
  decidedUnderAuthority: null,
  decisionSource: null,
  outcomeRef: null,
  confirmedRecord: null,
  refusalVerdict: null,
  replanOwed: null,
  chosenOption: null,
  createdAt: '2026-09-08T04:00:00.000Z',
  updatedAt: '2026-09-08T04:00:00.000Z',
};

function decision(id: string, state: ApprovalGateDTO['state'], outcomeRef: string | null) {
  return { gate: { ...GATE, id, state, outcomeRef }, filesKept: state === 'approved' };
}

function Rail() {
  return <span data-testid="rail">{useDisplayedStatus('unused')}</span>;
}

function page(serverStatus: string, gateId: string) {
  return (
    <OptimisticStatusProvider serverStatus={serverStatus}>
      <DecidedGateStatusBridge gateId={gateId} />
      <Rail />
    </OptimisticStatusProvider>
  );
}

const rail = () => screen.getByTestId('rail').textContent;

afterEach(cleanup);

describe('the decided-gate status bridge (MOTIR-5570)', () => {
  it('an approval announced for this page’s gate moves the rail, with no server render', () => {
    render(page('in_progress', 'g-approve'));
    expect(rail()).toBe('in_progress');

    act(() => announceGateDecided(decision('g-approve', 'approved', 'done')));

    expect(rail()).toBe('done');
  });

  it('a request for changes writes no status, so the rail does not move', () => {
    render(page('in_progress', 'g-changes'));
    act(() => announceGateDecided(decision('g-changes', 'changes_requested', null)));
    expect(rail()).toBe('in_progress');
  });

  it('a decision about ANOTHER gate leaves this rail alone', () => {
    render(page('in_progress', 'g-mine'));
    act(() => announceGateDecided(decision('g-someone-else', 'approved', 'done')));
    expect(rail()).toBe('in_progress');
  });

  it('the server catching up keeps the status, and the server wins from then on', () => {
    const { rerender } = render(page('in_progress', 'g-reconcile'));
    act(() => announceGateDecided(decision('g-reconcile', 'approved', 'done')));
    expect(rail()).toBe('done');

    rerender(page('done', 'g-reconcile'));
    expect(rail()).toBe('done');

    // Reopened by hand later: the override is gone, so the server's value shows.
    rerender(page('in_progress', 'g-reconcile'));
    expect(rail()).toBe('in_progress');
  });

  it('a CHOICE moves the rail by what it WROTE, never by its option-id outcomeRef (MOTIR-5896)', () => {
    // A choice's `outcomeRef` is the option it picked (MOTIR-5893), so painting it
    // as a status would put "managed-object-storage" on the rail. The overlay
    // announces what the decision wrote, and that is what the rail shows.
    render(page('in_review', 'g-choice'));
    act(() =>
      announceGateDecided({
        gate: {
          ...GATE,
          id: 'g-choice',
          kind: 'decision_choice',
          state: 'approved',
          outcomeRef: 'managed-object-storage',
        },
        filesKept: null,
        statusWritten: 'done',
      }),
    );
    expect(rail()).toBe('done');
  });

  it('a decision announced BEFORE the page mounted is not re-applied', () => {
    act(() => announceGateDecided(decision('g-earlier', 'approved', 'done')));
    // The card has since been reopened; the store still remembers the old decision.
    render(page('in_progress', 'g-earlier'));
    expect(rail()).toBe('in_progress');
  });
});
