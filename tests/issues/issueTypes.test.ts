import { describe, expect, it } from 'vitest';
import {
  canParent,
  ISSUE_TYPE_META,
  ISSUE_TYPES,
  isIssueType,
  type IssueType,
} from '@/lib/issues/issueTypes';

// Unit tests for the issue-type metadata layer (lib/issues/issueTypes).
// Pure functions + constants — no DB. The `canParent` matrix is asserted over
// EVERY ordered (parent, child) pair so a future edit to ISSUE_TYPE_META that
// drifts from the DB kind-parent trigger fails here.

// The expected legal parent→child edges, transcribed independently from the
// DB kind-parent trigger (NOT read off ISSUE_TYPE_META) so the test is a
// genuine oracle rather than a tautology. Inverts the trigger's
// child→allowed-parents rule, incl. subtask.parent ∈ {story, task, bug}.
const LEGAL_EDGES: ReadonlyArray<[IssueType, IssueType]> = [
  ['epic', 'story'],
  ['epic', 'task'],
  ['epic', 'bug'],
  ['story', 'task'],
  ['story', 'bug'],
  ['story', 'subtask'],
  ['task', 'bug'],
  ['task', 'subtask'],
  ['bug', 'subtask'],
];

const isLegal = (parent: IssueType, child: IssueType): boolean =>
  LEGAL_EDGES.some(([p, c]) => p === parent && c === child);

describe('ISSUE_TYPES', () => {
  it('is exactly the five issue types in display order', () => {
    expect(ISSUE_TYPES).toEqual(['epic', 'story', 'task', 'bug', 'subtask']);
  });

  it('is total over the schema kind set (includes subtask)', () => {
    expect((ISSUE_TYPES as readonly string[]).includes('subtask')).toBe(true);
  });
});

describe('ISSUE_TYPE_META', () => {
  it('has a self-describing entry for every issue type', () => {
    for (const type of ISSUE_TYPES) {
      const meta = ISSUE_TYPE_META[type];
      expect(meta.type).toBe(type);
      expect(meta.label.length).toBeGreaterThan(0);
      // lucide icons are forwardRef components → object refs (not bare fns).
      expect(['object', 'function']).toContain(typeof meta.icon);
      expect(meta.icon).toBeTruthy();
      expect(meta.colorToken.length).toBeGreaterThan(0);
      expect(Array.isArray(meta.allowedChildTypes)).toBe(true);
    }
  });

  it('gives each type a distinct label, icon, and color token', () => {
    const labels = ISSUE_TYPES.map((t) => ISSUE_TYPE_META[t].label);
    const icons = ISSUE_TYPES.map((t) => ISSUE_TYPE_META[t].icon);
    const tokens = ISSUE_TYPES.map((t) => ISSUE_TYPE_META[t].colorToken);
    expect(new Set(labels).size).toBe(ISSUE_TYPES.length);
    expect(new Set(icons).size).toBe(ISSUE_TYPES.length);
    expect(new Set(tokens).size).toBe(ISSUE_TYPES.length);
  });

  it('only ever allows real issue types as children', () => {
    for (const type of ISSUE_TYPES) {
      for (const child of ISSUE_TYPE_META[type].allowedChildTypes) {
        expect(isIssueType(child)).toBe(true);
      }
    }
  });
});

describe('canParent — full matrix (every legal + illegal ordered pair)', () => {
  for (const parent of ISSUE_TYPES) {
    for (const child of ISSUE_TYPES) {
      const expected = isLegal(parent, child);
      it(`${parent} → ${child} is ${expected ? 'allowed' : 'rejected'}`, () => {
        expect(canParent(parent, child)).toBe(expected);
      });
    }
  }

  it('matches the documented edge set exactly (no extra legal pairs)', () => {
    const actual: Array<[IssueType, IssueType]> = [];
    for (const parent of ISSUE_TYPES) {
      for (const child of ISSUE_TYPES) {
        if (canParent(parent, child)) actual.push([parent, child]);
      }
    }
    expect(new Set(actual.map((e) => e.join('→')))).toEqual(
      new Set(LEGAL_EDGES.map((e) => e.join('→'))),
    );
  });

  it('forbids self-parenting for every type', () => {
    for (const type of ISSUE_TYPES) {
      expect(canParent(type, type)).toBe(false);
    }
  });

  it('makes subtask the single leaf and bug a subtask-parent (not a leaf)', () => {
    expect(ISSUE_TYPE_META.subtask.allowedChildTypes).toEqual([]);
    expect(canParent('bug', 'subtask')).toBe(true); // bug is NOT a leaf
    expect(ISSUE_TYPE_META.bug.allowedChildTypes).toEqual(['subtask']);
    expect(canParent('epic', 'subtask')).toBe(false); // epic can't directly parent a subtask
    expect(canParent('epic', 'story')).toBe(true);
    expect(canParent('story', 'epic')).toBe(false);
    expect(canParent('task', 'epic')).toBe(false);
  });
});

describe('isIssueType', () => {
  it('accepts all five issue types', () => {
    for (const type of ISSUE_TYPES) {
      expect(isIssueType(type)).toBe(true);
    }
    expect(isIssueType('subtask')).toBe(true);
  });

  it('rejects arbitrary input', () => {
    expect(isIssueType('Epic')).toBe(false); // case-sensitive
    expect(isIssueType('')).toBe(false);
    expect(isIssueType(null)).toBe(false);
    expect(isIssueType(undefined)).toBe(false);
    expect(isIssueType(42)).toBe(false);
    expect(isIssueType({ type: 'epic' })).toBe(false);
  });
});
