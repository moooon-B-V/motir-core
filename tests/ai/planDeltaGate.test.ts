import { describe, expect, it } from 'vitest';

import { parsePlanDelta, PlanDeltaValidationError, type PlanDelta } from '@/lib/ai/planDelta';
import {
  collectReferencedKeys,
  gatePlanDelta,
  type ExistingNodeKind,
} from '@/lib/ai/planDeltaGate';

// The confirmation gate's VALIDATION half (7.12.5 · MOTIR-911), tested as the
// pure function it is — no database, because the whole point of this module is
// that it rules on a delta BEFORE anything is written. Its companion
// `aiPlanEditsIntegration.test.ts` proves the same rejections leave the tree
// untouched end-to-end; here we pin the rules themselves.

function delta(...operations: PlanDelta['operations']): PlanDelta {
  return { operations };
}

function existing(entries: Record<string, string>): Map<string, ExistingNodeKind> {
  return new Map(Object.entries(entries).map(([key, kind]) => [key, { kind }]));
}

const NONE = new Map<string, ExistingNodeKind>();

describe('collectReferencedKeys', () => {
  it('collects update targets and create parentKeys, deduped', () => {
    const d = delta(
      { op: 'update', targetKey: 'PROD-1', fields: {} },
      { op: 'create', kind: 'task', parentKey: 'PROD-1', fields: { title: 'a' } },
      { op: 'create', kind: 'task', parentKey: 'PROD-2', fields: { title: 'b' } },
    );
    expect(collectReferencedKeys(d).sort()).toEqual(['PROD-1', 'PROD-2']);
  });

  it('ignores intra-delta parentRefs (they name no existing row)', () => {
    const d = delta(
      { op: 'create', kind: 'story', ref: 'r', fields: { title: 'p' } },
      { op: 'create', kind: 'subtask', parentRef: 'r', fields: { title: 'c' } },
    );
    expect(collectReferencedKeys(d)).toEqual([]);
  });
});

describe('gatePlanDelta — the kind-parent grammar', () => {
  it('accepts a legal edge against an existing parent', () => {
    const d = delta({
      op: 'create',
      kind: 'subtask',
      parentKey: 'PROD-1',
      fields: { title: 'leaf' },
    });
    expect(() => gatePlanDelta(d, existing({ 'PROD-1': 'story' }))).not.toThrow();
  });

  it('rejects an illegal edge (a story may not hang off a task)', () => {
    const d = delta({
      op: 'create',
      kind: 'story',
      parentKey: 'PROD-1',
      fields: { title: 'nope' },
    });
    expect(() => gatePlanDelta(d, existing({ 'PROD-1': 'task' }))).toThrow(
      PlanDeltaValidationError,
    );
  });

  it('rejects a root-level subtask (a subtask must have a parent)', () => {
    const d = delta({ op: 'create', kind: 'subtask', fields: { title: 'orphan' } });
    expect(() => gatePlanDelta(d, NONE)).toThrow(PlanDeltaValidationError);
  });

  it('accepts a root-level epic', () => {
    const d = delta({ op: 'create', kind: 'epic', fields: { title: 'root' } });
    expect(() => gatePlanDelta(d, NONE)).not.toThrow();
  });

  it('checks the edge against an intra-delta parent too', () => {
    const legal = delta(
      { op: 'create', kind: 'story', ref: 'r', fields: { title: 'p' } },
      { op: 'create', kind: 'subtask', parentRef: 'r', fields: { title: 'c' } },
    );
    expect(() => gatePlanDelta(legal, NONE)).not.toThrow();

    const illegal = delta(
      { op: 'create', kind: 'subtask', ref: 'r', parentKey: 'PROD-1', fields: { title: 'p' } },
      { op: 'create', kind: 'subtask', parentRef: 'r', fields: { title: 'c' } },
    );
    // `subtask` is the single leaf — nothing may parent to it.
    expect(() => gatePlanDelta(illegal, existing({ 'PROD-1': 'story' }))).toThrow(
      PlanDeltaValidationError,
    );
  });

  it('rejects an unknown kind', () => {
    const d = delta({
      op: 'create',
      kind: 'saga' as never,
      fields: { title: 'x' },
    });
    expect(() => gatePlanDelta(d, NONE)).toThrow(/not a work-item kind/);
  });

  it('rejects a parentKey the caller could not resolve', () => {
    const d = delta({
      op: 'create',
      kind: 'task',
      parentKey: 'PROD-404',
      fields: { title: 'x' },
    });
    expect(() => gatePlanDelta(d, NONE)).toThrow(/did not resolve/);
  });
});

