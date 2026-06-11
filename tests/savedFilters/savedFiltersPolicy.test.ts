import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import type { ProjectAccessInputs } from '@/lib/projects/access';
import {
  canChangeSavedFilterOwner,
  canCreateSavedFilter,
  canManageSavedFilter,
  canSeeSavedFilter,
  savedFilterCapabilities,
  type SavedFilterProjectCapabilities,
} from '@/lib/savedFilters/access';
import {
  BUILTIN_FILTERS,
  builtinFilterById,
  builtinFilterId,
  isBuiltinFilterId,
} from '@/lib/savedFilters/builtins';
import { retryOnceOnUniqueRace } from '@/lib/savedFilters/retry';
import { validateFilterAst } from '@/lib/filters/registry';

// The PURE halves of Subtask 6.2.1 — the policy decision table, the built-in
// AST constants, and the unique-race retry — unit-tested in isolation (no
// DB), complementing the integration matrix in
// tests/integration/saved-filters/. These pin the branches the service can
// never reach through its hide-gates (e.g. row predicates under
// canBrowse=false: the service 404s on the project first) and the
// degenerate done-less-workflow built-ins.

function inputs(over: Partial<ProjectAccessInputs> = {}): ProjectAccessInputs {
  return { accessLevel: 'open', workspaceRole: 'member', projectRole: null, ...over };
}

function caps(over: Partial<SavedFilterProjectCapabilities> = {}): SavedFilterProjectCapabilities {
  return { canBrowse: true, canShare: true, isAdmin: false, ...over };
}

describe('savedFilterCapabilities — the project-level tier', () => {
  it('workspace owner/admin always sit in the admin tier', () => {
    expect(savedFilterCapabilities(inputs({ workspaceRole: 'owner' }))).toEqual({
      canBrowse: true,
      canShare: true,
      isAdmin: true,
    });
    expect(savedFilterCapabilities(inputs({ workspaceRole: 'admin' }))).toEqual({
      canBrowse: true,
      canShare: true,
      isAdmin: true,
    });
  });

  it('a project admin is the admin tier; a plain member shares but does not administer', () => {
    expect(savedFilterCapabilities(inputs({ projectRole: 'admin' }))).toEqual({
      canBrowse: true,
      canShare: true,
      isAdmin: true,
    });
    expect(savedFilterCapabilities(inputs({ projectRole: 'member' }))).toEqual({
      canBrowse: true,
      canShare: true,
      isAdmin: false,
    });
  });

  it('a project viewer browses but neither shares nor administers', () => {
    expect(savedFilterCapabilities(inputs({ projectRole: 'viewer' }))).toEqual({
      canBrowse: true,
      canShare: false,
      isAdmin: false,
    });
  });

  it('a non-workspace-member gets nothing (the always-deny rail)', () => {
    expect(savedFilterCapabilities(inputs({ workspaceRole: null }))).toEqual({
      canBrowse: false,
      canShare: false,
      isAdmin: false,
    });
  });
});

describe('the row predicates under a non-browsing actor (the rail the service 404s first)', () => {
  const noBrowse = caps({ canBrowse: false, canShare: false, isAdmin: false });

  it('cannot see, manage, create, or take ownership of anything', () => {
    const row = { isOwner: true, visibility: 'project' as const };
    expect(canSeeSavedFilter(noBrowse, row)).toBe(false);
    expect(canManageSavedFilter(noBrowse, row)).toBe(false);
    expect(canCreateSavedFilter(noBrowse, 'private')).toBe(false);
    expect(canChangeSavedFilterOwner(noBrowse, row)).toBe(false);
  });
});

