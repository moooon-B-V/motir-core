import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';
import { seedSystemPrincipal } from '@/scripts/plan-seed/systemPrincipal';
import {
  authenticateServiceRequest,
  resolveSystemPrincipal,
  resolveServiceProjectByKey,
  ServiceAuthError,
  SystemPrincipalNotProvisionedError,
} from '@/lib/ai/serviceAuth';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { truncateAuthTables } from '../helpers/db';

// MOTIR-1451 — the cross-project service principal + service-bearer-only auth
// the bug-filing route (MOTIR-1450) consumes. Real Postgres (no DB mocks). The
// fixture stands up a META workspace + project keyed `MOTIR` and provisions the
// system principal into it via the seed helper, exactly as the real seed does.

const SECRET = 'core-callback-secret-test';
const PASSWORD = 'hunter2hunter2';

beforeEach(async () => {
  await truncateAuthTables();
  process.env['CORE_CALLBACK_SECRET'] = SECRET;
});

afterAll(async () => {
  await db.$disconnect();
});

/** A META workspace (`moooon`-analogue) + a `MOTIR`-keyed project + the system
 *  principal enrolled in both — the shipped seed's shape, minimised. */
async function makeMetaTenant(identifier = 'MOTIR') {
  const owner = await usersService.createUser({
    email: `owner-${identifier}@example.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'moooon',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'motir',
    identifier,
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  const { userId: systemUserId } = await seedSystemPrincipal({
    workspaceId: workspace.id,
    projectId: project.id,
  });
  return { owner, workspace, project, systemUserId };
}

function req(headers: Record<string, string>): Request {
  return new Request('http://internal/api/internal/ai/work-items', { headers });
}

describe('resolveSystemPrincipal', () => {
  it('resolves the seeded system user + its meta workspace', async () => {
    const { workspace, systemUserId } = await makeMetaTenant();
    const ctx = await resolveSystemPrincipal();
    expect(ctx).toEqual({ userId: systemUserId, workspaceId: workspace.id });
  });

  it('throws SystemPrincipalNotProvisionedError (500) when the principal is absent', async () => {
    // No seedSystemPrincipal call → no system user at all.
    await usersService.createUser({ email: 'someone@example.com', password: PASSWORD, name: 'X' });
    await expect(resolveSystemPrincipal()).rejects.toBeInstanceOf(
      SystemPrincipalNotProvisionedError,
    );
    try {
      await resolveSystemPrincipal();
      expect.unreachable();
    } catch (err) {
      expect((err as SystemPrincipalNotProvisionedError).httpStatus).toBe(500);
    }
  });
});

describe('authenticateServiceRequest', () => {
  it('accepts a valid service bearer and returns the system principal ctx', async () => {
    const { workspace, systemUserId } = await makeMetaTenant();
    const auth = await authenticateServiceRequest(req({ authorization: `Bearer ${SECRET}` }));
    expect(auth.ctx).toEqual({ userId: systemUserId, workspaceId: workspace.id });
  });

  it('rejects a missing/wrong bearer with ServiceAuthError(401) before any principal lookup', async () => {
    await makeMetaTenant();
    await expect(authenticateServiceRequest(req({}))).rejects.toBeInstanceOf(ServiceAuthError);
    try {
      await authenticateServiceRequest(req({ authorization: 'Bearer nope' }));
      expect.unreachable();
    } catch (err) {
      expect((err as ServiceAuthError).httpStatus).toBe(401);
      expect((err as ServiceAuthError).code).toBe('service_unauthorized');
    }
  });

  it('fails closed when CORE_CALLBACK_SECRET is unset', async () => {
    await makeMetaTenant();
    delete process.env['CORE_CALLBACK_SECRET'];
    await expect(
      authenticateServiceRequest(req({ authorization: 'Bearer anything' })),
    ).rejects.toBeInstanceOf(ServiceAuthError);
  });
});

describe('the system principal satisfies the create gates', () => {
  it('is a workspace member (so assertReporterMember passes) AND a project member', async () => {
    const { workspace, project, systemUserId } = await makeMetaTenant();
    const wsMembership = await workspaceMembershipRepository.findByUserAndWorkspace(
      systemUserId,
      workspace.id,
    );
    expect(wsMembership).not.toBeNull();
    const projMembership = await projectMembershipRepository.findByUserAndProject(
      systemUserId,
      project.id,
    );
    expect(projMembership).not.toBeNull();
  });

  it('can file a `kind: bug` into the meta project AS the system reporter (end-to-end)', async () => {
    const { project, systemUserId } = await makeMetaTenant();
    const ctx = await resolveSystemPrincipal();
    const bug = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'bug', title: 'Planner mis-scoped a card' },
      ctx,
    );
    expect(bug.kind).toBe('bug');
    expect(bug.reporterId).toBe(systemUserId);
    expect(bug.identifier).toMatch(/^MOTIR-\d+$/);
  });
});

describe('resolveServiceProjectByKey — 404-not-403 cross-tenant contract', () => {
  it('resolves the meta project by its key within the principal workspace', async () => {
    const { project } = await makeMetaTenant('MOTIR');
    const ctx = await resolveSystemPrincipal();
    const resolved = await resolveServiceProjectByKey('MOTIR', ctx);
    expect(resolved.id).toBe(project.id);
    // case-insensitive (identifiers are canonical uppercase)
    const lower = await resolveServiceProjectByKey('motir', ctx);
    expect(lower.id).toBe(project.id);
  });

  it('throws ProjectNotFoundError (→404) for a key that does not exist', async () => {
    await makeMetaTenant('MOTIR');
    const ctx = await resolveSystemPrincipal();
    await expect(resolveServiceProjectByKey('NOPE', ctx)).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
  });

  it('does NOT resolve a project that exists only in ANOTHER workspace (no existence leak)', async () => {
    // The principal lives in the meta workspace (key MOTIR). A DIFFERENT
    // workspace owns a project keyed OTHER; the principal must NOT see it —
    // same ProjectNotFoundError as a key that exists nowhere.
    const { systemUserId } = await makeMetaTenant('MOTIR');
    const stranger = await usersService.createUser({
      email: 'stranger@example.com',
      password: PASSWORD,
      name: 'Stranger',
    });
    const { workspace: otherWs } = await workspacesService.createWorkspace({
      name: 'other-co',
      ownerUserId: stranger.id,
    });
    await projectsService.createProject({
      name: 'Other',
      identifier: 'OTHER',
      workspaceId: otherWs.id,
      actorUserId: stranger.id,
    });
    const ctx = await resolveSystemPrincipal();
    expect(ctx.userId).toBe(systemUserId);
    await expect(resolveServiceProjectByKey('OTHER', ctx)).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
  });
});
