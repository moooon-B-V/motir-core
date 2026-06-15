import { describe, it, expect } from 'vitest';
import { parsePlanDelta, PlanDeltaValidationError } from '@/lib/ai/planDelta';

describe('parsePlanDelta', () => {
  it('accepts an empty operations list (the noop no-op)', () => {
    expect(parsePlanDelta({ operations: [] })).toEqual({ operations: [] });
  });

  it('parses a create op with a ref and parentKey', () => {
    const delta = parsePlanDelta({
      operations: [
        {
          op: 'create',
          ref: 's1',
          parentKey: 'MOTIR-478',
          kind: 'subtask',
          fields: { title: 'Do the thing', estimateMinutes: 30 },
        },
      ],
    });
    expect(delta.operations[0]).toMatchObject({
      op: 'create',
      ref: 's1',
      parentKey: 'MOTIR-478',
      kind: 'subtask',
      fields: { title: 'Do the thing', estimateMinutes: 30 },
    });
  });

  it('parses an update op', () => {
    const delta = parsePlanDelta({
      operations: [{ op: 'update', targetKey: 'MOTIR-481', fields: { title: 'Renamed' } }],
    });
    expect(delta.operations[0]).toEqual({
      op: 'update',
      targetKey: 'MOTIR-481',
      fields: { title: 'Renamed' },
    });
  });

  it('rejects a create missing a title', () => {
    expect(() =>
      parsePlanDelta({ operations: [{ op: 'create', kind: 'story', fields: {} }] }),
    ).toThrowError(/title is required/);
  });

  it('rejects setting both parentRef and parentKey', () => {
    expect(() =>
      parsePlanDelta({
        operations: [
          {
            op: 'create',
            kind: 'story',
            parentRef: 'a',
            parentKey: 'MOTIR-1',
            fields: { title: 'x' },
          },
        ],
      }),
    ).toThrowError(/at most one of parentRef/);
  });

  it('rejects an update missing targetKey', () => {
    expect(() =>
      parsePlanDelta({ operations: [{ op: 'update', fields: { title: 'x' } }] }),
    ).toThrowError(PlanDeltaValidationError);
  });

  it('rejects an unsupported op (link arrives with generation)', () => {
    expect(() =>
      parsePlanDelta({ operations: [{ op: 'link', fromKey: 'a', toKey: 'b' }] }),
    ).toThrowError(/must be "create" or "update"/);
  });

  it('rejects a non-array operations / non-object body', () => {
    expect(() => parsePlanDelta({ operations: 'nope' })).toThrowError(PlanDeltaValidationError);
    expect(() => parsePlanDelta(null)).toThrowError(PlanDeltaValidationError);
  });
});
