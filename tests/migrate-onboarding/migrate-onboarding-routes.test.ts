import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { WorkspaceContext } from '@/lib/workspaces';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// Route-transport tests for the resumable migrate-onboarding API (Story 7.15 ·
// MOTIR-931): POST /api/onboarding/migrate (start), GET …/:id (resume), POST
// …/:id/advance. Only the three context resolvers the cookie-less test env can't
// supply (getSession, getActiveProject, getWorkspaceContext) + the motir-ai
// boundary are mocked; the service + DB run for real, so the routes' session
// gates, success shapes, and typed-error → HTTP mapping (_errors.ts) are proven
// against committed state.

const sessionRef = { current: null as { user: { id: string; email: string } } | null };
const projectRef = { current: null as ProjectContext | null };
const wsRef = { current: null as WorkspaceContext | null };

vi.mock('@/lib/auth', () => ({ getSession: async () => sessionRef.current }));
vi.mock('@/lib/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/projects')>();
  return { ...actual, getActiveProject: async () => projectRef.current };
});
vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => wsRef.current };
});
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(async (kind: string) => ({ jobId: `job-${kind}` })),
  refreshCodeAudit: vi.fn(async () => ({ auditJobId: 'a', conventionJobId: 'c' })),
  getPreplanState: vi.fn(async () => ({ session: null, docs: [], catalog: null })),
  streamJob: vi.fn(),
  getJob: vi.fn(),
  approveConvention: vi.fn(),
  editConvention: vi.fn(),
  getConvention: vi.fn(),
  getCodeAudit: vi.fn(),
  saveDesignChoice: vi.fn(),
  indexCodeGraph: vi.fn(),
  getOrgUsage: vi.fn(),
  getOrgSubscription: vi.fn(),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  setSeatQuantity: vi.fn(),
  parseSseFrame: vi.fn(),
}));

const { POST: startRoute } = await import('@/app/api/onboarding/migrate/route');
const { GET: getRoute } = await import('@/app/api/onboarding/migrate/[id]/route');
const { POST: advanceRoute } = await import('@/app/api/onboarding/migrate/[id]/advance/route');

const BASE = 'http://localhost:3000/api/onboarding/migrate';

function useProject(fx: WorkItemFixture) {
  sessionRef.current = { user: { id: fx.ownerId, email: 'owner@example.com' } };
  wsRef.current = { userId: fx.ownerId, workspaceId: fx.workspaceId };
  projectRef.current = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: { id: fx.projectId, identifier: fx.projectIdentifier } as ProjectContext['project'],
  };
}

async function seedConnectedRepo(fx: WorkItemFixture) {
  const rand = Math.random().toString(36).slice(2, 8);
  const inst = await db.githubInstallation.create({
    data: {
      installationId: `inst-${rand}`,
      workspaceId: fx.workspaceId,
      accountLogin: 'acme',
      accountType: 'Organization',
    },
  });
  await db.githubRepo.create({
    data: {
      installationId: inst.id,
      repoId: `repo-${rand}`,
      owner: 'acme',
      name: 'widgets',
      defaultBranch: 'main',
    },
  });
}

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE TABLE "migrate_onboarding" RESTART IDENTITY CASCADE');
  await truncateJobRuns();
  await truncateAuthTables();
  sessionRef.current = null;
  projectRef.current = null;
  wsRef.current = null;
});

afterAll(async () => {
  await db.$disconnect();
});

describe('POST /api/onboarding/migrate — start', () => {
  it('401s with no session', async () => {
    const res = await startRoute(new Request(BASE, { method: 'POST' }));
    expect(res.status).toBe(401);
  });

  it('404s with no active project', async () => {
    const fx = await makeWorkItemFixture();
    sessionRef.current = { user: { id: fx.ownerId, email: 'o@e.com' } };
    const res = await startRoute(new Request(BASE, { method: 'POST' }));
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('NO_ACTIVE_PROJECT');
  });

  it('starts a run, then 409s a second start', async () => {
    const fx = await makeWorkItemFixture();
    useProject(fx);
    const res = await startRoute(new Request(BASE, { method: 'POST' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.step).toBe('connect');
    expect(body.projectId).toBe(fx.projectId);

    const dup = await startRoute(new Request(BASE, { method: 'POST' }));
    expect(dup.status).toBe(409);
    expect((await dup.json()).code).toBe('MIGRATE_ONBOARDING_EXISTS');
  });
});

describe('GET /api/onboarding/migrate/:id — resume', () => {
  it('returns the saved step, and 404s a bogus id', async () => {
    const fx = await makeWorkItemFixture();
    useProject(fx);
    const started = await (await startRoute(new Request(BASE, { method: 'POST' }))).json();

    const res = await getRoute(new Request(`${BASE}/${started.id}`), {
      params: Promise.resolve({ id: started.id }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).step).toBe('connect');

    const missing = await getRoute(new Request(`${BASE}/nope`), {
      params: Promise.resolve({ id: 'nope' }),
    });
    expect(missing.status).toBe(404);
  });
});

describe('POST /api/onboarding/migrate/:id/advance', () => {
  it('409s when the exit condition is unmet, 200 + advances when it is met', async () => {
    const fx = await makeWorkItemFixture();
    useProject(fx);
    const started = await (await startRoute(new Request(BASE, { method: 'POST' }))).json();
    const params = { params: Promise.resolve({ id: started.id }) };

    // No connected repo yet → the generic guard rejects with 409.
    const blocked = await advanceRoute(
      new Request(`${BASE}/${started.id}/advance`, { method: 'POST' }),
      params,
    );
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).code).toBe('MIGRATE_ONBOARDING_EXIT_CONDITION_UNMET');

    // Connect a repo → advance succeeds to `index`.
    await seedConnectedRepo(fx);
    const ok = await advanceRoute(
      new Request(`${BASE}/${started.id}/advance`, { method: 'POST' }),
      params,
    );
    expect(ok.status).toBe(200);
    expect((await ok.json()).step).toBe('index');
  });
});
