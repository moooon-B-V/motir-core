import { describe, expect, it } from 'vitest';
import { toItem } from '@/lib/planning/roadmapClient';

// Unit — the raw-wire → RoadmapLevelItem mapping (MOTIR-1642 / 8.8.36). Focus:
// `type` / `executor` thread through, and an unknown / absent value degrades to
// `null` (the best-effort level read must never crash on an unexpected wire value,
// the same guard `kind` already uses). `toItem` is exported for this test.

// The raw wire shape `fetchRoadmapLevel` maps (a superset — extra keys are ignored).
function wire(overrides: Record<string, unknown> = {}) {
  return {
    id: 'w1',
    parentId: null,
    kind: 'subtask',
    identifier: 'MOTIR-943',
    title: 'Provision the source OAuth apps',
    status: 'todo',
    isDone: false,
    hasChildren: false,
    ...overrides,
  } as Parameters<typeof toItem>[0];
}

describe('roadmapClient.toItem — type / executor mapping (MOTIR-1642)', () => {
  it('threads a valid work type + executor through', () => {
    const item = toItem(wire({ type: 'manual', executor: 'human' }));
    expect(item.type).toBe('manual');
    expect(item.executor).toBe('human');
  });

  it('maps a coding_agent executor + code type through', () => {
    const item = toItem(wire({ type: 'code', executor: 'coding_agent' }));
    expect(item.type).toBe('code');
    expect(item.executor).toBe('coding_agent');
  });

  it('degrades an UNKNOWN type to null (does not crash)', () => {
    const item = toItem(wire({ type: 'not-a-real-type', executor: 'human' }));
    expect(item.type).toBeNull();
    // executor is still a valid value, so it maps through
    expect(item.executor).toBe('human');
  });

  it('degrades an unknown executor to null', () => {
    const item = toItem(wire({ type: 'manual', executor: 'robot' }));
    expect(item.executor).toBeNull();
    expect(item.type).toBe('manual');
  });

  it('maps absent type/executor to null (older / onboarding wire row)', () => {
    const item = toItem(wire());
    expect(item.type).toBeNull();
    expect(item.executor).toBeNull();
    // and the rest of the mapping is unaffected
    expect(item.kind).toBe('subtask');
    expect(item.identifier).toBe('MOTIR-943');
  });
});
