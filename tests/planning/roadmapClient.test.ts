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

// ── The STATUS key travels VERBATIM (bug MOTIR-3170) ────────────────────────
//
// This file used to have no status coverage at all, which is how a six-member
// literal — `todo · in_progress · in_review · blocked · done · cancelled` —
// survived here long enough for two statuses to be added to the default workflow
// (`implemented`, MOTIR-3003; `planning`, MOTIR-2425) and arrive as `todo`.
// `toStatus` coerced everything outside the set, so the canvas drew a card whose
// pull request was open as "To Do": not a missing chip, a WRONG one.
//
// The mapping is now a pass-through, and the assertions below are written on the
// KEY rather than on any map, so they still hold on the ninth status nobody has
// planned yet.
describe('roadmapClient.toItem — the status key (bug MOTIR-3170)', () => {
  it('passes `implemented` and `planning` through — the two the literal coerced to todo', () => {
    expect(toItem(wire({ status: 'implemented', isDone: false })).status).toBe('implemented');
    expect(toItem(wire({ status: 'planning', isDone: false })).status).toBe('planning');
  });

  it("passes a CUSTOM workflow's own status through — the open-set case", () => {
    // A project defines its own workflow; the wire type is `string` for exactly
    // this reason, and no literal in this file could ever enumerate it.
    const item = toItem(wire({ status: 'awaiting_legal', isDone: false }));
    expect(item.status).toBe('awaiting_legal');
  });

  it('carries the status LABEL and CATEGORY the level read resolved', () => {
    const item = toItem(
      wire({ status: 'implemented', statusLabel: 'Implemented', statusCategory: 'in_progress' }),
    );
    expect(item.statusLabel).toBe('Implemented');
    expect(item.statusCategory).toBe('in_progress');
  });

  it('degrades an ABSENT label / category to null (an older or onboarding wire row)', () => {
    const item = toItem(wire({ status: 'todo' }));
    expect(item.statusLabel).toBeNull();
    expect(item.statusCategory).toBeNull();
  });

  it('degrades an UNRECOGNISED category to null — the taxonomy IS closed, unlike the key', () => {
    const item = toItem(wire({ status: 'todo', statusCategory: 'not-a-category' }));
    expect(item.statusCategory).toBeNull();
    // …and the KEY is untouched by that guard.
    expect(item.status).toBe('todo');
  });

  it('never rewrites the key from `isDone` — the old fallback did exactly that', () => {
    // `isDone ? 'done' : 'todo'` is what turned an unrecognised status into a
    // confident, specific, wrong one. Neither value may move the key now.
    expect(toItem(wire({ status: 'awaiting_legal', isDone: true })).status).toBe('awaiting_legal');
    expect(toItem(wire({ status: 'awaiting_legal', isDone: false })).status).toBe('awaiting_legal');
  });

  it('the six statuses that already rendered still map to themselves, unchanged', () => {
    for (const key of ['todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled']) {
      expect(toItem(wire({ status: key, isDone: key === 'done' })).status).toBe(key);
    }
  });
});
