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

  it.each(['approved', 'overturned'] as const)('is null on a %s row', (state) => {
    const dto = toApprovalRecordDecidedRowDto({ ...base, state } as unknown as RecordGateRow, null);
    expect(dto.refusalReason).toBeNull();
  });
});
