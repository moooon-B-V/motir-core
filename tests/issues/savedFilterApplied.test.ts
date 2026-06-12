import { describe, expect, it } from 'vitest';
import { encodeFilterParam, type FilterAst } from '@/lib/filters/ast';
import type { ResolvedSavedFilterDto } from '@/lib/dto/savedFilters';
import {
  appliedFromResolved,
  currentFilterParam,
  isAppliedFilterDirty,
  type AppliedSavedFilter,
} from '@/lib/issues/savedFilterApplied';

// The applied-saved-filter session model (Story 6.2 · Subtask 6.2.3) — the pure
// dirty/apply helpers the /issues name chip is built on.

const AST_A: FilterAst = {
  combinator: 'and',
  conditions: [{ field: 'status', operator: 'is_any_of', value: ['todo'] }],
};
const AST_B: FilterAst = {
  combinator: 'and',
  conditions: [{ field: 'status', operator: 'is_any_of', value: ['todo', 'in_progress'] }],
};
const EMPTY: FilterAst = { combinator: 'and', conditions: [] };

function resolved(over: Partial<ResolvedSavedFilterDto> = {}): ResolvedSavedFilterDto {
  return {
    filter: {
      id: 'f1',
      name: 'Sprint blockers',
      description: null,
      visibility: 'project',
      owner: { id: 'u1', name: 'Zhu Yue' },
      starCount: 0,
      starredByMe: false,
      builtin: false,
      updatedAt: '2026-06-11T00:00:00.000Z',
    },
    ast: AST_A,
    astError: null,
    capabilities: { canManage: true, canDelete: true, canChangeOwner: false, canShare: true },
    ...over,
  };
}

describe('currentFilterParam', () => {
  it('encodes a non-empty AST to its canonical param', () => {
    expect(currentFilterParam(AST_A)).toBe(encodeFilterParam(AST_A));
  });

  it('is null for null and for an empty AST (matching setAdvancedParam emptiness)', () => {
    expect(currentFilterParam(null)).toBeNull();
    expect(currentFilterParam(EMPTY)).toBeNull();
  });
});

describe('isAppliedFilterDirty', () => {
  const applied: AppliedSavedFilter = {
    id: 'f1',
    name: 'Sprint blockers',
    ownerName: 'Zhu Yue',
    visibility: 'project',
    canOverwrite: true,
    builtin: false,
    envelopeParam: encodeFilterParam(AST_A),
  };

  it('is clean when the URL AST equals the saved envelope', () => {
    expect(isAppliedFilterDirty(applied, AST_A)).toBe(false);
  });

  it('is dirty when the URL AST diverges (a builder edit)', () => {
    expect(isAppliedFilterDirty(applied, AST_B)).toBe(true);
  });

  it('is dirty when the filter is cleared out from under an applied non-empty filter', () => {
    expect(isAppliedFilterDirty(applied, null)).toBe(true);
  });

  it('treats an empty-envelope applied filter (e.g. "All issues") as clean when no AST', () => {
    const allIssues: AppliedSavedFilter = { ...applied, envelopeParam: null };
    expect(isAppliedFilterDirty(allIssues, null)).toBe(false);
    expect(isAppliedFilterDirty(allIssues, EMPTY)).toBe(false);
    expect(isAppliedFilterDirty(allIssues, AST_A)).toBe(true);
  });
});

describe('appliedFromResolved', () => {
  it('maps a resolved saved filter, carrying owner/visibility/overwrite + the canonical envelope', () => {
    const applied = appliedFromResolved(resolved());
    expect(applied).toEqual({
      id: 'f1',
      name: 'Sprint blockers',
      ownerName: 'Zhu Yue',
      visibility: 'project',
      canOverwrite: true,
      builtin: false,
      envelopeParam: encodeFilterParam(AST_A),
    });
  });

  it('a non-owner / non-admin gets canOverwrite=false (Save-as only)', () => {
    const applied = appliedFromResolved(
      resolved({
        capabilities: { canManage: false, canDelete: false, canChangeOwner: false, canShare: true },
      }),
    );
    expect(applied?.canOverwrite).toBe(false);
  });

  it('a built-in carries null owner/visibility, canOverwrite=false, builtin=true', () => {
    const applied = appliedFromResolved(
      resolved({
        filter: { id: 'builtin:my-open-issues', name: 'My open issues', builtin: true },
        capabilities: {
          canManage: false,
          canDelete: false,
          canChangeOwner: false,
          canShare: false,
        },
      }),
    );
    expect(applied).toMatchObject({
      id: 'builtin:my-open-issues',
      name: 'My open issues',
      ownerName: null,
      visibility: null,
      canOverwrite: false,
      builtin: true,
    });
  });

  it('returns null for a degraded (non-resolvable) envelope — a broken filter cannot be applied', () => {
    expect(
      appliedFromResolved(
        resolved({ ast: null, astError: { ok: false, reason: 'malformed', detail: 'bad' } }),
      ),
    ).toBeNull();
  });
});
