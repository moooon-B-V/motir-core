import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { randomToken } from '../helpers/random';

// Route-transport tests for GET /api/onboarding/migrate/:id/connect-state
// (Story MOTIR-8241 · MOTIR-8472). Only the context resolvers the cookie-less
// test env can't supply and the motir-ai boundary are mocked; the service and
// the DB run for real, so the session gate, the response shape, the no-store
// header and the tenancy refusal are proven against committed state.

const sessionRef = { current: null as { user: { id: string; email: string } } | null };
const wsRef = { current: null as WorkspaceContext | null };

vi.mock('@/lib/auth', () => ({ getSession: async () => sessionRef.current }));
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
  getConvention: vi.fn(),
  getCodeAudit: vi.fn(),
  saveDesignChoice: vi.fn(),
  getOrgUsage: vi.fn(),
  getOrgSubscription: vi.fn(),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  setSeatQuantity: vi.fn(),
  parseSseFrame: vi.fn(),
}));

const { migrateOnboardingService } = await import('@/lib/services/migrateOnboardingService');
const { GET: connectStateRoute } =
  await import('@/app/api/onboarding/migrate/[id]/connect-state/route');

const BASE = 'http://localhost:3000/api/onboarding/migrate';

function signIn(fx: WorkItemFixture) {
  sessionRef.current = { user: { id: fx.ownerId, email: 'owner@example.com' } };
  wsRef.current = { userId: fx.ownerId, workspaceId: fx.workspaceId };
}

function call(id: string, query = '') {
  return connectStateRoute(new Request(`${BASE}/${id}/connect-state${query}`), {
    params: Promise.resolve({ id }),
  });
}

async function seedConnectedRepo(fx: WorkItemFixture, name = 'widgets') {
  const rand = randomToken(6);
  const installation = await adminDb.githubInstallation.create({
    data: {
      installationId: `inst-${rand}`,
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      accountLogin: `acct-${rand}`,
      accountType: 'Organization',
    },
  });
  await adminDb.githubRepo.create({
    data: {
      installationId: installation.id,
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      repoId: `repo-${rand}`,
      owner: 'acme',
      name,
      defaultBranch: 'main',
      archived: false,
    },
  });
  return installation;
}

beforeEach(async () => {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "migrate_onboarding" RESTART IDENTITY CASCADE');
  await truncateJobRuns();
  await truncateAuthTables();
  await adminDb.githubInstallation.deleteMany({});
  sessionRef.current = null;
  wsRef.current = null;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('GET /api/onboarding/migrate/:id/connect-state', () => {
  it('401s with no session, and carries no connect state', async () => {
    const res = await call('anything');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).not.toHaveProperty('organizationId');
    expect(body).not.toHaveProperty('outcome');
  });

  it('returns the five fields with Cache-Control: private, no-store', async () => {
    const fx = await makeWorkItemFixture();
    signIn(fx);
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    await seedConnectedRepo(fx);

    const res = await call(run.id);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(
      ['installation', 'organizationId', 'outcome', 'repositories', 'snapshot'].sort(),
    );
    expect(body.organizationId).toBe(fx.workspace.organizationId);
    expect(body.installation.bound).toBe(true);
    expect(body.repositories).toEqual([
      { provider: 'github', repoRef: 'acme/widgets', defaultBranch: 'main' },
    ]);
    expect(body.outcome).toBe('already_connected');
    expect(typeof body.snapshot).toBe('string');
  });

  it('reads ?before= — the run’s own snapshot witnesses the departure', async () => {
    const fx = await makeWorkItemFixture();
    signIn(fx);
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    const first = await (await call(run.id)).json();
    expect(first.outcome).toBe('not_started');
    expect(first.repositories).toEqual([]);

    const back = await (await call(run.id, `?before=${encodeURIComponent(first.snapshot)}`)).json();
    expect(back.outcome).toBe('install_cancelled');
    const junk = await (await call(run.id, '?before=garbage')).json();
    expect(junk.outcome).toBe('not_started');
  });

  it('writes nothing', async () => {
    const fx = await makeWorkItemFixture();
    signIn(fx);
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    await seedConnectedRepo(fx);
    const snapshot = async () => ({
      run: await adminDb.migrateOnboarding.findUniqueOrThrow({ where: { id: run.id } }),
      installations: await adminDb.githubInstallation.findMany({ orderBy: { id: 'asc' } }),
      links: await adminDb.githubInstallationOrgLink.findMany({ orderBy: { id: 'asc' } }),
      jobs: await adminDb.jobRun.count(),
    });
    const before = await snapshot();
    expect((await call(run.id)).status).toBe(200);
    expect(await snapshot()).toEqual(before);
  });

  it('404s another workspace’s run without leaking its accounts or repositories', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    const otherRun = await migrateOnboardingService.startMigration(other.projectId, other.ctx);
    const installation = await seedConnectedRepo(other, 'secret-repo');
    signIn(fx);

    const res = await call(otherRun.id);
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain('secret-repo');
    expect(text).not.toContain(installation.accountLogin);
  });
});
