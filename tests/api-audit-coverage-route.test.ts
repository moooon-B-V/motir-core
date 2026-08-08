import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { RawCodeAuditSurface } from '@/lib/ai/motirAiClient';

// Transport tests for GET /api/ai/coding-convention/audit-coverage (MOTIR-2248).
// The route is a thin one-service-call transport, so this proves the route-layer
// concerns only: the signed-out 401, the no-active-project 404, the non-admin
// 403, that the answer is not cacheable, and that the route does not undo the
// service's per-repo containment by turning one blip into a failed request.

const ctxRef = { current: null as ProjectContext | null };
const sessionRef = { current: null as { user: { id: string; email: string } } | null };

vi.mock('@/lib/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/projects')>();
  return { ...actual, getActiveProject: async () => ctxRef.current };
});
vi.mock('@/lib/auth', () => ({ getSession: async () => sessionRef.current }));

const getCodeAuditMock = vi.fn<(q: unknown) => Promise<RawCodeAuditSurface>>();
vi.mock('@/lib/ai/motirAiClient', () => ({
  getCodeAudit: (q: unknown) => getCodeAuditMock(q),
}));

const { GET: coverageGET } = await import('@/app/api/ai/coding-convention/audit-coverage/route');
const { createTestWorkspace, createTestProject, createTestUser } = await import('./fixtures');
const { auditCoverageService } = await import('@/lib/services/auditCoverageService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { projectMembersService } = await import('@/lib/services/projectMembersService');
const { githubInstallationService } = await import('@/lib/services/githubInstallationService');
const { MotirAiUnavailableError } = await import('@/lib/ai/errors');
const { truncateAuthTables } = await import('./helpers/db');

const ONE_REPO = [
  {
    providerRepoId: '501',
    owner: 'moooon',
    name: 'motir-core',
    defaultBranch: 'main',
    archived: false,
  },
];

async function signInAtProject() {
  const { workspace, owner } = await createTestWorkspace();
  const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
  sessionRef.current = { user: { id: owner.id, email: `${owner.id}@t.dev` } };
  ctxRef.current = { userId: owner.id, workspaceId: workspace.id, projectId: project.id, project };
  return { workspace, owner, project };
}

beforeEach(async () => {
  await truncateAuthTables();
  ctxRef.current = null;
  sessionRef.current = null;
  getCodeAuditMock.mockReset();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('GET /api/ai/coding-convention/audit-coverage', () => {
  it('401s with no session', async () => {
    const res = await coverageGET();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 'UNAUTHENTICATED' });
  });

  it('404s a signed-in caller with no active project', async () => {
    sessionRef.current = { user: { id: 'u1', email: 'u1@t.dev' } };
    const res = await coverageGET();
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('NO_ACTIVE_PROJECT');
  });

  it('returns the coverage answer for an admin, uncacheable', async () => {
    const { workspace } = await signInAtProject();
    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: {
        installationId: 'inst-cov-route',
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: ONE_REPO,
    });
    getCodeAuditMock.mockResolvedValue({
      audit: null,
      findings: [],
      total: 0,
      nextOffset: null,
    });

    const res = await coverageGET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      repos: [{ repoKey: 'moooon/motir-core', state: 'not_audited' }],
      notAuditedCount: 1,
    });
    // The answer changes the moment an audit lands; a cached one outlives the fix.
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('403s a workspace member who is not a project admin', async () => {
    const { workspace, project } = await signInAtProject();
    const member = await createTestUser();
    await workspacesService.addMember({ userId: member.id, workspaceId: workspace.id });
    sessionRef.current = { user: { id: member.id, email: `${member.id}@t.dev` } };
    ctxRef.current = {
      userId: member.id,
      workspaceId: workspace.id,
      projectId: project.id,
      project,
    };

    const res = await coverageGET();

    expect(res.status).toBe(403);
    expect(getCodeAuditMock).not.toHaveBeenCalled();
  });

  it('maps a NON-gate failure through the code-health mapper, not the gate arm', async () => {
    // The fall-through: `aiPlanGateErrorResponse` returns null for anything that
    // is not a project refusal, and the route must still map it. Asserted with a
    // boundary outage raised from the service itself, because the per-repo
    // failure below is deliberately SWALLOWED (it reports the repo unreadable) and
    // therefore never reaches this line.
    await signInAtProject();
    const spy = vi
      .spyOn(auditCoverageService, 'getCoverage')
      .mockRejectedValue(new MotirAiUnavailableError('down'));
    const res = await coverageGET();
    expect(res.status).toBe(502);
    spy.mockRestore();
  });

  it('404s an actor who cannot BROWSE the project — never a 403 that confirms it', async () => {
    // The other arm of the `ai:configure` gate (MOTIR-2362): `assertPermission`
    // refuses a NON-BROWSER as `ProjectNotFoundError` before the key is tested, so
    // a project they may not see stays missing rather than merely forbidden. The
    // 403 case above proves the browser arm; this one is what makes the pair
    // complete — and it is the branch the coverage floor was short of.
    const { workspace, project } = await signInAtProject();
    await projectMembersService.setAccessLevel({
      key: project.identifier,
      actorUserId: ctxRef.current!.userId,
      ctx: { userId: ctxRef.current!.userId, workspaceId: workspace.id },
      level: 'private',
    });
    const outsider = await createTestUser();
    await workspacesService.addMember({ userId: outsider.id, workspaceId: workspace.id });
    sessionRef.current = { user: { id: outsider.id, email: `${outsider.id}@t.dev` } };
    ctxRef.current = {
      userId: outsider.id,
      workspaceId: workspace.id,
      projectId: project.id,
      project,
    };

    const res = await coverageGET();

    expect(res.status).toBe(404);
    expect(getCodeAuditMock).not.toHaveBeenCalled();
  });

  it('does NOT 502 on a per-repo boundary failure — it reports the repo unreadable', async () => {
    const { workspace } = await signInAtProject();
    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: {
        installationId: 'inst-cov-route-contained',
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: ONE_REPO,
    });
    getCodeAuditMock.mockRejectedValue(new MotirAiUnavailableError('down'));

    const res = await coverageGET();

    // The containment is the service's job and this pins that the route does not
    // undo it: a boundary blip on one repo is that repo's state, not a failed
    // request. (`mapCodeHealthError`'s 502 arm is exercised by the sibling
    // coding-convention route tests, where a read genuinely does fail whole.)
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      repos: [{ repoKey: 'moooon/motir-core', state: 'unavailable' }],
      notAuditedCount: 0,
    });
  });
});
