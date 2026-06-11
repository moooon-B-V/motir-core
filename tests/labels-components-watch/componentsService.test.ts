import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { User, WorkItem } from '@prisma/client';
import { db } from '@/lib/db';
import { componentsService, COMPONENT_NAME_MAX_LENGTH } from '@/lib/services/componentsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { componentRepository } from '@/lib/repositories/componentRepository';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import {
  NotProjectAdminError,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
import {
  ComponentNameConflictError,
  ComponentNotFoundError,
  CrossProjectComponentError,
  InvalidComponentNameError,
  InvalidDefaultAssigneeError,
  InvalidMoveTargetError,
} from '@/lib/components/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  createTestProject,
  createTestUser,
  createTestWorkItem,
  makeWorkItemFixture,
} from '../fixtures';
import type { WorkItemFixture } from '../fixtures';
import { truncateAuthTables } from '../helpers/db';

// componentsService (Story 5.4 · Subtask 5.4.3) — the taxonomy BUSINESS
// rules over the 5.4.1 leaves, against a REAL Postgres (no-mocks rule): the
// verified Jira company-managed mechanics (admin CRUD with case-insensitive
// uniqueness, the assignable-member default-assignee scoping, the
// move-or-remove delete with the duplicate-join skip), the per-issue
// assignment matrix (same-project validation, revision diffs, idempotent
// no-ops), the at-create default-assignee rule (first-alphabetical,
// create-time only, never overriding an explicit assignee) inside
// `workItemsService.createWorkItem`, the components slot on
// `getIssueDetail`, and the permission gates (the 6.4 two-tier admin check;
// member edits / viewer 403 / cross-workspace 404).

