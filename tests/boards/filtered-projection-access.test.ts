import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { boardsService } from '@/lib/services/boardsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { FilterValidationError } from '@/lib/filters/errors';
import type { FilterAst } from '@/lib/filters/ast';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { WorkItemKind } from '@prisma/client';
import { createTestProject } from '../fixtures/projectFixtures';
import { truncateAuthTables } from '../helpers/db';

// boardsService.getBoard — the FILTERED board read's ACCESS + TENANT-SCOPE +
// typed-error edges (Story 6.15 · Subtask 6.15.4, the story-closing matrix).
//
// The happy-path filtered projection (predicate per column · cap-over-filtered ·
// unfiltered-unchanged · Scrum compose · work-type · saved-filter resolve +
// not-found) is proven by `filtered-projection.test.ts` (6.15.2); the access
// gate on the UNFILTERED board read is proven by `project-access-service.test.ts`
// (6.4.3). This file closes the two gaps those leave for the 6.15.4 matrix:
//
//   1. PERMISSION — the 6.4 browse gate runs BEFORE the filter resolves
//      (getBoard: assertCanBrowse, THEN resolveBoardFilter), so passing a filter
//      can never bypass it: a non-member of a private project is denied with a
//      filter exactly as without one.
//   2. TENANT SCOPE — the predicate is AND-ed WITHIN the project/workspace scope,
//      never widening it: a matching work item in another workspace's project
//      never leaks into this board's filtered read.
//   3. TYPED ERROR (inline path) — a structurally-valid but semantically-bad
//      inline AST (an unknown operator) is re-validated against the registry and
//      throws a typed `FilterValidationError` (the route's 422), the inline
//      analogue of 6.15.2's saved-filter `SavedFilterNotFoundError`.
//
// Real Postgres (no mocks), per CLAUDE.md; `createTestProject` auto-seeds the
// default kanban board.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

const PASSWORD = 'hunter2hunter2';

const kindAst = (...kinds: string[]): FilterAst => ({
  combinator: 'and',
  conditions: [{ field: 'kind', operator: 'is_any_of', value: kinds }],
});

interface Tenant {
  ctx: ServiceContext;
  workspaceId: string;
  projectId: string;
}

/** A fresh user + workspace + default-board project — one isolated tenant. */
async function makeTenant(email: string): Promise<Tenant> {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Board User' });
  const ws = await workspacesService.createWorkspace({ name: 'Board WS', ownerUserId: user.id });
  const ctx: ServiceContext = { userId: user.id, workspaceId: ws.workspace.id };
  const project = await createTestProject({ workspaceId: ws.workspace.id, actorUserId: user.id });
  return { ctx, workspaceId: ws.workspace.id, projectId: project.id };
}

/** Create a card of `kind` forced into `status` (the projection's grouping). */
async function card(t: Tenant, kind: WorkItemKind, status: string, title: string): Promise<void> {
  const item = await workItemsService.createWorkItem(
    { projectId: t.projectId, kind, title },
    t.ctx,
  );
  await db.workItem.update({ where: { id: item.id }, data: { status } });
}

describe('getBoard — filtered read: access, tenant scope, typed error (6.15.4)', () => {
  it('a filter cannot bypass the 6.4 browse gate — a non-member of a private project is denied', async () => {
    const owner = await makeTenant('filter-access-owner@example.com');
    await card(owner, 'bug', 'todo', 'Bug card');
    // Make the project private (the strictest gate); a non-member sees nothing.
    await db.project.update({ where: { id: owner.projectId }, data: { accessLevel: 'private' } });

    // An outsider: a real user who is NOT a member of the project's workspace.
    const outsider = await usersService.createUser({
      email: 'filter-access-outsider@example.com',
      password: PASSWORD,
      name: 'Outsider',
    });
    const outsiderCtx: ServiceContext = { userId: outsider.id, workspaceId: owner.workspaceId };

    // Denied WITHOUT a filter …
    await expect(boardsService.getBoard(owner.projectId, outsiderCtx)).rejects.toBeInstanceOf(
      ProjectAccessDeniedError,
    );
    // … and denied WITH one — the gate runs before the filter resolves, so a
    // filter never opens a back door into a hidden board.
    const denial = boardsService.getBoard(owner.projectId, outsiderCtx, undefined, {
      ast: kindAst('bug'),
    });
    await expect(denial).rejects.toBeInstanceOf(ProjectAccessDeniedError);
    await expect(denial).rejects.toMatchObject({ kind: 'browse' });

    // The owner, by contrast, gets the filtered board.
    const board = await boardsService.getBoard(owner.projectId, owner.ctx, undefined, {
      ast: kindAst('bug'),
    });
    expect(board.columns.flatMap((c) => c.cards.map((card) => card.title))).toEqual(['Bug card']);
  });

  it('the predicate is AND-ed within tenant scope — a matching item in another workspace never leaks', async () => {
    const a = await makeTenant('filter-scope-a@example.com');
    const b = await makeTenant('filter-scope-b@example.com');

    await card(a, 'bug', 'todo', 'A bug');
    // Workspace B has a bug too — same kind, different tenant. It must never
    // appear on A's board, filtered or not.
    await card(b, 'bug', 'todo', 'B bug');

    const board = await boardsService.getBoard(a.projectId, a.ctx, undefined, {
      ast: kindAst('bug'),
    });

    const titles = board.columns.flatMap((c) => c.cards.map((card) => card.title));
    expect(titles).toEqual(['A bug']);
    expect(titles).not.toContain('B bug');
    // The filtered total denominator is scoped too (no cross-tenant inflation).
    const todo = board.columns.find((c) => c.statusKeys.includes('todo'))!;
    expect(todo.totalCount).toBe(1);
  });

  it('a structurally-valid but semantically-bad inline AST throws a typed FilterValidationError', async () => {
    const t = await makeTenant('filter-validation@example.com');
    await card(t, 'bug', 'todo', 'Bug card');

    // A known field with an operator that is not in the registry — the inline
    // path re-validates the AST (resolveBoardFilter → resolveFilterAst), so this
    // is the 422 the route maps, not a silent "no filter" degrade.
    const badAst = {
      combinator: 'and',
      conditions: [{ field: 'kind', operator: 'not_a_real_operator', value: ['bug'] }],
    } as unknown as FilterAst;

    await expect(
      boardsService.getBoard(t.projectId, t.ctx, undefined, { ast: badAst }),
    ).rejects.toBeInstanceOf(FilterValidationError);
  });
});
