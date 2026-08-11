import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { readProject, readProjectByIdentifier, readWorkItem } from '@/lib/workspaces/tenantRead';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The three tenant-table readers, proved RETURNING under the non-bypass role
// (MOTIR-2569 · `docs/rls-runtime-role-inventory.md` Finding 4).
//
// `project` and `work_item` carry workspace-keyed RLS policies of their own
// (`project_workspace_or_system_read`, `work_item_active_workspace`), both keyed on the
// per-TRANSACTION `app.workspace_id` GUC. A service that opened with a `db`-singleton
// `findById` bound nothing, so the row was invisible and the method threw
// `ProjectNotFoundError` / `WorkItemNotFoundError` before any access gate ran. Same
// shape as MOTIR-2527's membership gate, one layer down — and invisible until that one
// was fixed, because the gate was the first unbound read on every path.
//
// ⚠️ THE RETURN ASSERTIONS ARE THE POINT. A reader that finds NOTHING passes every
// "a foreign tenant is not visible" test ever written — that is precisely the defect
// this file exists to catch, wearing the costume of a security property. So each reader
// is asserted in both directions and the RETURN direction comes first.
//
// Like `membershipGate.test.ts`, these run in BOTH modes: with `TEST_DB_APP_ROLE=1`
// they are the proof, with the flag unset (what CI runs today) they are the regression
// guard. Every assertion below holds identically in both — a mode-split expectation
// here would re-open the hole MOTIR-2569 closed.
//
// The fixture writes through `adminDb` (the owner): it seeds two tenants, which is
// exactly what the policies forbid, and the readers under test go through `@/lib/db`.

interface Tenant {
  ownerId: string;
  workspaceId: string;
  organizationId: string;
  projectId: string;
  projectIdentifier: string;
  workItemId: string;
}

let home: Tenant;
let neighbour: Tenant;

beforeEach(async () => {
  await truncateAuthTables();
  home = await seedTenant('home', 'HOME');
  neighbour = await seedTenant('nbr', 'NBR');
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('readProject', () => {
  it('RETURNS the project of the bound workspace', async () => {
    const project = await readProject(home.projectId, ctxFor(home));
    expect(project?.id).toBe(home.projectId);
  });

  it('does not return another workspace’s project', async () => {
    const project = await readProject(neighbour.projectId, ctxFor(home));
    // Under the app role RLS hides it; under the owner role it comes back and the
    // CALLER's `workspaceId` check refuses it. Both are correct, and both are why the
    // service-level check must stay — assert on the tenant, not on null.
    expect(project?.workspaceId).not.toBe(home.workspaceId);
  });

  it('reuses a caller transaction that already binds the context', async () => {
    const project = await withWorkspaceContext(ctxFor(home), (tx) =>
      readProject(home.projectId, ctxFor(home), tx),
    );
    expect(project?.id).toBe(home.projectId);
  });
});

describe('readProjectByIdentifier', () => {
  it('RETURNS the project by its workspace-unique key', async () => {
    const project = await readProjectByIdentifier(home.projectIdentifier, ctxFor(home));
    expect(project?.id).toBe(home.projectId);
  });

  it('is scoped by the CONTEXT, so a key that exists elsewhere resolves to nothing', async () => {
    // Both tenants can hold the same key — it is unique per workspace, not globally.
    // The lookup is keyed on (workspaceId, identifier), so it is the context that
    // decides which one is meant, whether or not RLS is live.
    const project = await readProjectByIdentifier(neighbour.projectIdentifier, ctxFor(home));
    expect(project).toBeNull();
  });
});

describe('readWorkItem', () => {
  it('RETURNS the item of the bound workspace', async () => {
    const item = await readWorkItem(home.workItemId, ctxFor(home));
    expect(item?.id).toBe(home.workItemId);
  });

  it('does not return another workspace’s item', async () => {
    const item = await readWorkItem(neighbour.workItemId, ctxFor(home));
    expect(item?.workspaceId).not.toBe(home.workspaceId);
  });

  it('sees an item in ANY of the workspace’s projects, not just an active one', async () => {
    // `withWorkspaceContext` binds `app.project_id` to the empty string when no project
    // is given, which is what the restrictive `work_item_project_narrow` policy's
    // `coalesce(...) = ''` branch wants. These callers resolve an item BEFORE they know
    // its project, so a narrowed bind would hide the very row they are about to gate.
    const second = await seedProject(home, 'HOME2');
    const item = await adminDb.workItem.create({
      data: {
        workspaceId: home.workspaceId,
        projectId: second.id,
        kind: 'task',
        identifier: 'HOME2-1',
        key: 1,
        title: 'In the other project',
        reporterId: home.ownerId,
        position: 'a0',
        backlogRank: 'a0',
      },
    });
    const read = await readWorkItem(item.id, ctxFor(home));
    expect(read?.id).toBe(item.id);
  });
});

function ctxFor(t: Tenant) {
  return { userId: t.ownerId, workspaceId: t.workspaceId };
}

async function seedProject(t: { workspaceId: string }, identifier: string) {
  return adminDb.project.create({
    data: {
      workspaceId: t.workspaceId,
      name: `Project ${identifier}`,
      slug: identifier.toLowerCase(),
      identifier,
    },
  });
}

/** The full tenant root chain the app builds at signup, plus one project and one item. */
async function seedTenant(tag: string, identifier: string): Promise<Tenant> {
  const owner = await adminDb.user.create({
    data: { email: `${tag}-owner@example.com`, name: `${tag} owner` },
  });
  const organization = await adminDb.organization.create({
    data: { name: `Org ${tag}`, slug: `org-${tag}` },
  });
  await adminDb.organizationMembership.create({
    data: { organizationId: organization.id, userId: owner.id, role: 'owner' },
  });
  const workspace = await adminDb.workspace.create({
    data: { name: `Workspace ${tag}`, slug: `ws-${tag}`, organizationId: organization.id },
  });
  await adminDb.workspaceMembership.create({
    data: { userId: owner.id, workspaceId: workspace.id, role: 'owner' },
  });
  const project = await seedProject({ workspaceId: workspace.id }, identifier);
  const workItem = await adminDb.workItem.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      kind: 'task',
      identifier: `${identifier}-1`,
      key: 1,
      title: `${tag} item`,
      reporterId: owner.id,
      position: 'a0',
      backlogRank: 'a0',
    },
  });
  return {
    ownerId: owner.id,
    workspaceId: workspace.id,
    organizationId: organization.id,
    projectId: project.id,
    projectIdentifier: identifier,
    workItemId: workItem.id,
  };
}