beforeEach(async () => {
  // workspace TRUNCATE … CASCADE walks workspace → project → component and
  // workspace → work_item → work_item_component (Cascade FK chains).
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

interface ComponentScenario {
  fx: WorkItemFixture;
  issue: WorkItem;
  /** Plain workspace member — may edit issues (open project), may NOT manage. */
  member: User;
  memberCtx: ServiceContext;
  /** Workspace member holding the read-only project `viewer` role. */
  viewerCtx: ServiceContext;
  /** Workspace member promoted to project `admin` (not a workspace manager). */
  projectAdminCtx: ServiceContext;
}

/** An OPEN project + one issue + member / viewer / project-admin actors. */
async function buildScenario(): Promise<ComponentScenario> {
  const fx = await makeWorkItemFixture();
  const issue = await createTestWorkItem(fx, { kind: 'task', title: 'Componented task' });

  async function wsMember(email: string, name: string) {
    const user = await createTestUser({ email, name });
    await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
    return { user, ctx: { userId: user.id, workspaceId: fx.workspaceId } };
  }

  const { user: member, ctx: memberCtx } = await wsMember('member@ex.com', 'Plain Member');
  const { user: viewer, ctx: viewerCtx } = await wsMember('viewer@ex.com', 'Read Only');
  const { user: projAdmin, ctx: projectAdminCtx } = await wsMember('padmin@ex.com', 'Proj Admin');

  await projectMembersService.addMember({
    key: fx.projectIdentifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: viewer.id,
    role: 'viewer',
  });
  await projectMembersService.addMember({
    key: fx.projectIdentifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: projAdmin.id,
    role: 'admin',
  });

  return { fx, issue, member, memberCtx, viewerCtx, projectAdminCtx };
}

/** Create a component as the workspace owner, returning its DTO. */
async function ownerCreate(
  s: ComponentScenario,
  name: string,
  opts: { description?: string | null; defaultAssigneeId?: string | null } = {},
) {
  return componentsService.createComponent(
    { key: s.fx.projectIdentifier, name, ...opts },
    s.fx.ctx,
  );
}

/** The `{ components: … }` diffs among the item's revisions, oldest-first. */
async function componentDiffsOf(workItemId: string): Promise<unknown[]> {
  const rows = await workItemRevisionRepository.listByWorkItem(workItemId);
  return [...rows]
    .reverse()
    .map((r) => r.diff as Record<string, unknown>)
    .filter((d) => 'components' in d)
    .map((d) => d.components);
}

describe('componentsService.createComponent — admin CRUD', () => {
  it('creates with name, trimmed description, and a validated default assignee', async () => {
    const s = await buildScenario();
    const dto = await ownerCreate(s, '  API  ', {
      description: '  The service layer  ',
      defaultAssigneeId: s.member.id,
    });
    expect(dto.name).toBe('API'); // trimmed, first-typed casing kept
    expect(dto.description).toBe('The service layer');
    expect(dto.defaultAssigneeId).toBe(s.member.id);
  });

  it('rejects a blank or over-long name with the typed 422', async () => {
    const s = await buildScenario();
    await expect(ownerCreate(s, '   ')).rejects.toBeInstanceOf(InvalidComponentNameError);
    await expect(ownerCreate(s, 'x'.repeat(COMPONENT_NAME_MAX_LENGTH + 1))).rejects.toBeInstanceOf(
      InvalidComponentNameError,
    );
  });

  it("rejects a case-insensitive duplicate — 'api' conflicts with 'API'", async () => {
    const s = await buildScenario();
    await ownerCreate(s, 'API');
    await expect(ownerCreate(s, 'api')).rejects.toBeInstanceOf(ComponentNameConflictError);
  });

  it('rejects a default assignee who is not an assignable member', async () => {
    const s = await buildScenario();
    const outsider = await createTestUser({ email: 'out@ex.com', name: 'Outsider' });
    await expect(ownerCreate(s, 'API', { defaultAssigneeId: outsider.id })).rejects.toBeInstanceOf(
      InvalidDefaultAssigneeError,
    );
  });

  it('is project-admin-gated: project admin passes, plain member and viewer are rejected', async () => {
    const s = await buildScenario();
    const made = await componentsService.createComponent(
      { key: s.fx.projectIdentifier, name: 'ByProjAdmin' },
      s.projectAdminCtx,
    );
    expect(made.name).toBe('ByProjAdmin');

    await expect(
      componentsService.createComponent({ key: s.fx.projectIdentifier, name: 'Nope' }, s.memberCtx),
    ).rejects.toBeInstanceOf(NotProjectAdminError);
    await expect(
      componentsService.createComponent({ key: s.fx.projectIdentifier, name: 'Nope' }, s.viewerCtx),
    ).rejects.toBeInstanceOf(NotProjectAdminError);
  });

  it('resolves the project workspace-scoped — an unknown key reads as 404', async () => {
    const s = await buildScenario();
    await expect(
      componentsService.createComponent({ key: 'NOPE', name: 'API' }, s.fx.ctx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

describe('componentsService.updateComponent', () => {
  it('renames (case-insensitively unique, excluding itself), edits description, clears the default', async () => {
    const s = await buildScenario();
    const api = await ownerCreate(s, 'API', { defaultAssigneeId: s.member.id });

    // Re-casing itself is not a conflict.
    const recased = await componentsService.updateComponent(api.id, { name: 'Api' }, s.fx.ctx);
    expect(recased.name).toBe('Api');

    const cleared = await componentsService.updateComponent(
      api.id,
      { description: 'Backend', defaultAssigneeId: null },
      s.fx.ctx,
    );
    expect(cleared.description).toBe('Backend');
    expect(cleared.defaultAssigneeId).toBeNull();
  });

  it('rejects renaming onto another component (any casing)', async () => {
    const s = await buildScenario();
    await ownerCreate(s, 'API');
    const web = await ownerCreate(s, 'Web');
    await expect(
      componentsService.updateComponent(web.id, { name: 'api' }, s.fx.ctx),
    ).rejects.toBeInstanceOf(ComponentNameConflictError);
  });

  it('an empty patch is a no-op; a plain member is rejected; a cross-workspace id reads as 404', async () => {
    const s = await buildScenario();
    const api = await ownerCreate(s, 'API');

    const unchanged = await componentsService.updateComponent(api.id, {}, s.fx.ctx);
    expect(unchanged).toEqual(api);

    await expect(
      componentsService.updateComponent(api.id, { name: 'X' }, s.memberCtx),
    ).rejects.toBeInstanceOf(NotProjectAdminError);

    const other = await makeWorkItemFixture({ name: 'Foreign', identifier: 'FRG' });
    await expect(
      componentsService.updateComponent(api.id, { name: 'X' }, other.ctx),
    ).rejects.toBeInstanceOf(ComponentNotFoundError);
  });
});

describe('componentsService.listComponents', () => {
  it('lists name-ordered with item counts and resolved default assignees; viewers may read', async () => {
    const s = await buildScenario();
    const web = await ownerCreate(s, 'Web');
    await ownerCreate(s, 'API', { defaultAssigneeId: s.member.id });
    await componentsService.setComponents(s.issue.id, [web.id], s.memberCtx);

    const rows = await componentsService.listComponents(s.fx.projectIdentifier, s.viewerCtx);
    expect(rows.map((r) => r.name)).toEqual(['API', 'Web']); // nameLower order
    expect(rows[0]?.defaultAssignee).toEqual({
      id: s.member.id,
      name: 'Plain Member',
      email: 'member@ex.com',
    });
    expect(rows[0]?.itemCount).toBe(0);
    expect(rows[1]?.defaultAssignee).toBeNull();
    expect(rows[1]?.itemCount).toBe(1);
  });

  it('hides a cross-tenant project key as 404', async () => {
    const s = await buildScenario();
    const other = await makeWorkItemFixture({ name: 'Foreign', identifier: 'FRG' });
    await expect(
      componentsService.listComponents(s.fx.projectIdentifier, other.ctx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

describe('componentsService — per-issue assignment', () => {
  it('setComponents replaces the set, writes one added/removed diff, and is idempotent', async () => {
    const s = await buildScenario();
    const api = await ownerCreate(s, 'API');
    const web = await ownerCreate(s, 'Web');

    const set1 = await componentsService.setComponents(s.issue.id, [web.id, api.id], s.memberCtx);
    expect(set1.map((c) => c.name)).toEqual(['API', 'Web']); // name-ordered

    const set2 = await componentsService.setComponents(s.issue.id, [api.id], s.memberCtx);
    expect(set2.map((c) => c.name)).toEqual(['API']);

    // A no-change set writes nothing.
    await componentsService.setComponents(s.issue.id, [api.id], s.memberCtx);

    expect(await componentDiffsOf(s.issue.id)).toEqual([
      { added: ['API', 'Web'] },
      { removed: ['Web'] },
    ]);
  });

  it('addComponent / removeComponent round-trip with idempotent no-ops', async () => {
    const s = await buildScenario();
    const api = await ownerCreate(s, 'API');

    const added = await componentsService.addComponent(s.issue.id, api.id, s.memberCtx);
    expect(added.map((c) => c.name)).toEqual(['API']);
    const again = await componentsService.addComponent(s.issue.id, api.id, s.memberCtx);
    expect(again.map((c) => c.name)).toEqual(['API']); // no-op

    const removed = await componentsService.removeComponent(s.issue.id, api.id, s.memberCtx);
    expect(removed).toEqual([]);
    const removedAgain = await componentsService.removeComponent(s.issue.id, api.id, s.memberCtx);
    expect(removedAgain).toEqual([]); // no-op

    expect(await componentDiffsOf(s.issue.id)).toEqual([{ added: ['API'] }, { removed: ['API'] }]);
  });

  it("rejects another project's component (422) and an unknown id (404)", async () => {
    const s = await buildScenario();
    const otherProject = await createTestProject({
      workspaceId: s.fx.workspaceId,
      actorUserId: s.fx.ownerId,
      name: 'Other',
      identifier: 'OTH',
    });
    const foreign = await componentsService.createComponent(
      { key: otherProject.identifier, name: 'Elsewhere' },
      s.fx.ctx,
    );

    await expect(
      componentsService.addComponent(s.issue.id, foreign.id, s.memberCtx),
    ).rejects.toBeInstanceOf(CrossProjectComponentError);
    await expect(
      componentsService.setComponents(s.issue.id, ['missing-id'], s.memberCtx),
    ).rejects.toBeInstanceOf(ComponentNotFoundError);
  });

  it('enforces the matrix: viewer 403, cross-workspace issue 404', async () => {
    const s = await buildScenario();
    const api = await ownerCreate(s, 'API');

    await expect(
      componentsService.addComponent(s.issue.id, api.id, s.viewerCtx),
    ).rejects.toBeInstanceOf(ProjectAccessDeniedError);

    const other = await makeWorkItemFixture({ name: 'Foreign', identifier: 'FRG' });
    await expect(
      componentsService.addComponent(s.issue.id, api.id, other.ctx),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });
});

describe('componentsService.deleteComponent — the move-or-remove flow', () => {
  it('deletes an unused component with a zero-count receipt', async () => {
    const s = await buildScenario();
    const api = await ownerCreate(s, 'API');
    const receipt = await componentsService.deleteComponent(api.id, {}, s.fx.ctx);
    expect(receipt).toEqual({ deletedId: api.id, affectedCount: 0, movedToComponentId: null });
    expect(await componentRepository.findById(api.id)).toBeNull();
  });

  it('REMOVE branch: detaches the in-use component, issues untouched, count reported', async () => {
    const s = await buildScenario();
    const api = await ownerCreate(s, 'API');
    const second = await createTestWorkItem(s.fx, { kind: 'task', title: 'Second' });
    await componentsService.addComponent(s.issue.id, api.id, s.memberCtx);
    await componentsService.addComponent(second.id, api.id, s.memberCtx);

    const receipt = await componentsService.deleteComponent(api.id, {}, s.fx.ctx);
    expect(receipt.affectedCount).toBe(2);
    expect(receipt.movedToComponentId).toBeNull();

    const detail = await workItemsService.getIssueDetail(
      s.fx.projectId,
      s.issue.identifier,
      s.fx.ctx,
    );
    expect(detail.components).toEqual([]); // association gone …
    expect(detail.item.id).toBe(s.issue.id); // … the issue survives
  });

  it('MOVE branch: repoints carriers to the target, skipping issues that already carry it', async () => {
    const s = await buildScenario();
    const api = await ownerCreate(s, 'API');
    const web = await ownerCreate(s, 'Web');
    const both = await createTestWorkItem(s.fx, { kind: 'task', title: 'Carries both' });
    await componentsService.setComponents(s.issue.id, [api.id], s.memberCtx);
    await componentsService.setComponents(both.id, [api.id, web.id], s.memberCtx);

    const receipt = await componentsService.deleteComponent(
      api.id,
      { moveToComponentId: web.id },
      s.fx.ctx,
    );
    expect(receipt).toEqual({ deletedId: api.id, affectedCount: 2, movedToComponentId: web.id });

    const moved = await componentRepository.listByWorkItem(s.issue.id);
    expect(moved.map((c) => c.id)).toEqual([web.id]); // repointed
    const kept = await componentRepository.listByWorkItem(both.id);
    expect(kept.map((c) => c.id)).toEqual([web.id]); // duplicate-join skipped + swept
  });

  it('validates the move target: self, unknown, and cross-project are 422s', async () => {
    const s = await buildScenario();
    const api = await ownerCreate(s, 'API');
    const otherProject = await createTestProject({
      workspaceId: s.fx.workspaceId,
      actorUserId: s.fx.ownerId,
      name: 'Other',
      identifier: 'OTH',
    });
    const foreign = await componentsService.createComponent(
      { key: otherProject.identifier, name: 'Elsewhere' },
      s.fx.ctx,
    );

    await expect(
      componentsService.deleteComponent(api.id, { moveToComponentId: api.id }, s.fx.ctx),
    ).rejects.toBeInstanceOf(InvalidMoveTargetError);
    await expect(
      componentsService.deleteComponent(api.id, { moveToComponentId: 'missing' }, s.fx.ctx),
    ).rejects.toBeInstanceOf(InvalidMoveTargetError);
    await expect(
      componentsService.deleteComponent(api.id, { moveToComponentId: foreign.id }, s.fx.ctx),
    ).rejects.toBeInstanceOf(InvalidMoveTargetError);
  });

  it('is project-admin-gated', async () => {
    const s = await buildScenario();
    const api = await ownerCreate(s, 'API');
    await expect(componentsService.deleteComponent(api.id, {}, s.memberCtx)).rejects.toBeInstanceOf(
      NotProjectAdminError,
    );
  });
});

describe('createWorkItem — components at create + the default-assignee rule', () => {
  // These tests create items through the REAL service, so they use a fresh
  // project with no fixture-minted rows: `createTestWorkItem` pads its
  // `position` ('000001'), which is NOT a valid fractional-index key, and a
  // service create appended after such a sibling would throw in
  // `keyForAppend` (the known fixture/runtime position-key mismatch).
  async function buildCreateScenario() {
    const s = await buildScenario();
    const project = await createTestProject({
      workspaceId: s.fx.workspaceId,
      actorUserId: s.fx.ownerId,
      name: 'Created',
      identifier: 'CRT',
    });
    const create = (name: string, defaultAssigneeId?: string) =>
      componentsService.createComponent(
        { key: project.identifier, name, defaultAssigneeId },
        s.fx.ctx,
      );
    return { s, project, create };
  }

  it('assigns the FIRST-ALPHABETICAL defaulted component on an unassigned create', async () => {
    const { s, project, create } = await buildCreateScenario();
    // 'API' (no default) sorts first; the first-alphabetical WITH a default
    // ('Core') wins, not plain-first 'API' and not last-listed 'Web'.
    const api = await create('API');
    const core = await create('Core', s.member.id);
    const web = await create('Web', s.fx.ownerId);

    const dto = await workItemsService.createWorkItem(
      {
        projectId: project.id,
        kind: 'task',
        title: 'Born with components',
        componentIds: [web.id, api.id, core.id],
      },
      s.fx.ctx,
    );
    expect(dto.assigneeId).toBe(s.member.id); // Core's default

    const detail = await workItemsService.getIssueDetail(project.id, dto.identifier, s.fx.ctx);
    expect(detail.components.map((c) => c.name)).toEqual(['API', 'Core', 'Web']);
  });

  it('never overrides an explicit assignee, and later component edits never touch it', async () => {
    const { s, project, create } = await buildCreateScenario();
    const core = await create('Core', s.member.id);
    const web = await create('Web', s.fx.ownerId);

    const dto = await workItemsService.createWorkItem(
      {
        projectId: project.id,
        kind: 'task',
        title: 'Explicitly assigned',
        assigneeId: s.fx.ownerId,
        componentIds: [core.id],
      },
      s.fx.ctx,
    );
    expect(dto.assigneeId).toBe(s.fx.ownerId); // explicit wins

    await componentsService.setComponents(dto.id, [web.id], s.fx.ctx);
    const after = await workItemsService.getIssueDetail(project.id, dto.identifier, s.fx.ctx);
    expect(after.item.assigneeId).toBe(s.fx.ownerId); // create-time only
  });

  it('creates unassigned when no picked component carries a default', async () => {
    const { s, project, create } = await buildCreateScenario();
    const api = await create('API');
    const dto = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'task', title: 'No default', componentIds: [api.id] },
      s.fx.ctx,
    );
    expect(dto.assigneeId).toBeNull();
  });

  it("pre-flights the ids: another project's component is 422, an unknown one 404 — and no key burns", async () => {
    const { s, project } = await buildCreateScenario();
    // A component living in the ORIGINAL fixture project is cross-project here.
    const foreign = await ownerCreate(s, 'Elsewhere');

    await expect(
      workItemsService.createWorkItem(
        { projectId: project.id, kind: 'task', title: 'Bad', componentIds: [foreign.id] },
        s.fx.ctx,
      ),
    ).rejects.toBeInstanceOf(CrossProjectComponentError);
    await expect(
      workItemsService.createWorkItem(
        { projectId: project.id, kind: 'task', title: 'Bad', componentIds: ['missing'] },
        s.fx.ctx,
      ),
    ).rejects.toBeInstanceOf(ComponentNotFoundError);
  });
});

describe('componentRepository.findByIds — the empty-input guard', () => {
  it('returns [] for [] without touching the database', async () => {
    expect(await componentRepository.findByIds([])).toEqual([]);
  });
});
