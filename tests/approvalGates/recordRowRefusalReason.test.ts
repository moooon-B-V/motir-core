import { describe, expect, it } from 'vitest';
import { toApprovalRecordDecidedRowDto } from '@/lib/mappers/approvalGateMappers';
import type { RecordGateRow } from '@/lib/repositories/approvalGateRepository';

// A REFUSAL SAYS WHY (MOTIR-6075): the decided row carries the gate's note as its
// `refusalReason` on a `changes_requested` row ONLY — an approval's note (a synced review
// list) and an overturn's note are not a refusal's reason, and the row never quotes them.

const base = {
  id: 'g1',
  kind: 'design_result',
  decidedAt: new Date('2026-09-23T10:00:00Z'),
  decidedByLabel: 'Yue',
  decisionSource: 'ui',
  subjectVersion: 'abc',
  createdAt: new Date('2026-09-23T09:00:00Z'),
  chosenOption: null,
  confirmedRecord: null,
  noteMd: 'the note',
  workItem: {
    id: 'w1',
    key: 1,
    identifier: 'ACME-1',
    title: 't',
    kind: 'subtask',
    type: 'design',
  },
};

describe('toApprovalRecordDecidedRowDto · refusalReason', () => {
  it('carries the note on a changes_requested row', () => {
    const dto = toApprovalRecordDecidedRowDto(
      { ...base, state: 'changes_requested' } as unknown as RecordGateRow,
      null,
    );
    expect(dto.refusalReason).toBe('the note');
  });

  // A DECLINED plan (MOTIR-6037; ADR §11.4) quotes its note too — its reason is optional.
  it('carries the note on a declined plan row, and null when none was given', () => {
    const plan = { ...base, kind: 'plan_approval', workItem: null, state: 'declined' };
    expect(
      toApprovalRecordDecidedRowDto(plan as unknown as RecordGateRow, null).refusalReason,
    ).toBe('the note');
    expect(
      toApprovalRecordDecidedRowDto({ ...plan, noteMd: null } as unknown as RecordGateRow, null)
        .refusalReason,
    ).toBeNull();
  });

  it.each(['approved', 'overturned'] as const)('is null on a %s row', (state) => {
    const dto = toApprovalRecordDecidedRowDto({ ...base, state } as unknown as RecordGateRow, null);
    expect(dto.refusalReason).toBeNull();
  });
});
