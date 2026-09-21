import { describe, expect, it } from 'vitest';
import {
  foldPendingDecisions,
  type AwaitingGateForMarker,
} from '@/lib/approvalGates/pendingDecision';
import type { ApprovalGateKindDTO } from '@/lib/dto/approvalGate';

// THE FOLD behind the decision-waiting marker (MOTIR-5876), with no database.
//
// Every gate on one card shares that card's routing pair, so over real rows the
// only thing that can split a card's gates between `yours` and `others` is the
// kind's permission FLOOR. That split is exercised here, where the floor can be
// set per kind — the integration suite cannot reach it, because every registered
// kind names the same floor today.

const ME = 'me';
const THEM = 'them';

function g(
  workItemId: string,
  kind: ApprovalGateKindDTO,
  day: number,
  routing: { assigneeId: string | null; reporterId: string | null } = {
    assigneeId: ME,
    reporterId: THEM,
  },
): AwaitingGateForMarker {
  return { workItemId, kind, createdAt: new Date(Date.UTC(2026, 8, day)), workItem: routing };
}

const holdsAll = () => true;

describe('foldPendingDecisions', () => {
  it('routes by `assigneeId ?? reporterId` — the reporter only when nobody is assigned', () => {
    const out = foldPendingDecisions(
      [
        g('assigned-me', 'design_result', 1, { assigneeId: ME, reporterId: THEM }),
        g('reported-me', 'design_result', 1, { assigneeId: null, reporterId: ME }),
        g('reported-me-assigned-them', 'design_result', 1, { assigneeId: THEM, reporterId: ME }),
      ],
      ME,
      holdsAll,
    );
    expect(out.get('assigned-me')?.state).toBe('yours');
    expect(out.get('reported-me')?.state).toBe('yours');
    expect(out.get('reported-me-assigned-them')).toEqual({
      state: 'others',
      kind: 'design_result',
      routedToId: THEM,
    });
  });

  it('a later YOURS gate displaces an earlier OTHERS one on the same card', () => {
    // The acceptance gate is older but its floor is not held; the design gate is yours.
    const out = foldPendingDecisions(
      [g('card', 'acceptance_result', 1), g('card', 'design_result', 2)],
      ME,
      (kind) => kind !== 'acceptance_result',
    );
    expect(out.get('card')).toEqual({ state: 'yours', kind: 'design_result', routedToId: ME });
  });

  it('among several YOURS gates the OLDEST is kept; a later OTHERS never displaces it', () => {
    const out = foldPendingDecisions(
      [
        g('card', 'decision_approval', 1),
        g('card', 'design_result', 2),
        g('card', 'acceptance_result', 3),
      ],
      ME,
      (kind) => kind !== 'acceptance_result',
    );
    expect(out.get('card')?.kind).toBe('decision_approval');
    expect(out.get('card')?.state).toBe('yours');
  });

  it('with no YOURS gate, the OLDEST others gate is the entry', () => {
    const out = foldPendingDecisions(
      [g('card', 'design_result', 1), g('card', 'acceptance_result', 2)],
      ME,
      () => false,
    );
    expect(out.get('card')).toEqual({ state: 'others', kind: 'design_result', routedToId: ME });
  });

  it('an empty input is an empty map', () => {
    expect(foldPendingDecisions([], ME, holdsAll).size).toBe(0);
  });
});
