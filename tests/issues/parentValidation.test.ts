import { describe, expect, it } from 'vitest';
import {
  ALLOWED_CHILD_TYPES,
  ISSUE_TYPES,
  assertValidParent,
  canParent,
  type IssueType,
} from '@/lib/issues/parentRules';
import { canParent as canParentViaMetaModule } from '@/lib/issues/issueTypes';
import { IllegalParentTypeError } from '@/lib/workItems/errors';

// Subtask 2.1.2 — the service-layer kind-parent GATE (`assertValidParent`) and
// its single-source-of-truth guarantee. Pure logic, no DB.
//
// What this Subtask actually adds (the rest was already shipped by Story 1.4):
// 1.4.4 built `workItemsService` with kind-parent validation, the typed
// IllegalParentTypeError (→ 422), and create/update/move all gating on it;
// 1.4.7's tests/integration/work-items/kind-parent-matrix.test.ts drives the
// full 30-cell matrix through the SERVICE path against real Postgres, and
// repository.test.ts proves the DB trigger rejects a direct illegal write —
// together the "both layers reject" AC. What 1.4 left was a DUPLICATED matrix:
// 2.1.1's `canParent` (issueTypes.ts) AND the service's private
// `ALLOWED_PARENT_KINDS` were two encodings of the same rule. 2.1.2 collapses
// them into lib/issues/parentRules.ts and routes the service through
// `assertValidParent`. These tests pin that gate and prove the encodings can
// no longer drift.

const TYPES_REQUIRING_PARENT: ReadonlySet<IssueType> = new Set<IssueType>(['subtask']);

/**
 * The expected legal-parent matrix, written INDEPENDENTLY of the
 * implementation (the child → allowed-parents form, inverse of
 * ALLOWED_CHILD_TYPES) so these tests pin the contract rather than mirror the
 * code. `null` (top-level) is legal for every type except subtask.
 */
const ALLOWED_PARENTS: Record<IssueType, ReadonlySet<IssueType>> = {
  epic: new Set<IssueType>([]),
  story: new Set<IssueType>(['epic']),
  task: new Set<IssueType>(['epic', 'story']),
  bug: new Set<IssueType>(['epic', 'story', 'task']),
  subtask: new Set<IssueType>(['story', 'task', 'bug']),
};

function isLegal(parent: IssueType | null, child: IssueType): boolean {
  if (parent === null) return !TYPES_REQUIRING_PARENT.has(child);
  return ALLOWED_PARENTS[child].has(parent);
}

describe('assertValidParent — the service-layer gate (every cell)', () => {
  const PARENTS: readonly (IssueType | null)[] = [null, ...ISSUE_TYPES];

  for (const parent of PARENTS) {
    for (const child of ISSUE_TYPES) {
      const legal = isLegal(parent, child);
      const parentLabel = parent ?? 'null (top-level)';
      const verb = legal ? 'allows' : 'rejects';

      it(`${verb} a ${child} under ${parentLabel}`, () => {
        if (legal) {
          expect(() => assertValidParent(parent, child)).not.toThrow();
        } else {
          expect(() => assertValidParent(parent, child)).toThrow(IllegalParentTypeError);
        }
      });
    }
  }

  it('rejects the orphan-subtask case with a specific message', () => {
    expect(() => assertValidParent(null, 'subtask')).toThrow(/must have a parent/);
  });

  it('names the offending pair in the message', () => {
    expect(() => assertValidParent('subtask', 'story')).toThrow(
      /A story may not be parented to a subtask/,
    );
  });

  it('throws the typed error carrying the ILLEGAL_PARENT_TYPE code (→ 422)', () => {
    try {
      assertValidParent('bug', 'epic');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(IllegalParentTypeError);
      expect((err as IllegalParentTypeError).code).toBe('ILLEGAL_PARENT_TYPE');
    }
  });
});

describe('single source of truth — no second matrix can drift', () => {
  it('assertValidParent agrees with canParent on every ordered type pair', () => {
    for (const parent of ISSUE_TYPES) {
      for (const child of ISSUE_TYPES) {
        const threw = (() => {
          try {
            assertValidParent(parent, child);
            return false;
          } catch {
            return true;
          }
        })();
        // The gate rejects a (parent, child) pair exactly when canParent is false.
        expect(threw).toBe(!canParent(parent, child));
      }
    }
  });

  it('issueTypes.canParent is the SAME function as parentRules.canParent (re-export, not a copy)', () => {
    // 2.1.1's public surface (`@/lib/issues/issueTypes`) must resolve to the
    // one rule-layer implementation — a separate copy would be a second source
    // of truth. Referential identity proves it is a re-export.
    expect(canParentViaMetaModule).toBe(canParent);
  });

  it('canParent is the exact inverse of the ALLOWED_PARENTS spec', () => {
    for (const parent of ISSUE_TYPES) {
      for (const child of ISSUE_TYPES) {
        expect(canParent(parent, child)).toBe(ALLOWED_PARENTS[child].has(parent));
      }
    }
  });

  it('ALLOWED_CHILD_TYPES is total over every issue type', () => {
    for (const type of ISSUE_TYPES) {
      expect(ALLOWED_CHILD_TYPES[type]).toBeDefined();
    }
  });
});