describe('the row predicates — the cells the integration matrix pins end-to-end', () => {
  it('an admin sees but does not manage another user’s PRIVATE filter', () => {
    const admin = caps({ isAdmin: true });
    const privateRow = { isOwner: false, visibility: 'private' as const };
    expect(canSeeSavedFilter(admin, privateRow)).toBe(true);
    expect(canManageSavedFilter(admin, privateRow)).toBe(false);
    expect(canChangeSavedFilterOwner(admin, privateRow)).toBe(false);
  });

  it('a plain member neither sees others’ private rows nor manages shared ones', () => {
    const member = caps();
    expect(canSeeSavedFilter(member, { isOwner: false, visibility: 'private' })).toBe(false);
    expect(canManageSavedFilter(member, { isOwner: false, visibility: 'project' })).toBe(false);
  });
});

describe('built-ins — the degenerate done-less workflow + id plumbing', () => {
  const byname = new Map(BUILTIN_FILTERS.map((b) => [b.slug, b]));
  const empty = { userId: 'u-1', doneStatusKeys: [] };

  it('"Done issues" on a done-less workflow matches NOTHING (the never-match key)', () => {
    const ast = byname.get('done-issues')!.build(empty);
    expect(ast.conditions).toEqual([
      { field: 'status', operator: 'is_any_of', value: ['__no_done_status__'] },
    ]);
    validateFilterAst(ast); // still registry-valid — unknown keys match nothing
  });

  it('"Open issues" / "My open issues" on a done-less workflow drop the status row', () => {
    expect(byname.get('open-issues')!.build(empty).conditions).toEqual([]);
    expect(byname.get('my-open-issues')!.build(empty).conditions).toEqual([
      { field: 'assignee', operator: 'is_any_of', value: ['u-1'] },
    ]);
  });

  it('"Resolved recently" composes the done condition with the recency window', () => {
    const ast = byname.get('resolved-recently')!.build({ userId: 'u-1', doneStatusKeys: ['done'] });
    expect(ast.conditions).toEqual([
      { field: 'status', operator: 'is_any_of', value: ['done'] },
      { field: 'updated', operator: 'in_last_days', value: 7 },
    ]);
  });

  it('every builtin builds registry-valid for both empty and populated done keys', () => {
    for (const def of BUILTIN_FILTERS) {
      validateFilterAst(def.build(empty));
      validateFilterAst(def.build({ userId: 'u-1', doneStatusKeys: ['done', 'shipped'] }));
    }
  });

  it('id plumbing: prefix round-trip, non-builtin ids, unknown slugs', () => {
    expect(builtinFilterId('all-issues')).toBe('builtin:all-issues');
    expect(isBuiltinFilterId('builtin:all-issues')).toBe(true);
    expect(isBuiltinFilterId('cme4abc123')).toBe(false);
    expect(builtinFilterById('cme4abc123')).toBeNull();
    expect(builtinFilterById('builtin:no-such-slug')).toBeNull();
    expect(builtinFilterById('builtin:reported-by-me')?.name).toBe('Reported by me');
  });
});

describe('retryOnceOnUniqueRace — the unique-race backstop', () => {
  function p2002(): Prisma.PrismaClientKnownRequestError {
    return new Prisma.PrismaClientKnownRequestError('unique violation', {
      code: 'P2002',
      clientVersion: 'test',
    });
  }

  it('passes a clean run through once', async () => {
    const run = vi.fn(async () => 'ok');
    await expect(retryOnceOnUniqueRace(run)).resolves.toBe('ok');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('re-runs exactly once on a P2002 and returns the second result', async () => {
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(p2002())
      .mockResolvedValueOnce('second');
    await expect(retryOnceOnUniqueRace(run)).resolves.toBe('second');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('propagates a second P2002 and any non-P2002 error untouched', async () => {
    const twice = vi.fn<() => Promise<string>>().mockRejectedValue(p2002());
    await expect(retryOnceOnUniqueRace(twice)).rejects.toMatchObject({ code: 'P2002' });
    expect(twice).toHaveBeenCalledTimes(2);

    const other = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('boom'));
    await expect(retryOnceOnUniqueRace(other)).rejects.toThrow('boom');
    expect(other).toHaveBeenCalledTimes(1);
  });
});
