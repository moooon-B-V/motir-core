import { describe, expect, it } from 'vitest';
import {
  toDispatchRunLegGateDto,
  toDispatchRunWaitingCounts,
  type DispatchRunReader,
} from '@/lib/mappers/dispatchRunMappers';
import type { GateWithPeople } from '@/lib/repositories/approvalGateRepository';

// A RUN'S MANUAL LEG, NAMED FOR ITS READER (Story MOTIR-7460 · MOTIR-7477; coverage floor
// MOTIR-7479). The mapper the run detail, the history and the index all read each
// `needs_human` leg's gate through — pure, so every arm is pinned here rather than
// through a fixture per arm. The service-level reads are in `tests/dispatchRunService`.

const ada = { id: 'u-ada', name: 'Ada', email: 'ada@ex.com' };
const bo = { id: 'u-bo', name: '', email: 'bo@ex.com' };

const member = (userId: string): DispatchRunReader => ({ userId, visitor: false });
const visitor: DispatchRunReader = { userId: 'visitor', visitor: true };

function gate(over: Partial<GateWithPeople>): GateWithPeople {
  return {
    id: 'g1',
    workItemId: 'w1',
    state: 'awaiting',
    decidedByLabel: null,
    decidedBy: null,
    workItem: {
      assigneeId: ada.id,
      reporterId: bo.id,
      assignee: ada,
      reporter: bo,
    },
    ...over,
  } as GateWithPeople;
}

describe('toDispatchRunLegGateDto', () => {
  it('no gate is no gate', () => {
    expect(toDispatchRunLegGateDto(undefined, member(ada.id))).toBeNull();
  });

  it('awaiting, routed to the reader — waiting on YOU', () => {
    expect(toDispatchRunLegGateDto(gate({}), member(ada.id))).toEqual({
      state: 'awaiting',
      name: 'Ada',
      routedToReader: true,
    });
  });

  it('awaiting on an UNASSIGNED card names the reporter (§2), by email when nameless', () => {
    const unassigned = gate({
      workItem: { assigneeId: null, reporterId: bo.id, assignee: null, reporter: bo },
    });
    expect(toDispatchRunLegGateDto(unassigned, member(ada.id))).toEqual({
      state: 'awaiting',
      name: 'bo@ex.com',
      routedToReader: false,
    });
    expect(toDispatchRunLegGateDto(unassigned, member(bo.id))?.routedToReader).toBe(true);
  });

  it('a VISITOR is never routed to and never shown an email', () => {
    expect(toDispatchRunLegGateDto(gate({}), { ...visitor, userId: ada.id })).toEqual({
      state: 'awaiting',
      name: 'Ada',
      routedToReader: false,
    });
    const nameless = gate({
      workItem: { assigneeId: bo.id, reporterId: bo.id, assignee: bo, reporter: bo },
    });
    expect(toDispatchRunLegGateDto(nameless, visitor)?.name).not.toContain('@');
  });

  it('awaiting on a gate whose card is gone names nobody', () => {
    expect(toDispatchRunLegGateDto(gate({ workItem: null }), member(ada.id))).toEqual({
      state: 'awaiting',
      name: null,
      routedToReader: false,
    });
  });

  it('approved — the decider by row, else by the audit label with its email dropped', () => {
    expect(
      toDispatchRunLegGateDto(gate({ state: 'approved', decidedBy: ada }), member(bo.id)),
    ).toEqual({ state: 'approved', name: 'Ada', routedToReader: false });
    const labelled = gate({ state: 'approved', decidedByLabel: 'Grace Hopper <grace@ex.com>' });
    expect(toDispatchRunLegGateDto(labelled, member(bo.id))?.name).toBe('Grace Hopper');
    // A label that is ONLY an address leaves nothing to show.
    const bare = gate({ state: 'approved', decidedByLabel: '<grace@ex.com>' });
    expect(toDispatchRunLegGateDto(bare, member(bo.id))?.name).toBeNull();
    // A Visitor never has the stored label parsed for them.
    expect(toDispatchRunLegGateDto(labelled, visitor)?.name).toBeNull();
  });

  it.each(['superseded', 'changes_requested'] as const)('a %s gate reads as no gate', (state) => {
    expect(toDispatchRunLegGateDto(gate({ state }), member(ada.id))).toBeNull();
  });
});

describe('toDispatchRunWaitingCounts', () => {
  it('counts the awaiting legs by whether they wait on the reader, and nothing else', () => {
    expect(
      toDispatchRunWaitingCounts([
        { state: 'awaiting', name: 'Ada', routedToReader: true },
        { state: 'awaiting', name: 'Bo', routedToReader: false },
        { state: 'awaiting', name: null, routedToReader: false },
        { state: 'approved', name: 'Ada', routedToReader: false },
        null,
        undefined,
      ]),
    ).toEqual({ you: 1, others: 2 });
  });
});
