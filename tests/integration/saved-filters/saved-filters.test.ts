import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub ONLY `getWorkspaceContext` (the cookie-derived resolver the test env
// can't supply) — the single allowed mock, per CLAUDE.md. Service-level tests
// pass `ctx` explicitly; the route transport tests drive `wsCtx.current`.
import type { WorkspaceContext } from '@/lib/workspaces';
const wsCtx = { current: null as WorkspaceContext | null };
vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => wsCtx.current };
});

import { db } from '@/lib/db';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workflowsRepository } from '@/lib/repositories/workflowsRepository';
import { encodeFilterParam, FILTER_ROW_CAP, type FilterAst } from '@/lib/filters/ast';
import {
  InvalidFilterValueError,
  MalformedFilterError,
  UnknownFilterOperatorError,
} from '@/lib/filters/errors';
import {
  BuiltinSavedFilterImmutableError,
  InvalidSavedFilterNameError,
  InvalidSavedFilterOwnerError,
  SavedFilterForbiddenError,
  SavedFilterNameConflictError,
  SavedFilterNotFoundError,
  type SavedFilterAction,
} from '@/lib/savedFilters/errors';
import { BUILTIN_FILTERS, builtinFilterId } from '@/lib/savedFilters/builtins';
import { SAVED_FILTER_NAME_MAX_LENGTH } from '@/lib/savedFilters/constants';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { GET as listGET, POST as createPOST } from '@/app/api/projects/[key]/saved-filters/route';
import { GET as resolveGET } from '@/app/api/projects/[key]/saved-filters/[filterId]/route';
import {
  createTestProject,
  createTestUser,
  createTestWorkItem,
  makeWorkItemFixture,
} from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';
import { everyConditionShape } from '../../helpers/filterAstSamples';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// Story 6.2 · Subtask 6.2.1 — the saved-filter persistence + permission
// layer. Real Postgres (no mocks except getWorkspaceContext for the route
// transport), per CLAUDE.md. Asserts: the (role × visibility × action)
// matrix; the persist→resolve round-trip over EVERY registry (field,
// operator) shape (the 6.1.1 generators against the STORED path); the
// stale-referent and malformed/future-versioned envelope degradations; the
// built-in defaults (resolve + immutability); name uniqueness; bounded
// server-searched pagination; star aggregation; the dependents seam; and the
// private-invisibility rule at the service AND route layer.

const SIMPLE_AST: FilterAst = {
  combinator: 'and',
  conditions: [{ field: 'priority', operator: 'is_any_of', value: ['high', 'highest'] }],
};

function param(ast: FilterAst = SIMPLE_AST): string {
  return encodeFilterParam(ast);
}

interface Team {
  fx: WorkItemFixture;
  key: string;
  /** Workspace owner — the always-pass admin tier. */
  ownerCtx: ServiceContext;
  /** Project admin (workspace member + project role admin). */
  adminCtx: ServiceContext;
  /** Project member — the share-capable rank and the matrix's filter owner. */
  memberCtx: ServiceContext;
  /** Second plain member (no relation to the filters under test). */
  otherCtx: ServiceContext;
  /** Project viewer — the read-only persona. */
  viewerCtx: ServiceContext;
  memberId: string;
  viewerId: string;
}

let seq = 0;