describe('gatePlanDelta — intra-delta refs', () => {
  it('orders creates so a parent precedes its child, whatever the submitted order', () => {
    const d = delta(
      { op: 'create', kind: 'subtask', parentRef: 'r', fields: { title: 'child' } },
      { op: 'create', kind: 'story', ref: 'r', fields: { title: 'parent' } },
    );
    const gated = gatePlanDelta(d, NONE);
    expect(gated.creates.map((c) => c.fields.title)).toEqual(['parent', 'child']);
  });

  it('keeps submitted order when no create references another', () => {
    const d = delta(
      { op: 'create', kind: 'task', fields: { title: 'one' } },
      { op: 'create', kind: 'task', fields: { title: 'two' } },
    );
    expect(gatePlanDelta(d, NONE).creates.map((c) => c.fields.title)).toEqual(['one', 'two']);
  });

  it('rejects a dangling parentRef', () => {
    const d = delta({
      op: 'create',
      kind: 'subtask',
      parentRef: 'ghost',
      fields: { title: 'x' },
    });
    expect(() => gatePlanDelta(d, NONE)).toThrow(/names no create in this delta/);
  });

  it('rejects a duplicated ref', () => {
    const d = delta(
      { op: 'create', kind: 'story', ref: 'r', fields: { title: 'a' } },
      { op: 'create', kind: 'story', ref: 'r', fields: { title: 'b' } },
    );
    expect(() => gatePlanDelta(d, NONE)).toThrow(/declared twice/);
  });

  it('rejects a parentRef cycle', () => {
    const d = delta(
      { op: 'create', kind: 'story', ref: 'a', parentRef: 'b', fields: { title: 'a' } },
      { op: 'create', kind: 'story', ref: 'b', parentRef: 'a', fields: { title: 'b' } },
    );
    expect(() => gatePlanDelta(d, NONE)).toThrow(/cycle/);
  });

  it('rejects a self-referencing create', () => {
    const d = delta({
      op: 'create',
      kind: 'story',
      ref: 'a',
      parentRef: 'a',
      fields: { title: 'a' },
    });
    expect(() => gatePlanDelta(d, NONE)).toThrow(/cycle/);
  });
});

describe('gatePlanDelta — enum-valued fields', () => {
  it('rejects an unknown work type', () => {
    const d = delta({
      op: 'create',
      kind: 'task',
      fields: { title: 'x', type: 'sorcery' as never },
    });
    expect(() => gatePlanDelta(d, NONE)).toThrow(/is not a work type/);
  });

  it('rejects a type on a container kind (types are leaf-only)', () => {
    const d = delta({ op: 'create', kind: 'epic', fields: { title: 'x', type: 'code' } });
    expect(() => gatePlanDelta(d, NONE)).toThrow(/leaf-only/);
  });

  it('accepts a type on a leaf kind', () => {
    const d = delta({ op: 'create', kind: 'task', fields: { title: 'x', type: 'code' } });
    expect(() => gatePlanDelta(d, NONE)).not.toThrow();
  });

  it('rejects an unknown priority, on a create and on an update alike', () => {
    const onCreate = delta({
      op: 'create',
      kind: 'task',
      fields: { title: 'x', priority: 'urgent' as never },
    });
    expect(() => gatePlanDelta(onCreate, NONE)).toThrow(/is not a priority/);

    const onUpdate = delta({
      op: 'update',
      targetKey: 'PROD-1',
      fields: { priority: 'urgent' as never },
    });
    expect(() => gatePlanDelta(onUpdate, existing({ 'PROD-1': 'task' }))).toThrow(
      /is not a priority/,
    );
  });

  it('leaves a null type alone (clearing is legal)', () => {
    const d = delta({ op: 'update', targetKey: 'PROD-1', fields: { type: null } });
    expect(() => gatePlanDelta(d, existing({ 'PROD-1': 'task' }))).not.toThrow();
  });
});

describe('gatePlanDelta — partitioning', () => {
  it('splits creates from updates and passes an empty delta through', () => {
    expect(gatePlanDelta(delta(), NONE)).toEqual({ creates: [], updates: [] });

    const d = delta(
      { op: 'update', targetKey: 'PROD-1', fields: { title: 'u' } },
      { op: 'create', kind: 'task', fields: { title: 'c' } },
    );
    const gated = gatePlanDelta(d, existing({ 'PROD-1': 'task' }));
    expect(gated.creates).toHaveLength(1);
    expect(gated.updates).toHaveLength(1);
  });

  it('runs over a delta that came through parsePlanDelta (the shipped shape gate)', () => {
    const parsed = parsePlanDelta({
      operations: [{ op: 'create', kind: 'task', fields: { title: 'from the wire' } }],
    });
    expect(gatePlanDelta(parsed, NONE).creates).toHaveLength(1);
  });
});
