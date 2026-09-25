import { describe, expect, it } from 'vitest';
import { edgeLevel, isCrossLevelEdge } from '@/lib/workItems/edgeLevel';
import { ISSUE_TYPES } from '@/lib/issues/parentRules';

// MOTIR-6367 — the three levels a `blocked_by` may join within. Written against
// the CONTRACT (the story's own words: epic, story, leaf — a task, a bug and a
// subtask are all leaves), not by reading the module's table back.

describe('edgeLevel', () => {
  it('puts epic and story on their own levels, and every leaf kind on one', () => {
    expect(edgeLevel('epic')).toBe('epic');
    expect(edgeLevel('story')).toBe('story');
    expect(edgeLevel('task')).toBe('leaf');
    expect(edgeLevel('bug')).toBe('leaf');
    expect(edgeLevel('subtask')).toBe('leaf');
  });

  it('is total over the five issue types', () => {
    for (const kind of ISSUE_TYPES) expect(() => edgeLevel(kind)).not.toThrow();
  });

  it('throws on a string that is not a kind, rather than defaulting', () => {
    expect(() => edgeLevel('initiative')).toThrow(/not a work-item kind/);
    // An Object.prototype key is not a kind either.
    expect(() => edgeLevel('toString')).toThrow(/not a work-item kind/);
  });
});

describe('isCrossLevelEdge', () => {
  it('accepts every pair of leaves — a bug may block a subtask, a subtask a task', () => {
    for (const a of ['task', 'bug', 'subtask'])
      for (const b of ['task', 'bug', 'subtask']) expect(isCrossLevelEdge(a, b)).toBe(false);
  });

  it('accepts story↔story and epic↔epic', () => {
    expect(isCrossLevelEdge('story', 'story')).toBe(false);
    expect(isCrossLevelEdge('epic', 'epic')).toBe(false);
  });

  it('refuses every pair across levels, in both directions', () => {
    expect(isCrossLevelEdge('subtask', 'story')).toBe(true);
    expect(isCrossLevelEdge('story', 'subtask')).toBe(true);
    expect(isCrossLevelEdge('epic', 'subtask')).toBe(true);
    expect(isCrossLevelEdge('task', 'epic')).toBe(true);
    expect(isCrossLevelEdge('story', 'epic')).toBe(true);
  });
});
