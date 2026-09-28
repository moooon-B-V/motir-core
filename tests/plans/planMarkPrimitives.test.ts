import { describe, expect, it } from 'vitest';

import { PLAN_ITEM_MARK_PATCH_KEYS } from '@/lib/dto/plans';
import { InvalidProposalError } from '@/lib/plans/errors';
import { isMarkOnlyPatch } from '@/lib/plans/markOnlyPatch';
import {
  assertMarkTargetIsFinished,
  patchSetsObsolescence,
  validateProposedObsolescence,
} from '@/lib/plans/validateProposedObsolescence';
import { firstLine } from '@/lib/workItems/obsolescenceNote';

// Story MOTIR-6577 · MOTIR-6633 — the coverage floor over the story's three PURE
// plan-path modules, pinned per file in `vitest.config.ts`. Each is a decision a
// unit pins without a database: which patch is mark-only (the terminal-card
// carve-out), which mark values the plan path admits and on which targets (the
// finished-card rule), and the note line every one-line surface prints. The
// assembled behaviour — the same verdicts reached through the doors onto real
// rows — is `tests/integration/plans/planMarkStoryGate.test.ts`.

describe('isMarkOnlyPatch — the carve-out’s one definition', () => {
  it('is true for any non-empty patch of mark keys only, each key alone and all six together', () => {
    for (const key of PLAN_ITEM_MARK_PATCH_KEYS) {
      expect(isMarkOnlyPatch({ [key]: null })).toBe(true);
    }
    expect(
      isMarkOnlyPatch(Object.fromEntries(PLAN_ITEM_MARK_PATCH_KEYS.map((k) => [k, null]))),
    ).toBe(true);
  });

  it('is false for an absent or empty patch — it marks nothing', () => {
    expect(isMarkOnlyPatch(null)).toBe(false);
    expect(isMarkOnlyPatch(undefined)).toBe(false);
    expect(isMarkOnlyPatch({})).toBe(false);
  });

  it('is false as soon as one non-mark key rides along, whatever it holds', () => {
    expect(isMarkOnlyPatch({ obsolescence: 'outdated', title: 'Renamed' })).toBe(false);
    expect(isMarkOnlyPatch({ supersedesAdd: ['x'], blockedByAdd: [] })).toBe(false);
    expect(isMarkOnlyPatch({ priority: undefined })).toBe(false);
  });
});

describe('validateProposedObsolescence — membership', () => {
  it('passes an absent patch, absent keys, explicit nulls and both members', () => {
    expect(() => validateProposedObsolescence(null, 'p')).not.toThrow();
    expect(() => validateProposedObsolescence(undefined, 'p')).not.toThrow();
    expect(() => validateProposedObsolescence({}, 'p')).not.toThrow();
    expect(() =>
      validateProposedObsolescence({ obsolescence: null, obsolescenceNoteMd: null }, 'p'),
    ).not.toThrow();
    for (const mark of ['outdated', 'deprecated']) {
      expect(() =>
        validateProposedObsolescence({ obsolescence: mark, obsolescenceNoteMd: 'why' }, 'p'),
      ).not.toThrow();
    }
  });

  it('refuses a value outside the enum as INVALID_PROPOSAL naming the value and the legal set', () => {
    const err = (() => {
      try {
        validateProposedObsolescence({ obsolescence: 'stale' }, 'The modify of PROD-1');
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(InvalidProposalError);
    expect((err as InvalidProposalError).message).toBe(
      'The modify of PROD-1: `obsolescence` "stale" is not an obsolescence mark. ' +
        'Legal values: outdated, deprecated, or null to clear it.',
    );
  });

  it('refuses a note that is not a string', () => {
    expect(() => validateProposedObsolescence({ obsolescenceNoteMd: 42 }, 'p')).toThrow(
      'p: `obsolescenceNoteMd` must be a Markdown string, or null to clear it.',
    );
  });
});

describe('assertMarkTargetIsFinished — the finished-card rule', () => {
  const target = (statusCategory: 'todo' | 'in_progress' | 'done' | null, status = 'x') => ({
    key: 'PROD-7',
    status,
    statusCategory,
  });

  it('passes a patch that sets no mark, or clears one, on ANY target', () => {
    for (const patch of [null, undefined, {}, { obsolescence: null }]) {
      expect(() => assertMarkTargetIsFinished(patch, target('todo'), 'p')).not.toThrow();
    }
  });

  it('passes a mark on a done-category target', () => {
    expect(() =>
      assertMarkTargetIsFinished({ obsolescence: 'deprecated' }, target('done'), 'p'),
    ).not.toThrow();
  });

  it('refuses a mark on a to-do, in-progress or unknown-status target, pointing at `remove`', () => {
    for (const cat of ['todo', 'in_progress', null] as const) {
      let caught: unknown = null;
      try {
        assertMarkTargetIsFinished(
          { obsolescence: 'outdated' },
          target(cat, 'in_review'),
          'The modify',
          'pi_1',
        );
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(InvalidProposalError);
      expect((caught as InvalidProposalError).planItemId).toBe('pi_1');
      expect((caught as Error).message).toContain(
        'The modify: a plan may mark only a finished work item; PROD-7 is at in_review.',
      );
      expect((caught as Error).message).toContain("op: 'remove'");
    }
  });

  it('patchSetsObsolescence reads only a non-null mark', () => {
    expect(patchSetsObsolescence(null)).toBe(false);
    expect(patchSetsObsolescence({})).toBe(false);
    expect(patchSetsObsolescence({ obsolescence: null })).toBe(false);
    expect(patchSetsObsolescence({ obsolescence: 'outdated' })).toBe(true);
  });
});

describe('firstLine — the note’s one-line form', () => {
  it('returns the first non-blank line, trimmed', () => {
    expect(firstLine('\n  \n  Replaced by PROD-9.  \nsecond line')).toBe('Replaced by PROD-9.');
  });

  it('is null for a null or all-blank note', () => {
    expect(firstLine(null)).toBeNull();
    expect(firstLine('')).toBeNull();
    expect(firstLine(' \n\t\n ')).toBeNull();
  });
});
