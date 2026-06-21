import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { resolveAliasedIssueKey } from '@/lib/issues/aliasRedirect';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { truncateAuthTables } from './helpers/db';

// Subtask 6.8.2 — the READ half of the project-key-alias feature: alias-aware
// central resolution (projectsService.resolveByKey + getByKey delegation), the
// `/items/[key]` 308-redirect helper (resolveAliasedIssueKey), and old-key
// serving on the route-backing services (projectMembersService). Real Postgres,
// no DB mocks; the truncate helper CASCADEs workspace → project → work_item /
// project_key_alias between tests. The atomic rename TX itself is 6.8.1's
// surface (project-details-service.test.ts) — here we only exercise resolution.

const PASSWORD = 'hunter2hunter2';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeUser(email: string, name = 'User') {
  return usersService.createUser({ email, password: PASSWORD, name });
}

// An owner + workspace + project keyed PROD (the owner is the workspace OWNER,
// so they browse/manage the project via the workspace-manager tier).
async function makeFixture(slug: string, identifier = 'PROD') {
  const owner = await makeUser(`owner-${slug}@example.com`, 'Owner');
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${slug}`,
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: `Project ${slug}`,
    identifier,
  });
  const ownerCtx: WorkspaceContext = { userId: owner.id, workspaceId: workspace.id };
  return { owner, workspace, project, ownerCtx };
}

async function seedItems(projectId: string, ctx: WorkspaceContext, n: number) {
  const items: { identifier: string; key: number }[] = [];
  for (let i = 0; i < n; i++) {
    const dto = await workItemsService.createWorkItem(
      { projectId, kind: 'task', title: `Item ${i}` },
      ctx,
    );
    items.push({ identifier: dto.identifier, key: dto.key });
  }
  return items;
}

describe('projectsService.resolveByKey', () => {
  it('resolves the LIVE identifier with viaAlias=false', async () => {
    const { project, ownerCtx } = await makeFixture('live');
    const { project: resolved, viaAlias } = await projectsService.resolveByKey('PROD', ownerCtx);
    expect(viaAlias).toBe(false);
    expect(resolved.id).toBe(project.id);
    expect(resolved.identifier).toBe('PROD');
  });

  it('is case-insensitive on the live key', async () => {
    const { project, ownerCtx } = await makeFixture('case');
    const { project: resolved, viaAlias } = await projectsService.resolveByKey('prod', ownerCtx);
    expect(viaAlias).toBe(false);
    expect(resolved.id).toBe(project.id);
  });

  it('resolves a RETIRED key via the alias table with viaAlias=true, canonical identifier', async () => {
    const { project, ownerCtx } = await makeFixture('alias');
    await projectsService.changeKey({ key: 'PROD', newKey: 'NIF', ctx: ownerCtx });

    const { project: resolved, viaAlias } = await projectsService.resolveByKey('PROD', ownerCtx);
    expect(viaAlias).toBe(true);
    expect(resolved.id).toBe(project.id);
    expect(resolved.identifier).toBe('NIF'); // the DTO carries the CANONICAL key
  });

  it('throws ProjectNotFoundError for a key that never existed', async () => {
    const { ownerCtx } = await makeFixture('never');
    await expect(projectsService.resolveByKey('ZZZ', ownerCtx)).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
  });

  it('throws ProjectNotFoundError once an alias is RELEASED (the key is freed)', async () => {
    const { ownerCtx } = await makeFixture('release');
    await projectsService.changeKey({ key: 'PROD', newKey: 'NIF', ctx: ownerCtx });
    // sanity: it resolves before release
    expect((await projectsService.resolveByKey('PROD', ownerCtx)).viaAlias).toBe(true);

    await projectsService.releaseAlias({ key: 'NIF', alias: 'PROD', ctx: ownerCtx });
    await expect(projectsService.resolveByKey('PROD', ownerCtx)).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
  });

  it('resolves chained renames FLAT — every retired key maps directly to the project', async () => {
    const { project, ownerCtx } = await makeFixture('chain');
    await projectsService.changeKey({ key: 'PROD', newKey: 'NIF', ctx: ownerCtx });
    await projectsService.changeKey({ key: 'NIF', newKey: 'ZAP', ctx: ownerCtx });

    for (const oldKey of ['PROD', 'NIF']) {
      const { project: resolved, viaAlias } = await projectsService.resolveByKey(oldKey, ownerCtx);
      expect(viaAlias).toBe(true);
      expect(resolved.id).toBe(project.id);
      expect(resolved.identifier).toBe('ZAP'); // flat: no chain-walking
    }
    expect((await projectsService.resolveByKey('ZAP', ownerCtx)).viaAlias).toBe(false);
  });

  it('does not leak a key living in ANOTHER workspace', async () => {
    const a = await makeFixture('leak-a', 'AAA');
    // A second workspace owns BBB; resolving BBB from workspace A is a 404.
    await makeFixture('leak-b', 'BBB');
    await expect(projectsService.resolveByKey('BBB', a.ownerCtx)).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
  });
});

describe('projectsService.getByKey (delegates to resolveByKey — serves old keys)', () => {
  it('serves a retired key identically to the live key, with the canonical DTO', async () => {
    const { ownerCtx } = await makeFixture('getbykey');
    await projectsService.changeKey({ key: 'PROD', newKey: 'NIF', ctx: ownerCtx });

    const viaOld = await projectsService.getByKey('PROD', ownerCtx);
    const viaNew = await projectsService.getByKey('NIF', ownerCtx);
    expect(viaOld).toEqual(viaNew);
    expect(viaOld.identifier).toBe('NIF');
  });
});

describe('route-backing services serve old keys (one resolution path)', () => {
  it('projectMembersService.getAccess + listMembers serve the old key identically to the new', async () => {
    const { ownerCtx } = await makeFixture('members');
    await projectsService.changeKey({ key: 'PROD', newKey: 'NIF', ctx: ownerCtx });
    const actorUserId = ownerCtx.userId;

    const accessOld = await projectMembersService.getAccess({
      key: 'PROD',
      actorUserId,
      ctx: ownerCtx,
    });
    const accessNew = await projectMembersService.getAccess({
      key: 'NIF',
      actorUserId,
      ctx: ownerCtx,
    });
    expect(accessOld).toEqual(accessNew);

    const membersOld = await projectMembersService.listMembers({
      key: 'PROD',
      actorUserId,
      ctx: ownerCtx,
    });
    const membersNew = await projectMembersService.listMembers({
      key: 'NIF',
      actorUserId,
      ctx: ownerCtx,
    });
    expect(membersOld).toEqual(membersNew);
  });
});

describe('resolveAliasedIssueKey (the /items/[key] 308-redirect helper)', () => {
  it('maps an old-key issue identifier to its canonical after a rename', async () => {
    const { project, ownerCtx } = await makeFixture('redir');
    const [first] = await seedItems(project.id, ownerCtx, 1); // PROD-1
    expect(first?.identifier).toBe('PROD-1');
    await projectsService.changeKey({ key: 'PROD', newKey: 'NIF', ctx: ownerCtx });

    const canonical = await resolveAliasedIssueKey(first!.identifier, ownerCtx);
    expect(canonical).toBe('NIF-1'); // the NUMBER is preserved
  });

  it('returns null for a LIVE key (genuine 404, no redirect, no loop)', async () => {
    const { project, ownerCtx } = await makeFixture('live-miss');
    await seedItems(project.id, ownerCtx, 1);
    // PROD-999 exists under the live key but as no issue → 404, never a redirect.
    expect(await resolveAliasedIssueKey('PROD-999', ownerCtx)).toBeNull();
  });

  it('returns null for a never-existed prefix and for a released alias', async () => {
    const { project, ownerCtx } = await makeFixture('null-cases');
    await seedItems(project.id, ownerCtx, 1);
    expect(await resolveAliasedIssueKey('ZZZ-1', ownerCtx)).toBeNull();

    await projectsService.changeKey({ key: 'PROD', newKey: 'NIF', ctx: ownerCtx });
    expect(await resolveAliasedIssueKey('PROD-1', ownerCtx)).toBe('NIF-1');
    await projectsService.releaseAlias({ key: 'NIF', alias: 'PROD', ctx: ownerCtx });
    expect(await resolveAliasedIssueKey('PROD-1', ownerCtx)).toBeNull(); // released → links break
  });

  it('returns null for non-issue-shaped keys (no hyphen / empty side)', async () => {
    const { ownerCtx } = await makeFixture('shape');
    await projectsService.changeKey({ key: 'PROD', newKey: 'NIF', ctx: ownerCtx });
    expect(await resolveAliasedIssueKey('PROD', ownerCtx)).toBeNull(); // no number
    expect(await resolveAliasedIssueKey('PROD-', ownerCtx)).toBeNull(); // empty number
    expect(await resolveAliasedIssueKey('-7', ownerCtx)).toBeNull(); // empty prefix
  });

  it('re-keys through chained renames to the latest canonical', async () => {
    const { project, ownerCtx } = await makeFixture('redir-chain');
    await seedItems(project.id, ownerCtx, 1);
    await projectsService.changeKey({ key: 'PROD', newKey: 'NIF', ctx: ownerCtx });
    await projectsService.changeKey({ key: 'NIF', newKey: 'ZAP', ctx: ownerCtx });

    expect(await resolveAliasedIssueKey('PROD-1', ownerCtx)).toBe('ZAP-1');
    expect(await resolveAliasedIssueKey('NIF-1', ownerCtx)).toBe('ZAP-1');
    expect(await resolveAliasedIssueKey('ZAP-1', ownerCtx)).toBeNull(); // already canonical
  });
});

describe('active-project pinning is id-based — unaffected by a key change', () => {
  it('keeps the pinned project, surfacing its NEW identifier after a rename', async () => {
    const { project, ownerCtx } = await makeFixture('pin');
    await projectsService.setActiveProject({
      userId: ownerCtx.userId,
      workspaceId: ownerCtx.workspaceId,
      projectId: project.id,
    });
    await projectsService.changeKey({ key: 'PROD', newKey: 'NIF', ctx: ownerCtx });

    const active = await projectsService.getActiveProject(ownerCtx.userId, ownerCtx.workspaceId);
    expect(active?.id).toBe(project.id); // same pinned project (id pointer, not key)
    expect(active?.identifier).toBe('NIF'); // surfaces the canonical key
  });
});
