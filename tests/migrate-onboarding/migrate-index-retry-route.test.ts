import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { randomToken } from '../helpers/random';

// Route-transport tests for POST /api/onboarding/migrate/:id/index-retry
// (Story MOTIR-8246 · MOTIR-8769). Only the context resolvers the cookie-less
// test env can't supply, the motir-ai boundary and the index enqueue are mocked;
// the service and the DB run for real, so body validation and the mapped status
// of each answer are proven against committed state.

const sessionRef = { current: null as { user: { id: string; email: string } } | null };
const wsRef = { current: null as WorkspaceContext | null };

const enqueue = vi.hoisted(() => vi.fn(async (_data: unknown) => {}));
vi.mock('@/lib/github/indexEnqueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/github/indexEnqueue')>();
  return { ...actual, enqueueCodeGraphIndex: enqueue };
});
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
const { POST: indexRetryRoute } =
  await import('@/app/api/onboarding/migrate/[id]/index-retry/route');

const BASE = 'http://localhost:3000/api/onboarding/migrate';

function signIn(fx: WorkItemFixture) {
  sessionRef.current = { user: { id: fx.ownerId, email: 'owner@example.com' } };
  wsRef.current = { userId: fx.ownerId, workspaceId: fx.workspaceId };
}

function call(id: string, body: string) {
  return indexRetryRoute(
    new Request(`${BASE}/${id}/index-retry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }),
    { params: Promise.resolve({ id }) },
  );
}

/** A connected repository whose claimed index run FAILED. */
async function seedFailedRepo(fx: WorkItemFixture, name = 'widgets') {
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
  const failed = await adminDb.jobRun.create({
    data: {
      workspaceId: fx.workspaceId,
      functionId: 'system.code-graph-index',
      eventName: 'system.code-graph-index',
      eventId: `evt-${randomToken()}`,
      lane: 'engine',
      attempt: 0,
      status: 'failed',
      finishedAt: new Date(),
      output: {},
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
      indexingRunId: failed.id,
    },
  });
  return `acme/${name}`;
}

beforeEach(async () => {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "migrate_onboarding" RESTART IDENTITY CASCADE');
  await truncateJobRuns();
  await truncateAuthTables();
  sessionRef.current = null;
  wsRef.current = null;
  enqueue.mockClear();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('POST /api/onboarding/migrate/:id/index-retry', () => {
  it.each([
    ['no body', ''],
    ['an empty object', '{}'],
    ['a non-string repoRef', '{"repoRef":42}'],
    ['an empty repoRef', '{"repoRef":""}'],
  ])('rejects %s with 400', async (_label, body) => {
    const fx = await makeWorkItemFixture();
    signIn(fx);
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    const res = await call(run.id, body);
    expect(res.status).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('re-enqueues a failed repository and answers queued (200)', async () => {
    const fx = await makeWorkItemFixture();
    signIn(fx);
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    const ref = await seedFailedRepo(fx);
    const res = await call(run.id, JSON.stringify({ repoRef: ref }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ repoRef: ref, status: 'queued' });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('maps a repository outside the connected set to 409 not_connected', async () => {
    const fx = await makeWorkItemFixture();
    signIn(fx);
    const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
    await seedFailedRepo(fx);
    const res = await call(run.id, JSON.stringify({ repoRef: 'acme/elsewhere' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'MIGRATE_INDEX_RETRY_REFUSED',
      reason: 'not_connected',
    });
  });

  it('answers 404 for a run outside the caller’s workspace', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const otherRun = await migrateOnboardingService.startMigration(other.projectId, other.ctx);
    signIn(fx);
    const res = await call(otherRun.id, JSON.stringify({ repoRef: 'acme/widgets' }));
    expect(res.status).toBe(404);
  });
});