/** Owner + admin/member/other/viewer enrolled in the fixture project. */
async function makeTeam(): Promise<Team> {
  seq += 1;
  const fx = await makeWorkItemFixture({ identifier: `T${String(seq).padStart(3, '0')}` });
  const key = fx.projectIdentifier;

  async function enroll(slug: string, role: 'admin' | 'member' | 'viewer') {
    const user = await createTestUser({ email: `${slug}-${seq}@example.com`, name: slug });
    await workspacesService.addMember({
      userId: user.id,
      workspaceId: fx.workspaceId,
      role: 'member',
    });
    await projectMembersService.addMember({
      key,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      targetUserId: user.id,
      role,
    });
    return user;
  }

  const admin = await enroll('admin', 'admin');
  const member = await enroll('member', 'member');
  const other = await enroll('other', 'member');
  const viewer = await enroll('viewer', 'viewer');
  const ctxFor = (userId: string): ServiceContext => ({ userId, workspaceId: fx.workspaceId });
  return {
    fx,
    key,
    ownerCtx: fx.ctx,
    adminCtx: ctxFor(admin.id),
    memberCtx: ctxFor(member.id),
    otherCtx: ctxFor(other.id),
    viewerCtx: ctxFor(viewer.id),
    memberId: member.id,
    viewerId: viewer.id,
  };
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('create — visibility gates + validation + uniqueness', () => {
  it('a member saves a project-shared filter and gets the summary DTO', async () => {
    const t = await makeTeam();
    const dto = await savedFiltersService.create(
      t.key,
      { name: 'Sprint blockers', visibility: 'project', filterParam: param() },
      t.memberCtx,
    );
    expect(dto).toMatchObject({
      name: 'Sprint blockers',
      description: null,
      visibility: 'project',
      owner: { id: t.memberId },
      starCount: 0,
      starredByMe: false,
      builtin: false,
    });
  });

  it('a viewer saves PRIVATE filters freely but never project-shared ones', async () => {
    const t = await makeTeam();
    const dto = await savedFiltersService.create(
      t.key,
      { name: 'mine', visibility: 'private', filterParam: param() },
      t.viewerCtx,
    );
    expect(dto.visibility).toBe('private');
    await expect(
      savedFiltersService.create(
        t.key,
        { name: 'shared', visibility: 'project', filterParam: param() },
        t.viewerCtx,
      ),
    ).rejects.toThrow(SavedFilterForbiddenError);
  });

  it('names are case-insensitively unique per project (the 409), trimmed and capped', async () => {
    const t = await makeTeam();
    await savedFiltersService.create(
      t.key,
      { name: 'Sprint Blockers', visibility: 'project', filterParam: param() },
      t.memberCtx,
    );
    await expect(
      savedFiltersService.create(
        t.key,
        { name: '  sprint blockers ', visibility: 'private', filterParam: param() },
        t.ownerCtx,
      ),
    ).rejects.toThrow(SavedFilterNameConflictError);
    await expect(
      savedFiltersService.create(
        t.key,
        { name: '   ', visibility: 'private', filterParam: param() },
        t.ownerCtx,
      ),
    ).rejects.toThrow(InvalidSavedFilterNameError);
    await expect(
      savedFiltersService.create(
        t.key,
        {
          name: 'x'.repeat(SAVED_FILTER_NAME_MAX_LENGTH + 1),
          visibility: 'private',
          filterParam: param(),
        },
        t.ownerCtx,
      ),
    ).rejects.toThrow(InvalidSavedFilterNameError);
  });

  it('an invalid INCOMING criteria param is a typed 422 rejection, not a stored landmine', async () => {
    const t = await makeTeam();
    await expect(
      savedFiltersService.create(
        t.key,
        { name: 'broken', visibility: 'private', filterParam: 'not-a-param' },
        t.ownerCtx,
      ),
    ).rejects.toThrow(MalformedFilterError);
    await expect(
      savedFiltersService.create(
        t.key,
        {
          name: 'bad-op',
          visibility: 'private',
          filterParam: encodeFilterParam({
            combinator: 'and',
            conditions: [{ field: 'text', operator: 'is_any_of', value: ['x'] }],
          }),
        },
        t.ownerCtx,
      ),
    ).rejects.toThrow(UnknownFilterOperatorError);
    await expect(
      savedFiltersService.create(
        t.key,
        {
          name: 'bad-kind',
          visibility: 'private',
          filterParam: encodeFilterParam({
            combinator: 'and',
            conditions: [{ field: 'kind', operator: 'is_any_of', value: ['not-a-kind'] }],
          }),
        },
        t.ownerCtx,
      ),
    ).rejects.toThrow(InvalidFilterValueError);
  });

  it('a cross-tenant project key reads as ProjectNotFound (no existence leak)', async () => {
    const t = await makeTeam();
    const stranger = await makeWorkItemFixture({ name: 'Strangers', identifier: 'STRX' });
    await expect(
      savedFiltersService.create(
        t.key,
        { name: 'spy', visibility: 'private', filterParam: param() },
        stranger.ctx,
      ),
    ).rejects.toThrow(ProjectNotFoundError);
  });
});

describe('update — rename, details, and the cross-project hide-gate', () => {
  it('renames (case-insensitive conflict; renaming to one’s own casing is fine)', async () => {
    const t = await makeTeam();
    const a = await savedFiltersService.create(
      t.key,
      { name: 'Alpha', visibility: 'project', filterParam: param() },
      t.memberCtx,
    );
    await savedFiltersService.create(
      t.key,
      { name: 'Beta', visibility: 'project', filterParam: param() },
      t.memberCtx,
    );
    await expect(
      savedFiltersService.update(t.key, a.id, { name: 'beta' }, t.memberCtx),
    ).rejects.toThrow(SavedFilterNameConflictError);
    const recased = await savedFiltersService.update(t.key, a.id, { name: 'ALPHA' }, t.memberCtx);
    expect(recased.name).toBe('ALPHA');
    const renamed = await savedFiltersService.update(t.key, a.id, { name: 'Gamma' }, t.memberCtx);
    expect(renamed.name).toBe('Gamma');
  });

  it('stores + clears descriptions, capping the length', async () => {
    const t = await makeTeam();
    const dto = await savedFiltersService.create(
      t.key,
      {
        name: 'documented',
        description: '  what this slices  ',
        visibility: 'private',
        filterParam: param(),
      },
      t.memberCtx,
    );
    expect(dto.description).toBe('what this slices');
    const cleared = await savedFiltersService.update(
      t.key,
      dto.id,
      { description: '   ' },
      t.memberCtx,
    );
    expect(cleared.description).toBeNull();
    await expect(
      savedFiltersService.update(t.key, dto.id, { description: 'x'.repeat(501) }, t.memberCtx),
    ).rejects.toThrow(InvalidSavedFilterNameError);
  });

  it('a filter id from a sibling project reads as not-found through this project’s routes', async () => {
    const t = await makeTeam();
    const sibling = await createTestProject({
      workspaceId: t.fx.workspaceId,
      actorUserId: t.fx.ownerId,
      identifier: 'SIBL',
    });
    const foreign = await savedFiltersService.create(
      sibling.identifier,
      { name: 'foreign', visibility: 'project', filterParam: param() },
      t.ownerCtx,
    );
    await expect(savedFiltersService.resolve(t.key, foreign.id, t.ownerCtx)).rejects.toThrow(
      SavedFilterNotFoundError,
    );
    await expect(
      savedFiltersService.update(t.key, foreign.id, { name: 'hijack' }, t.ownerCtx),
    ).rejects.toThrow(SavedFilterNotFoundError);
  });

  it('unstar on a builtin is immutable like every other write', async () => {
    const t = await makeTeam();
    await expect(
      savedFiltersService.unstar(t.key, builtinFilterId('all-issues'), t.ownerCtx),
    ).rejects.toThrow(BuiltinSavedFilterImmutableError);
  });
});

describe('the (role × visibility × action) permission matrix', () => {
  type Cell = 'ok' | 'not-found' | 'forbidden';
  type Actor = 'owner-of-filter' | 'project-admin' | 'workspace-owner' | 'other-member' | 'viewer';

  // One row per (action × visibility × actor) — table-driven so the
  // expectations are enumerable; the totality guard below fails the suite
  // if a SavedFilterAction ever lacks matrix rows (the 6.2.6 pattern).
  const MATRIX: Array<{
    action: SavedFilterAction;
    visibility: 'private' | 'project';
    cells: Record<Actor, Cell>;
  }> = [
    {
      action: 'create',
      visibility: 'private',
      cells: {
        'owner-of-filter': 'ok',
        'project-admin': 'ok',
        'workspace-owner': 'ok',
        'other-member': 'ok',
        viewer: 'ok',
      },
    },
    {
      action: 'share',
      visibility: 'project',
      cells: {
        'owner-of-filter': 'ok',
        'project-admin': 'ok',
        'workspace-owner': 'ok',
        'other-member': 'ok',
        viewer: 'forbidden',
      },
    },
    {
      // SEE rides 'update' rows implicitly: a not-found cell asserts the SEE
      // gate, a forbidden cell asserts visible-but-unmanageable.
      action: 'update',
      visibility: 'private',
      cells: {
        'owner-of-filter': 'ok',
        'project-admin': 'forbidden', // sees it, cannot rewrite it
        'workspace-owner': 'forbidden',
        'other-member': 'not-found', // cannot even see it
        viewer: 'not-found',
      },
    },
    {
      action: 'update',
      visibility: 'project',
      cells: {
        'owner-of-filter': 'ok',
        'project-admin': 'ok',
        'workspace-owner': 'ok',
        'other-member': 'forbidden',
        viewer: 'forbidden',
      },
    },
    {
      action: 'delete',
      visibility: 'private',
      cells: {
        'owner-of-filter': 'ok',
        'project-admin': 'forbidden',
        'workspace-owner': 'forbidden',
        'other-member': 'not-found',
        viewer: 'not-found',
      },
    },
    {
      action: 'delete',
      visibility: 'project',
      cells: {
        'owner-of-filter': 'ok',
        'project-admin': 'ok',
        'workspace-owner': 'ok',
        'other-member': 'forbidden',
        viewer: 'forbidden',
      },
    },
    {
      action: 'change-owner',
      visibility: 'private',
      cells: {
        'owner-of-filter': 'forbidden',
        'project-admin': 'forbidden',
        'workspace-owner': 'forbidden',
        'other-member': 'not-found',
        viewer: 'not-found',
      },
    },
    {
      action: 'change-owner',
      visibility: 'project',
      cells: {
        'owner-of-filter': 'forbidden', // owner ≠ admin: hand-off is the admin power
        'project-admin': 'ok',
        'workspace-owner': 'ok',
        'other-member': 'forbidden',
        viewer: 'forbidden',
      },
    },
  ];

  it('covers every SavedFilterAction (totality guard)', () => {
    const ACTIONS: SavedFilterAction[] = ['create', 'share', 'update', 'delete', 'change-owner'];
    for (const action of ACTIONS) {
      expect(
        MATRIX.some((row) => row.action === action),
        `matrix has no rows for action "${action}"`,
      ).toBe(true);
    }
  });

  function actorCtx(t: Team, actor: Actor): ServiceContext {
    switch (actor) {
      case 'owner-of-filter':
        return t.memberCtx;
      case 'project-admin':
        return t.adminCtx;
      case 'workspace-owner':
        return t.ownerCtx;
      case 'other-member':
        return t.otherCtx;
      case 'viewer':
        return t.viewerCtx;
    }
  }

  async function runAction(
    t: Team,
    action: SavedFilterAction,
    visibility: 'private' | 'project',
    actor: Actor,
    filterId: string,
  ): Promise<void> {
    const ctx = actorCtx(t, actor);
    switch (action) {
      case 'create':
        await savedFiltersService.create(
          t.key,
          { name: `c-${actor}`, visibility, filterParam: param() },
          ctx,
        );
        return;
      case 'share':
        await savedFiltersService.create(
          t.key,
          { name: `s-${actor}`, visibility: 'project', filterParam: param() },
          ctx,
        );
        return;
      case 'update':
        await savedFiltersService.update(t.key, filterId, { description: `by ${actor}` }, ctx);
        return;
      case 'delete':
        await savedFiltersService.delete(t.key, filterId, ctx);
        return;
      case 'change-owner':
        await savedFiltersService.changeOwner(t.key, filterId, t.viewerId, ctx);
        return;
    }
  }

  for (const row of MATRIX) {
    for (const [actor, cell] of Object.entries(row.cells) as Array<[Actor, Cell]>) {
      it(`${row.action} on a ${row.visibility} filter as ${actor} → ${cell}`, async () => {
        const t = await makeTeam();
        // The subject filter is owned by the plain MEMBER.
        const subject = await savedFiltersService.create(
          t.key,
          { name: 'subject', visibility: row.visibility, filterParam: param() },
          t.memberCtx,
        );
        const run = runAction(t, row.action, row.visibility, actor, subject.id);
        if (cell === 'ok') {
          await expect(run).resolves.toBeUndefined();
        } else if (cell === 'not-found') {
          await expect(run).rejects.toThrow(SavedFilterNotFoundError);
        } else {
          await expect(run).rejects.toThrow(SavedFilterForbiddenError);
        }
      });
    }
  }

  it('private filters never appear in another user’s reads (list + resolve + dependents)', async () => {
    const t = await makeTeam();
    const secret = await savedFiltersService.create(
      t.key,
      { name: 'secret', visibility: 'private', filterParam: param() },
      t.memberCtx,
    );
    const page = await savedFiltersService.list(t.key, {}, t.otherCtx);
    expect(page.items.map((f) => f.id)).not.toContain(secret.id);
    await expect(savedFiltersService.resolve(t.key, secret.id, t.otherCtx)).rejects.toThrow(
      SavedFilterNotFoundError,
    );
    await expect(savedFiltersService.getDependents(t.key, secret.id, t.otherCtx)).rejects.toThrow(
      SavedFilterNotFoundError,
    );
    // The admin tier DOES see it (visible ≠ manageable).
    const adminPage = await savedFiltersService.list(t.key, {}, t.adminCtx);
    expect(adminPage.items.map((f) => f.id)).toContain(secret.id);
    // Flipping it shared makes it appear to everyone.
    await savedFiltersService.update(t.key, secret.id, { visibility: 'project' }, t.memberCtx);
    const after = await savedFiltersService.list(t.key, {}, t.otherCtx);
    expect(after.items.map((f) => f.id)).toContain(secret.id);
  });

  it('change-owner validates the target (must exist + browse the project)', async () => {
    const t = await makeTeam();
    const shared = await savedFiltersService.create(
      t.key,
      { name: 'handoff', visibility: 'project', filterParam: param() },
      t.memberCtx,
    );
    await expect(
      savedFiltersService.changeOwner(t.key, shared.id, 'no-such-user', t.adminCtx),
    ).rejects.toThrow(InvalidSavedFilterOwnerError);
    const updated = await savedFiltersService.changeOwner(t.key, shared.id, t.viewerId, t.adminCtx);
    expect(updated.owner.id).toBe(t.viewerId);
  });

  it('an owner who is a viewer cannot flip their private filter to project', async () => {
    const t = await makeTeam();
    const mine = await savedFiltersService.create(
      t.key,
      { name: 'viewer-own', visibility: 'private', filterParam: param() },
      t.viewerCtx,
    );
    await expect(
      savedFiltersService.update(t.key, mine.id, { visibility: 'project' }, t.viewerCtx),
    ).rejects.toThrow(SavedFilterForbiddenError);
  });
});

describe('persist → resolve round-trips every constructible AST (the stored path)', () => {
  it('round-trips every registry (field, operator) shape through the envelope', async () => {
    const t = await makeTeam();
    const all = everyConditionShape();
    for (let start = 0; start < all.length; start += FILTER_ROW_CAP) {
      const ast: FilterAst = {
        combinator: start === 0 ? 'and' : 'or',
        conditions: all.slice(start, start + FILTER_ROW_CAP),
      };
      const created = await savedFiltersService.create(
        t.key,
        { name: `chunk-${start}`, visibility: 'private', filterParam: encodeFilterParam(ast) },
        t.ownerCtx,
      );
      const resolved = await savedFiltersService.resolve(t.key, created.id, t.ownerCtx);
      expect(resolved.astError).toBeNull();
      expect(resolved.ast).toEqual(ast);
    }
  });

  it('the owner’s overwrite-Save replaces the criteria and round-trips', async () => {
    const t = await makeTeam();
    const created = await savedFiltersService.create(
      t.key,
      { name: 'evolving', visibility: 'private', filterParam: param() },
      t.ownerCtx,
    );
    const next: FilterAst = {
      combinator: 'or',
      conditions: [{ field: 'text', operator: 'contains', value: 'login' }],
    };
    await savedFiltersService.update(
      t.key,
      created.id,
      { filterParam: encodeFilterParam(next) },
      t.ownerCtx,
    );
    const resolved = await savedFiltersService.resolve(t.key, created.id, t.ownerCtx);
    expect(resolved.ast).toEqual(next);
  });
});

describe('durability — stale referents degrade, corrupt envelopes recover typed', () => {
  it('a stale OPEN referent stays resolvable and matches nothing (the 6.1.2 rule)', async () => {
    const t = await makeTeam();
    await createTestWorkItem(t.fx, { kind: 'task', title: 'alive' });
    const staleAst: FilterAst = {
      combinator: 'and',
      conditions: [{ field: 'assignee', operator: 'is_any_of', value: ['user-deleted-long-ago'] }],
    };
    const created = await savedFiltersService.create(
      t.key,
      { name: 'stale', visibility: 'private', filterParam: encodeFilterParam(staleAst) },
      t.ownerCtx,
    );
    const resolved = await savedFiltersService.resolve(t.key, created.id, t.ownerCtx);
    expect(resolved.astError).toBeNull();
    expect(resolved.ast).toEqual(staleAst);
    // The resolved AST compiles and matches NOTHING — never an error.
    const matches = await workItemRepository.countProjectIssues(t.fx.projectId, t.fx.workspaceId, {
      ast: resolved.ast!,
    });
    expect(matches).toBe(0);
    // Control: the same read with a live referent matches the seeded item.
    const live = await workItemRepository.countProjectIssues(t.fx.projectId, t.fx.workspaceId, {
      ast: {
        combinator: 'and',
        conditions: [{ field: 'kind', operator: 'is_any_of', value: ['task'] }],
      },
    });
    expect(live).toBe(1);
  });

  async function corruptEnvelope(filterId: string, envelope: unknown): Promise<void> {
    await db.savedFilter.update({
      where: { id: filterId },
      data: { astEnvelope: envelope as never },
    });
  }

  it.each([
    ['hand-corrupted (no version)', { garbage: true }, 'malformed'],
    ['future-versioned', { v: 'v9', c: 'and', f: [] }, 'unsupported-version'],
    ['registry-invalid rows', { v: 'v1', c: 'and', f: [['nope', 'is_any_of', ['x']]] }, 'invalid'],
    ['structurally broken rows', { v: 'v1', c: 'and', f: [['kind']] }, 'invalid'],
  ] as const)(
    'a %s stored envelope resolves to the typed degraded state, never a crash',
    async (_label, envelope, reason) => {
      const t = await makeTeam();
      const created = await savedFiltersService.create(
        t.key,
        { name: `corrupt-${reason}-${_label.length}`, visibility: 'private', filterParam: param() },
        t.ownerCtx,
      );
      await corruptEnvelope(created.id, envelope);
      const resolved = await savedFiltersService.resolve(t.key, created.id, t.ownerCtx);
      expect(resolved.ast).toBeNull();
      expect(resolved.astError?.reason).toBe(reason);
      expect(resolved.filter).toMatchObject({ id: created.id, builtin: false });
    },
  );
});

describe('built-in defaults — resolve through the same reads, reject every write', () => {
  it('every builtin resolves to a registry-valid AST (totality over the set)', async () => {
    const t = await makeTeam();
    for (const def of BUILTIN_FILTERS) {
      const resolved = await savedFiltersService.resolve(
        t.key,
        builtinFilterId(def.slug),
        t.viewerCtx,
      );
      expect(resolved.astError).toBeNull();
      expect(resolved.ast).not.toBeNull();
      expect(resolved.filter).toMatchObject({ builtin: true, name: def.name });
      expect(resolved.capabilities).toMatchObject({
        canManage: false,
        canDelete: false,
        canChangeOwner: false,
      });
    }
  });

  it('"My open issues" pins the CURRENT user + the project’s done-category keys', async () => {
    const t = await makeTeam();
    const statuses = await workflowsRepository.findStatuses(t.fx.projectId, t.fx.workspaceId);
    const doneKeys = statuses.filter((s) => s.category === 'done').map((s) => s.key);
    expect(doneKeys.length).toBeGreaterThan(0);
    const resolved = await savedFiltersService.resolve(
      t.key,
      builtinFilterId('my-open-issues'),
      t.memberCtx,
    );
    expect(resolved.ast).toEqual({
      combinator: 'and',
      conditions: [
        { field: 'assignee', operator: 'is_any_of', value: [t.memberId] },
        { field: 'status', operator: 'is_none_of', value: doneKeys },
      ],
    });
    expect(
      (await savedFiltersService.resolve(t.key, builtinFilterId('all-issues'), t.memberCtx)).ast,
    ).toEqual({ combinator: 'and', conditions: [] });
  });

  it('builtins reject update / delete / star / dependents and unknown slugs read as 404', async () => {
    const t = await makeTeam();
    const id = builtinFilterId('reported-by-me');
    await expect(
      savedFiltersService.update(t.key, id, { name: 'renamed' }, t.ownerCtx),
    ).rejects.toThrow(BuiltinSavedFilterImmutableError);
    await expect(savedFiltersService.delete(t.key, id, t.ownerCtx)).rejects.toThrow(
      BuiltinSavedFilterImmutableError,
    );
    await expect(savedFiltersService.star(t.key, id, t.ownerCtx)).rejects.toThrow(
      BuiltinSavedFilterImmutableError,
    );
    await expect(savedFiltersService.getDependents(t.key, id, t.ownerCtx)).rejects.toThrow(
      BuiltinSavedFilterImmutableError,
    );
    await expect(
      savedFiltersService.resolve(t.key, builtinFilterId('no-such-builtin'), t.ownerCtx),
    ).rejects.toThrow(SavedFilterNotFoundError);
  });
});

describe('list reads — bounded, server-searched, cursor-paged (finding #57)', () => {
  it('pages a 55-filter project at the default 50 with a stable cursor + true total', async () => {
    const t = await makeTeam();
    for (let i = 1; i <= 55; i += 1) {
      await savedFiltersService.create(
        t.key,
        { name: `f-${String(i).padStart(3, '0')}`, visibility: 'project', filterParam: param() },
        t.memberCtx,
      );
    }
    const first = await savedFiltersService.list(t.key, {}, t.otherCtx);
    expect(first.items).toHaveLength(50);
    expect(first.total).toBe(55);
    expect(first.nextCursor).not.toBeNull();
    const second = await savedFiltersService.list(t.key, { cursor: first.nextCursor! }, t.otherCtx);
    expect(second.items).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    const seen = new Set([...first.items, ...second.items].map((f) => f.id));
    expect(seen.size).toBe(55);
    // Bounded explicitly too.
    const small = await savedFiltersService.list(t.key, { limit: 10 }, t.otherCtx);
    expect(small.items).toHaveLength(10);
  });

  it('searches server-side (case-insensitive substring) across rows AND builtins', async () => {
    const t = await makeTeam();
    await savedFiltersService.create(
      t.key,
      { name: 'Sprint Blockers', visibility: 'project', filterParam: param() },
      t.memberCtx,
    );
    await savedFiltersService.create(
      t.key,
      { name: 'Roadmap bets', visibility: 'project', filterParam: param() },
      t.memberCtx,
    );
    const page = await savedFiltersService.list(t.key, { q: 'BLOCK' }, t.otherCtx);
    expect(page.items.map((f) => f.name)).toEqual(['Sprint Blockers']);
    expect(page.total).toBe(1);
    const builtinHits = await savedFiltersService.list(t.key, { q: 'open' }, t.otherCtx);
    expect(builtinHits.builtins.map((b) => b.name).sort()).toEqual([
      'My open issues',
      'Open issues',
    ]);
  });

  it('slices by view: mine / project / starred (and only `all` carries builtins)', async () => {
    const t = await makeTeam();
    const mine = await savedFiltersService.create(
      t.key,
      { name: 'mine-private', visibility: 'private', filterParam: param() },
      t.memberCtx,
    );
    const shared = await savedFiltersService.create(
      t.key,
      { name: 'team-shared', visibility: 'project', filterParam: param() },
      t.otherCtx,
    );
    await savedFiltersService.star(t.key, shared.id, t.memberCtx);

    const mineView = await savedFiltersService.list(t.key, { view: 'mine' }, t.memberCtx);
    expect(mineView.items.map((f) => f.id)).toEqual([mine.id]);
    expect(mineView.builtins).toEqual([]);

    const projectView = await savedFiltersService.list(t.key, { view: 'project' }, t.memberCtx);
    expect(projectView.items.map((f) => f.id)).toEqual([shared.id]);

    const starredView = await savedFiltersService.list(t.key, { view: 'starred' }, t.memberCtx);
    expect(starredView.items.map((f) => f.id)).toEqual([shared.id]);
    expect(starredView.items[0]?.starredByMe).toBe(true);

    const all = await savedFiltersService.list(t.key, {}, t.memberCtx);
    expect(all.builtins).toHaveLength(BUILTIN_FILTERS.length);
  });
});

describe('stars — idempotent toggles, SQL-aggregated counts', () => {
  it('stars aggregate per filter and starredByMe tracks the actor', async () => {
    const t = await makeTeam();
    const shared = await savedFiltersService.create(
      t.key,
      { name: 'popular', visibility: 'project', filterParam: param() },
      t.memberCtx,
    );
    await savedFiltersService.star(t.key, shared.id, t.memberCtx);
    await savedFiltersService.star(t.key, shared.id, t.memberCtx); // idempotent
    const afterOther = await savedFiltersService.star(t.key, shared.id, t.otherCtx);
    expect(afterOther.starCount).toBe(2);
    expect(afterOther.starredByMe).toBe(true);

    const asViewer = await savedFiltersService.resolve(t.key, shared.id, t.viewerCtx);
    expect(asViewer.filter).toMatchObject({ starCount: 2, starredByMe: false });

    const unstarred = await savedFiltersService.unstar(t.key, shared.id, t.memberCtx);
    expect(unstarred.starCount).toBe(1);
    await savedFiltersService.unstar(t.key, shared.id, t.memberCtx); // idempotent no-op
  });

  it('a viewer stars what they can see; an invisible private filter is a 404', async () => {
    const t = await makeTeam();
    const shared = await savedFiltersService.create(
      t.key,
      { name: 'viewer-starrable', visibility: 'project', filterParam: param() },
      t.memberCtx,
    );
    const starred = await savedFiltersService.star(t.key, shared.id, t.viewerCtx);
    expect(starred.starredByMe).toBe(true);

    const secret = await savedFiltersService.create(
      t.key,
      { name: 'hidden', visibility: 'private', filterParam: param() },
      t.memberCtx,
    );
    await expect(savedFiltersService.star(t.key, secret.id, t.viewerCtx)).rejects.toThrow(
      SavedFilterNotFoundError,
    );
  });
});

describe('dependents + delete — the warning seam and the cascade', () => {
  it('enumerates dependents (subscriptions seam = 0 today) and cascades stars on delete', async () => {
    const t = await makeTeam();
    const doomed = await savedFiltersService.create(
      t.key,
      { name: 'doomed', visibility: 'project', filterParam: param() },
      t.memberCtx,
    );
    await savedFiltersService.star(t.key, doomed.id, t.otherCtx);
    expect(await savedFiltersService.getDependents(t.key, doomed.id, t.memberCtx)).toEqual({
      subscriptionCount: 0,
    });
    await savedFiltersService.delete(t.key, doomed.id, t.memberCtx);
    await expect(savedFiltersService.resolve(t.key, doomed.id, t.memberCtx)).rejects.toThrow(
      SavedFilterNotFoundError,
    );
    expect(await db.savedFilterStar.count({ where: { savedFilterId: doomed.id } })).toBe(0);
  });
});

describe('route transport — the HTTP layer enforces the same matrix', () => {
  const BASE = 'http://localhost:3000';

  function paramsFor<T>(value: T): { params: Promise<T> } {
    return { params: Promise.resolve(value) };
  }

  it('401s without a session; 400s a bad view; lists + creates through the wire', async () => {
    const t = await makeTeam();
    wsCtx.current = null;
    const unauthed = await listGET(
      new Request(`${BASE}/api/projects/${t.key}/saved-filters`),
      paramsFor({ key: t.key }),
    );
    expect(unauthed.status).toBe(401);

    wsCtx.current = t.memberCtx;
    const badView = await listGET(
      new Request(`${BASE}/api/projects/${t.key}/saved-filters?view=bogus`),
      paramsFor({ key: t.key }),
    );
    expect(badView.status).toBe(400);

    const created = await createPOST(
      new Request(`${BASE}/api/projects/${t.key}/saved-filters`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Wired', visibility: 'project', filter: param() }),
      }),
      paramsFor({ key: t.key }),
    );
    expect(created.status).toBe(201);
    const dupe = await createPOST(
      new Request(`${BASE}/api/projects/${t.key}/saved-filters`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'wired', visibility: 'private', filter: param() }),
      }),
      paramsFor({ key: t.key }),
    );
    expect(dupe.status).toBe(409);

    const listed = await listGET(
      new Request(`${BASE}/api/projects/${t.key}/saved-filters`),
      paramsFor({ key: t.key }),
    );
    expect(listed.status).toBe(200);
    const page = (await listed.json()) as { items: Array<{ name: string }>; builtins: unknown[] };
    expect(page.items.map((f) => f.name)).toContain('Wired');
    expect(page.builtins).toHaveLength(BUILTIN_FILTERS.length);
  });

  it('a private filter is a 404 to another user AT THE ROUTE LAYER (list + direct id)', async () => {
    const t = await makeTeam();
    const secret = await savedFiltersService.create(
      t.key,
      { name: 'route-secret', visibility: 'private', filterParam: param() },
      t.memberCtx,
    );

    wsCtx.current = t.otherCtx;
    const listed = await listGET(
      new Request(`${BASE}/api/projects/${t.key}/saved-filters`),
      paramsFor({ key: t.key }),
    );
    const page = (await listed.json()) as { items: Array<{ id: string }> };
    expect(page.items.map((f) => f.id)).not.toContain(secret.id);

    const direct = await resolveGET(
      new Request(`${BASE}/api/projects/${t.key}/saved-filters/${secret.id}`),
      paramsFor({ key: t.key, filterId: secret.id }),
    );
    expect(direct.status).toBe(404);

    wsCtx.current = t.memberCtx;
    const own = await resolveGET(
      new Request(`${BASE}/api/projects/${t.key}/saved-filters/${secret.id}`),
      paramsFor({ key: t.key, filterId: secret.id }),
    );
    expect(own.status).toBe(200);
    const resolved = (await own.json()) as { ast: unknown; capabilities: { canManage: boolean } };
    expect(resolved.ast).toEqual(SIMPLE_AST);
    expect(resolved.capabilities.canManage).toBe(true);
  });
});
