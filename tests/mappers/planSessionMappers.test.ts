// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { toPlanSessionRowDto } from '@/lib/mappers/planSessionMappers';
import type { PlanSessionListRow } from '@/lib/repositories/planChangeSessionRepository';

// MOTIR-8697 — the row mapper's SEED and FIRST-TURN rules for a guide-seeded
// session, beside the gate-seeded rows that must read exactly as before.

function row(over: Partial<PlanSessionListRow> = {}): PlanSessionListRow {
  return {
    id: 's_1',
    origin: 'conversation',
    targetKeys: ['ACME-30'],
    lastActivityAt: new Date('2026-10-15T00:00:00.000Z'),
    starterId: 'u1',
    starterName: 'Yue',
    firstTurn: 'ACME-31 · Rotate the key — the guide could not go further',
    planId: null,
    planStatus: null,
    planTitle: null,
    planSummary: null,
    planCount: 0,
    state: 'none',
    failedAt: null,
    failureReason: null,
    failureStopPhase: null,
    failureStopTitle: null,
    endedAt: null,
    endReason: null,
    endedById: null,
    endedByName: null,
    copiedFromId: null,
    copiedFromEndedAt: null,
    seedGateId: null,
    seedGateKind: null,
    seedGateState: null,
    seedChosenLabel: null,
    seedCardKey: null,
    seedCardInProject: false,
    seedGuideTurnId: null,
    seedGuideCardKey: null,
    seedGuideCardInProject: false,
    ...over,
  };
}

describe('toPlanSessionRowDto — a GUIDE seed (MOTIR-8697)', () => {
  it('names the guided card, with no gate kind and no chosen label, and keeps the first turn', () => {
    const dto = toPlanSessionRowDto(
      row({ seedGuideTurnId: 't_9', seedGuideCardKey: 'ACME-31', seedGuideCardInProject: true }),
    );
    expect(dto.seed).toEqual({
      cardKey: 'ACME-31',
      gateKind: null,
      origin: 'guide',
      chosenLabel: null,
    });
    expect(dto.firstTurn).toBe('ACME-31 · Rotate the key — the guide could not go further');
  });

  it('reads as UNSEEDED, with the first turn withheld, when the guided card left the project', () => {
    const dto = toPlanSessionRowDto(
      row({ seedGuideTurnId: 't_9', seedGuideCardKey: 'OTHER-2', seedGuideCardInProject: false }),
    );
    expect(dto.seed).toBeNull();
    expect(dto.firstTurn).toBeNull();
  });

  it('reads as UNSEEDED, with the first turn withheld, when the guided card is gone', () => {
    const dto = toPlanSessionRowDto(
      row({ seedGuideTurnId: 't_9', seedGuideCardKey: null, seedGuideCardInProject: false }),
    );
    expect(dto.seed).toBeNull();
    expect(dto.firstTurn).toBeNull();
  });
});

describe('toPlanSessionRowDto — gate seeds and no seed, unchanged', () => {
  it('a refusal', () => {
    const dto = toPlanSessionRowDto(
      row({
        seedGateId: 'g_1',
        seedGateKind: 'decision_approval',
        seedGateState: 'changes_requested',
        seedCardKey: 'ACME-44',
        seedCardInProject: true,
      }),
    );
    expect(dto.seed).toEqual({
      cardKey: 'ACME-44',
      gateKind: 'decision_approval',
      origin: 'refusal',
      chosenLabel: null,
    });
    expect(dto.firstTurn).not.toBeNull();
  });

  it('a pick', () => {
    const dto = toPlanSessionRowDto(
      row({
        seedGateId: 'g_2',
        seedGateKind: 'decision_choice',
        seedGateState: 'approved',
        seedChosenLabel: 'Managed object storage',
        seedCardKey: 'ACME-42',
        seedCardInProject: true,
      }),
    );
    expect(dto.seed).toEqual({
      cardKey: 'ACME-42',
      gateKind: 'decision_choice',
      origin: 'pick',
      chosenLabel: 'Managed object storage',
    });
  });

  it('a gate seed out of the project still withholds the first turn', () => {
    const dto = toPlanSessionRowDto(
      row({
        seedGateId: 'g_1',
        seedGateKind: 'decision_approval',
        seedCardKey: 'OTHER-1',
        seedCardInProject: false,
      }),
    );
    expect(dto.seed).toBeNull();
    expect(dto.firstTurn).toBeNull();
  });

  it('no seed at all', () => {
    const dto = toPlanSessionRowDto(row());
    expect(dto.seed).toBeNull();
    expect(dto.firstTurn).not.toBeNull();
  });
});
