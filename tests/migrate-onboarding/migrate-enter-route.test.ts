import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// Route-transport tests for POST /api/onboarding/migrate/:id/enter (Story
// MOTIR-8246 · MOTIR-8770). Only the context resolvers the cookie-less test env
// can't supply and the motir-ai boundary are mocked; the service and the DB run
// for real, so each mapped status is proven against committed state.

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
const { POST: enterRoute } = await import('@/app/api/onboarding/migrate/[id]/enter/route');

const BASE = 'http://localhost:3000/api/onboarding/migrate';

function signIn(fx: WorkItemFixture) {
  sessionRef.current = { user: { id: fx.ownerId, email: 'owner@example.com' } };
  wsRef.current = { userId: fx.ownerId, workspaceId: fx.workspaceId };
}

function call(id: string) {
  return enterRoute(new Request(`${BASE}/${id}/enter`, { method: 'POST' }), {
    params: Promise.resolve({ id }),
  });
}

async function runAt(fx: WorkItemFixture, step: 'connect' | 'import') {
  const run = await migrateOnboardingService.startMigration(fx.projectId, fx.ctx);
  await adminDb.migrateOnboarding.update({ where: { id: run.id }, data: { step } });
  return run.id;
}

beforeEach(async () => {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "migrate_onboarding" RESTART IDENTITY CASCADE');
  await truncateJobRuns();
  await truncateAuthTables();
  sessionRef.current = null;
  wsRef.current = null;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('POST /api/onboarding/migrate/:id/enter', () => {
  it('completes a run at import and answers the run (200)', async () => {
    const fx = await makeWorkItemFixture();
    signIn(fx);
    const id = await runAt(fx, 'import');
    const res = await call(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, step: 'done', status: 'completed' });
  });

  it('answers 409 for a run at a step Enter Motir is not offered on', async () => {
    const fx = await makeWorkItemFixture();
    signIn(fx);
    const id = await runAt(fx, 'connect');
    const res = await call(id);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'MIGRATE_ONBOARDING_WRONG_STEP' });
  });

  it('answers 404 for a run outside the caller’s workspace', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const otherId = await runAt(other, 'import');
    signIn(fx);
    const res = await call(otherId);
    expect(res.status).toBe(404);
  });
});
