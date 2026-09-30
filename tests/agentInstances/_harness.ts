import { generateKeyPairSync } from 'node:crypto';
import { vi } from 'vitest';
import { fakePersistentOrchestrator as fleet } from '@motir/orchestrator';
import { agentInstanceClock } from '@/lib/services/agentInstanceLifecycleService';
import { _resetAiPlanCache } from '@/lib/services/aiPlanGateService';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The agent-instance story's shared test harness (Story MOTIR-6860 · MOTIR-6876):
// the fake persistent fleet, motir-ai and GitHub stubbed at `fetch`, and a virtual
// clock the lifecycle's bounded waits advance instead of sleeping.

export const AI = 'https://ai.test';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

export interface StubCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

/** Mutable knobs a test turns. */
export const stub = {
  calls: [] as StubCall[],
  mayRun: true as boolean | 'unanswerable',
  /** The org's AI subscription as motir-ai reports it (MOTIR-6918's plan gate):
   *  a Stripe status, `null` for none, or `'unanswerable'` for a 503. */
  plan: 'active' as string | null,
  debit: 'ok' as 'ok' | 'unavailable' | 'refused',
};

export const MIN = 60_000;
let virtualNow = 0;
export const clock = {
  advance(ms: number) {
    virtualNow += ms;
  },
  now: () => new Date(virtualNow),
};

export let fx: WorkItemFixture;

export async function setUpHarness(): Promise<void> {
  await truncateAuthTables();
  await adminDb.fleetInFlightSlot.deleteMany({});
  fleet.reset();
  fx = await makeWorkItemFixture();
  stub.calls = [];
  stub.mayRun = true;
  stub.plan = 'active';
  stub.debit = 'ok';
  _resetAiPlanCache();
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  vi.stubEnv('MOTIR_AI_URL', `${AI}/`);
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '111');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', PEM);
  vi.stubEnv('GITHUB_APP_ID', '222');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', PEM);
  vi.stubEnv('MOTIR_INSTANCE_MAX_RUNNING', '');
  virtualNow = new Date('2026-09-29T10:00:00.000Z').getTime();
  vi.spyOn(agentInstanceClock, 'now').mockImplementation(() => new Date(virtualNow));
  vi.spyOn(agentInstanceClock, 'sleep').mockImplementation(async (ms: number) => {
    virtualNow += ms;
  });
  fleet.setNow(() => new Date(virtualNow));
  let tokenSeq = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      stub.calls.push({ url, method, body });
      const json = (status: number, payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      if (url === `${AI}/v1/credits/agent-run-check`) {
        if (stub.mayRun === 'unanswerable') return json(503, { code: 'internal_error' });
        return json(200, { balanceCredits: stub.mayRun ? 100 : 0, mayRun: stub.mayRun });
      }
      if (url.startsWith(`${AI}/v1/stripe/subscription?`)) {
        if (stub.plan === 'unanswerable') return json(503, { code: 'internal_error' });
        return json(200, {
          status: stub.plan,
          currentPeriodEnd: null,
          priceId: null,
          planTier: null,
        });
      }
      if (url === `${AI}/v1/credits/agent-machine`) {
        if (stub.debit === 'unavailable') return json(503, { code: 'internal_error' });
        if (stub.debit === 'refused') return json(402, { code: 'out_of_credits', title: 'no' });
        return json(200, { idempotent: false, balanceCredits: 90 });
      }
      if (/\/repos\/[^/]+\/[^/]+\/installation$/.test(url)) {
        return json(200, { id: 42, account: { login: 'acme' }, suspended_at: null });
      }
      if (url.endsWith('/app/installations/42/access_tokens') && method === 'POST') {
        tokenSeq += 1;
        return json(201, { token: `ghs_clone_${tokenSeq}`, expires_at: '2026-09-29T23:00:00Z' });
      }
      if (url.endsWith('/installation/token') && method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch in test: ${method} ${url}`);
    }),
  );
}

export async function tearDownHarness(): Promise<void> {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await adminDb.fleetInFlightSlot.deleteMany({});
}

let repoSeq = 0;
/** A connected project repository with a realised GitHub repository. */
export async function seedRepo(owner: string, name: string): Promise<void> {
  repoSeq += 1;
  const organizationId = fx.workspace.organizationId;
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId: `inst-${fx.workspaceId}-${owner}` },
    create: {
      installationId: `inst-${fx.workspaceId}-${owner}`,
      workspaceId: fx.workspaceId,
      organizationId,
      accountLogin: owner,
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  const mirror = await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      organizationId,
      repoId: String(800_000 + repoSeq),
      owner,
      name,
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
  });
  await adminDb.projectRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      role: 'web',
      name,
      seedSource: SEED_SOURCE_PLATFORM_STARTER,
      state: 'connected',
      position: `b${String(repoSeq).padStart(3, '0')}`,
      githubRepoId: mirror.id,
    },
  });
}

/** A second member of the fixture's workspace. */
export async function otherMember() {
  const user = await adminDb.user.create({
    data: { name: 'Other', email: `other-${Date.now()}-${Math.random()}@example.com` },
  });
  await adminDb.workspaceMembership.create({
    data: { workspaceId: fx.workspaceId, userId: user.id, workspaceRole: 'member' },
  });
  return { userId: user.id, workspaceId: fx.workspaceId };
}

export const slots = () =>
  adminDb.fleetInFlightSlot.findMany({ where: { workload: 'agent_instance' } });
export const intervals = () =>
  adminDb.agentInstanceInterval.findMany({ orderBy: [{ startedAt: 'asc' }, { createdAt: 'asc' }] });
export const debits = () => stub.calls.filter((c) => c.url === `${AI}/v1/credits/agent-machine`);
export { fleet };
