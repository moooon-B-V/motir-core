import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeOrchestrator } from '@motir/orchestrator';
import { db } from '@/lib/db';
import {
  HostedModelNotOfferedError,
  HostedModelsUnavailableError,
  HostedRunCardNotReadyError,
  HostedRunOutOfCreditsError,
  HostedRunRepositoryNotWritableError,
} from '@/lib/hostedRuns/errors';
import { HOSTED_RUN_SETTLE_MARGIN_MS, HOSTED_RUN_TIMEOUT_MS } from '@/lib/hostedRuns/limits';
import { _resetRunGitBotAuthors } from '@/lib/github/runGitCredential';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { HOSTED_AGENT_MAX_TIMEOUT_MS } from '@/lib/services/hostedAgentContainerService';
import { hostedRunService } from '@/lib/services/hostedRunService';
import { runCredentialService } from '@/lib/services/runCredentialService';
import { scopeClaimService } from '@/lib/services/scopeClaimService';
import {
  createTestLink,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { workItemsService } from '@/lib/services/workItemsService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// STARTING A HOSTED RUN (Story MOTIR-683 · MOTIR-690) — `hostedRunService.start`
// over the real services against real Postgres, with the fleet on the fake
// orchestrator and motir-ai, the gateway and GitHub stubbed at their HTTP seam
// (`fetch`), exactly as each client's own suite stubs it.
//
// ⚠️ THE ABSENCES ARE THE ASSERTIONS for every refusal: no `dispatch_run` row, no
// run-key mint on the gateway stub, no provision on the fake orchestrator. A
// refusal that opened, minted or booted anything and then threw would read, from
// the error alone, exactly like one that did none of it.

const MODEL = 'claude-opus-5-5';
const AI = 'https://ai.test';
const GATEWAY = 'https://gateway.test';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

interface Stub {
  models?: { status?: number; ids?: string[] };
  mayRun?: boolean | 'unanswerable';
  /** `GET /repos/{owner}/{name}/installation` status, by `owner/name`. Default 200. */
  installation?: Record<string, number>;
}

let calls: Call[] = [];

function stub(s: Stub = {}): void {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ url, method, body });
      const json = (status: number, payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        });

      if (url === `${AI}/v1/agent-models`) {
        const status = s.models?.status ?? 200;
        if (status !== 200) return json(status, { code: 'internal_error' });
        const ids = s.models?.ids ?? [MODEL];
        return json(200, {
          models: ids.map((id) => ({ id, provider: 'anthropic' })),
          default: ids[0] ?? null,
        });
      }
      if (url === `${AI}/v1/credits/agent-run-check`) {
        if (s.mayRun === 'unanswerable') return json(503, { code: 'internal_error' });
        const mayRun = s.mayRun ?? true;
        return json(200, {
          coreOrganizationId: body?.coreOrganizationId,
          balanceCredits: mayRun ? 250 : 0,
          hasCredits: mayRun,
          mayRun,
        });
      }
      if (url === `${GATEWAY}/api/motir/run-keys` && method === 'POST') {
        return json(201, {
          key: 'sk-run-key-secret',
          runRef: body?.runRef,
          coreOrganizationId: body?.coreOrganizationId,
          expiresAt: body?.expiresAt,
          lane: 'agent',
        });
      }
      if (url.startsWith(`${GATEWAY}/api/motir/run-keys/`) && method === 'DELETE') {
        return json(200, { runRef: url.split('/').pop(), revoked: 1 });
      }
      const inst = /\/repos\/([^/]+\/[^/]+)\/installation$/.exec(url);
      if (inst && method === 'GET') {
        const repo = inst[1] ?? '';
        const status = s.installation?.[repo] ?? 200;
        if (status !== 200) return json(status, {});
        const owner = repo.split('/')[0];
        return json(200, {
          id: 42,
          account: { login: owner },
          permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
          suspended_at: null,
          html_url: `https://github.com/organizations/${owner}/settings/installations/42`,
        });
      }
      throw new Error(`unexpected fetch in test: ${method} ${url}`);
    }),
  );
}

const mintCalls = () =>
  calls.filter((c) => c.url === `${GATEWAY}/api/motir/run-keys` && c.method === 'POST');
const creditCalls = () => calls.filter((c) => c.url === `${AI}/v1/credits/agent-run-check`);
const aiCalls = () => calls.filter((c) => new URL(c.url).origin === new URL(AI).origin);

let fx: WorkItemFixture;

/** A card created the way the product creates one — in its workflow's initial status. */
function newCard(input: { kind: 'task' | 'story'; title: string; parentId?: string }) {
  return workItemsService.createWorkItem({ projectId: fx.projectId, ...input }, fx.ctx);
}
let repoSeq = 0;

/** A project repository with a realized GitHub repository behind it. */
async function seedRepo(opts: {
  state: 'created' | 'connected';
  owner: string;
  name: string;
}): Promise<string> {
  repoSeq += 1;
  const organizationId = fx.workspace.organizationId;
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId: `inst-${fx.workspaceId}-${opts.owner}` },
    create: {
      installationId: `inst-${fx.workspaceId}-${opts.owner}`,
      workspaceId: fx.workspaceId,
      organizationId,
      accountLogin: opts.owner,
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
      owner: opts.owner,
      name: opts.name,
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
  });
  const row = await adminDb.projectRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      role: 'web',
      name: opts.name,
      seedSource: SEED_SOURCE_PLATFORM_STARTER,
      state: opts.state,
      position: `a${String(repoSeq).padStart(3, '0')}`,
      githubRepoId: mirror.id,
    },
  });
  return row.id;
}

async function pinRepos(workItemId: string, repoIds: string[]): Promise<void> {
  for (const [position, projectRepoId] of repoIds.entries()) {
    await adminDb.workItemRepo.create({
      data: { workspaceId: fx.workspaceId, workItemId, projectRepoId, position },
    });
  }
}

const runRows = () => adminDb.dispatchRun.findMany({ where: { workspaceId: fx.workspaceId } });

async function expectNothingStarted(): Promise<void> {
  expect(await runRows()).toEqual([]);
  expect(mintCalls()).toEqual([]);
  expect(fakeOrchestrator.provisioned).toEqual([]);
}

let seq = 0;
const start = (key: string, model = MODEL) =>
  hostedRunService.start({ workItemKey: key, model, idempotencyKey: `idem-${++seq}` }, fx.ctx);

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  await adminDb.fleetInFlightSlot.deleteMany({});
  fakeOrchestrator.reset();
  _resetRunGitBotAuthors();
  fx = await makeWorkItemFixture();
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  vi.stubEnv('MOTIR_AI_URL', `${AI}/`);
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  vi.stubEnv('MOTIR_GATEWAY_URL', GATEWAY);
  vi.stubEnv('MOTIR_RUN_KEY_MINT_SECRET', 'mint-secret');
  vi.stubEnv('MOTIR_BASE_URL', 'https://app.test/');
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '111');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', PEM);
  vi.stubEnv('GITHUB_APP_ID', '222');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', PEM);
  stub();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await adminDb.fleetInFlightSlot.deleteMany({});
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the refusals — every one before anything is opened, minted or booted', () => {
  it('AC1 — a model not offered: HostedModelNotOfferedError, and no pre-flight was asked', async () => {
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const card = await newCard({ kind: 'task', title: 'a card' });
    stub({ models: { ids: ['claude-sonnet-5'] } });

    await expect(start(card.identifier)).rejects.toBeInstanceOf(HostedModelNotOfferedError);
    expect(creditCalls()).toEqual([]);
    await expectNothingStarted();
  });

  it('AC1 — the list unreadable: HostedModelsUnavailableError, with the same absences', async () => {
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const card = await newCard({ kind: 'task', title: 'a card' });
    stub({ models: { status: 500 } });

    await expect(start(card.identifier)).rejects.toBeInstanceOf(HostedModelsUnavailableError);
    expect(creditCalls()).toEqual([]);
    await expectNothingStarted();
  });

  it('AC2 — mayRun false: HostedRunOutOfCreditsError, nothing opened, minted or booted', async () => {
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const card = await newCard({ kind: 'task', title: 'a card' });
    stub({ mayRun: false });

    await expect(start(card.identifier)).rejects.toBeInstanceOf(HostedRunOutOfCreditsError);
    await expectNothingStarted();
  });

  it('AC5 — a card that is not ready is refused before the model check is called', async () => {
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const blocker = await newCard({ kind: 'task', title: 'first' });
    const card = await newCard({ kind: 'task', title: 'second' });
    await createTestLink({
      workspaceId: fx.workspaceId,
      fromId: card.id,
      toId: blocker.id,
      kind: 'is_blocked_by',
      createdById: fx.ownerId,
    });

    await expect(start(card.identifier)).rejects.toBeInstanceOf(HostedRunCardNotReadyError);
    expect(aiCalls()).toEqual([]);
    await expectNothingStarted();
  });

  it('AC6 — a connected repository its installation no longer reaches refuses the run, naming it', async () => {
    const repo = await seedRepo({ state: 'connected', owner: 'acme', name: 'web' });
    const card = await newCard({ kind: 'task', title: 'a card' });
    await pinRepos(card.id, [repo]);
    stub({ installation: { 'acme/web': 404 } });

    const refused = await start(card.identifier).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(HostedRunRepositoryNotWritableError);
    expect((refused as HostedRunRepositoryNotWritableError).refusals).toEqual([
      expect.objectContaining({ repository: 'acme/web', fix: 'reconnect' }),
    ]);
    await expectNothingStarted();
  });
});

describe('a leaf card — the run it starts', () => {
  it('AC3 · AC9 — one hosted run on the bare model, the card claimed and stamped, one container with the launcher inputs and no other credential', async () => {
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const card = await newCard({ kind: 'task', title: 'a card' });

    const started = await start(card.identifier);
    expect(started.created).toBe(true);

    const runs = await runRows();
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run).toMatchObject({
      id: started.dispatchRunId,
      origin: 'hosted',
      command: 'run',
      agent: 'opencode',
      model: MODEL,
      status: 'running',
    });
    const legs = await adminDb.dispatchRunCard.findMany({ where: { dispatchRunId: run.id } });
    expect(legs.map((l) => l.workItemKey)).toEqual([card.identifier]);

    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
    expect(after).toMatchObject({
      status: 'in_progress',
      assigneeId: fx.ownerId,
      implementationSource: 'hosted',
      implementationHarness: 'opencode',
      implementationModel: MODEL,
    });

    // The key is minted for exactly the bare model, and dies at the backstop.
    expect(mintCalls()).toHaveLength(1);
    const mint = mintCalls()[0]!.body!;
    expect(mint['models']).toEqual([MODEL]);
    expect(mint['expiresAt']).toBe(
      Math.floor((run.startedAt.getTime() + HOSTED_RUN_TIMEOUT_MS) / 1000),
    );
    // The run credential dies by the backstop plus the settle margin.
    const token = await adminDb.apiToken.findFirstOrThrow({ where: { dispatchRunId: run.id } });
    expect(token.expiresAt!.getTime()).toBe(
      run.startedAt.getTime() + HOSTED_RUN_TIMEOUT_MS + HOSTED_RUN_SETTLE_MARGIN_MS,
    );

    // ONE container, booted with the 12-hour backstop and exactly the launcher's inputs.
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
    const spec = fakeOrchestrator.specs[0]!;
    expect(spec.workload).toBe('hosted_agent');
    expect(spec.timeoutSeconds).toBe(HOSTED_AGENT_MAX_TIMEOUT_MS / 1000);
    expect(HOSTED_RUN_TIMEOUT_MS).toBe(HOSTED_AGENT_MAX_TIMEOUT_MS);
    expect(Object.keys(spec.env).sort()).toEqual(
      [
        'MOTIR_API_URL',
        'MOTIR_DISPATCH_RUN_ID',
        'MOTIR_GATEWAY_URL',
        'MOTIR_MODEL',
        'MOTIR_RUN_KEY',
        'MOTIR_RUN_TOKEN',
        'MOTIR_WORK_ITEM_KEY',
      ].sort(),
    );
    expect(spec.env).toMatchObject({
      MOTIR_DISPATCH_RUN_ID: run.id,
      MOTIR_WORK_ITEM_KEY: card.identifier,
      MOTIR_API_URL: 'https://app.test',
      MOTIR_GATEWAY_URL: GATEWAY,
      MOTIR_RUN_KEY: 'sk-run-key-secret',
      MOTIR_MODEL: `anthropic/${MODEL}`,
    });

    // The server wrote the run's `run_opened` — the CLI adopts, never opens.
    const events = await adminDb.dispatchRunEvent.findMany({ where: { dispatchRunId: run.id } });
    expect(events.map((e) => e.kind)).toEqual(['run_opened']);

    // The supervision is queued, and its payload carries no secret.
    const queued = await adminDb.jobQueueRun.findMany({ where: { jobId: 'hosted-run/supervise' } });
    expect(queued).toHaveLength(1);
    const stored = JSON.stringify(
      await adminDb.jobEvent.findMany({ where: { name: 'hosted-run/supervise' } }),
    );
    expect(stored).toContain(run.id);
    expect(stored).not.toContain('sk-run-key-secret');
    expect(stored).not.toContain(spec.env['MOTIR_RUN_TOKEN']!);
  });

  it('AC4 — the same idempotency key twice yields one run and one container', async () => {
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const card = await newCard({ kind: 'task', title: 'a card' });
    const input = { workItemKey: card.identifier, model: MODEL, idempotencyKey: 'same-click' };

    const first = await hostedRunService.start(input, fx.ctx);
    const second = await hostedRunService.start(input, fx.ctx);

    expect(second).toEqual({ dispatchRunId: first.dispatchRunId, created: false });
    expect(await runRows()).toHaveLength(1);
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
  });

  it('AC6 — a run-credential mint that fails after the key was minted ends the run failed and revokes the key', async () => {
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const card = await newCard({ kind: 'task', title: 'a card' });
    vi.spyOn(runCredentialService, 'mintRunCredential').mockRejectedValue(new Error('mint down'));

    await expect(start(card.identifier)).rejects.toThrow('mint down');

    const runs = await runRows();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'failed', stopReason: 'halted' });
    expect(mintCalls()).toHaveLength(1);
    expect(
      calls.some(
        (c) => c.method === 'DELETE' && c.url === `${GATEWAY}/api/motir/run-keys/${runs[0]!.id}`,
      ),
    ).toBe(true);
    expect(fakeOrchestrator.provisioned).toEqual([]);
    const log = await adminDb.dispatchRunEvent.findFirst({
      where: { dispatchRunId: runs[0]!.id, kind: 'log' },
    });
    expect(log?.body).toContain('mint down');
  });

  // Coverage top-up (MOTIR-692): a container nobody supervises spends until the
  // reaper finds it — so a failure to ENQUEUE the supervision job tears the
  // container down through the seam's own settle, right there, and still fails
  // the run (rather than leaving a booted container behind).
  it('a failure to enqueue the supervision settles the container it just booted, and fails the run', async () => {
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const card = await newCard({ kind: 'task', title: 'a card' });
    const sendEventModule = await import('@/lib/jobs/sendEvent');
    const original = sendEventModule.sendEvent;
    // Only the SUPERVISION enqueue fails — claiming a leg emits its own
    // `work-item/transitioned` event first, and that one must still land.
    vi.spyOn(sendEventModule, 'sendEvent').mockImplementation((async (
      name: string,
      ...rest: unknown[]
    ) => {
      if (name === 'hosted-run/supervise') throw new Error('queue is down');
      return (original as (...args: unknown[]) => Promise<void>)(name, ...rest);
    }) as typeof sendEventModule.sendEvent);

    await expect(start(card.identifier)).rejects.toThrow('queue is down');

    expect(fakeOrchestrator.provisioned).toHaveLength(1);
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    const runs = await runRows();
    expect(runs[0]).toMatchObject({ status: 'failed', stopReason: 'halted' });
  });

  // Coverage top-up (MOTIR-692): the leaf's own claim is refused AFTER the run
  // has already opened — a race the readiness check cannot see (another
  // claimer moved between it and the claim). The run still ends `failed`,
  // exactly as any other post-open failure does.
  it('a leaf whose claim is refused after the run opened ends it failed', async () => {
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const card = await newCard({ kind: 'task', title: 'a card' });
    vi.spyOn(workItemsService, 'claimWorkItem').mockResolvedValueOnce({
      outcome: 'blocked',
      claimed: false,
    } as unknown as Awaited<ReturnType<typeof workItemsService.claimWorkItem>>);

    await expect(start(card.identifier)).rejects.toBeInstanceOf(HostedRunCardNotReadyError);

    const runs = await runRows();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'failed', stopReason: 'halted' });
  });
});

describe('a parent card — one run over its children', () => {
  it('AC10 — two ready children in two repositories: one run, both legs in dependency order, claimed and stamped, one container', async () => {
    const site = await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const api = await seedRepo({ state: 'connected', owner: 'acme', name: 'api' });
    const story = await newCard({ kind: 'story', title: 'a story' });
    // `later` sits first on the board but is blocked by `earlier`.
    const later = await newCard({ kind: 'task', title: 'later', parentId: story.id });
    const earlier = await newCard({
      kind: 'task',
      title: 'earlier',
      parentId: story.id,
    });
    await pinRepos(later.id, [site]);
    await pinRepos(earlier.id, [api]);
    await createTestLink({
      workspaceId: fx.workspaceId,
      fromId: later.id,
      toId: earlier.id,
      kind: 'is_blocked_by',
      createdById: fx.ownerId,
    });

    const started = await start(story.identifier);

    const run = (await runRows())[0]!;
    expect(run).toMatchObject({
      id: started.dispatchRunId,
      command: 'run_scope',
      origin: 'hosted',
    });
    const legs = await adminDb.dispatchRunCard.findMany({
      where: { dispatchRunId: run.id },
      orderBy: { position: 'asc' },
    });
    expect(legs.map((l) => l.workItemKey)).toEqual([earlier.identifier, later.identifier]);

    for (const id of [earlier.id, later.id]) {
      expect(await adminDb.workItem.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: 'in_progress',
        assigneeId: fx.ownerId,
        implementationSource: 'hosted',
        implementationModel: MODEL,
      });
    }
    // Write access was checked over BOTH repositories: the connected one asked GitHub.
    expect(calls.some((c) => c.url.endsWith('/repos/acme/api/installation'))).toBe(true);
    expect(fakeOrchestrator.provisioned).toHaveLength(1);
    expect(fakeOrchestrator.specs[0]!.env['MOTIR_WORK_ITEM_KEY']).toBe(story.identifier);
  });

  it('AC10 — a child whose repository cannot be written refuses the whole start', async () => {
    const site = await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const api = await seedRepo({ state: 'connected', owner: 'acme', name: 'api' });
    const story = await newCard({ kind: 'story', title: 'a story' });
    const one = await newCard({ kind: 'task', title: 'one', parentId: story.id });
    const two = await newCard({ kind: 'task', title: 'two', parentId: story.id });
    await pinRepos(one.id, [site]);
    await pinRepos(two.id, [api]);
    stub({ installation: { 'acme/api': 404 } });

    await expect(start(story.identifier)).rejects.toBeInstanceOf(
      HostedRunRepositoryNotWritableError,
    );
    await expectNothingStarted();
    for (const id of [one.id, two.id, story.id]) {
      expect((await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status).toBe('todo');
    }
  });

  // Coverage top-up (MOTIR-692): a scope that is not one layer deep is refused
  // as `wrong_shape` — before the model, the credits or the repository check —
  // exactly as the model-and-repository refusals above are, and just as
  // vacuously of anything opened, minted or booted.
  it('a scope more than one layer deep is refused, before the model check is even asked', async () => {
    await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const story = await newCard({ kind: 'story', title: 'a story' });
    const child = await newCard({ kind: 'task', title: 'a child', parentId: story.id });
    // `task` may parent `bug` (the matrix goes deeper than a flat two levels) —
    // so this is a legal tree, and the REFUSAL is the scope shape, not the parent.
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'bug', title: 'a grandchild', parentId: child.id },
      fx.ctx,
    );

    await expect(start(story.identifier)).rejects.toBeInstanceOf(HostedRunCardNotReadyError);
    expect(aiCalls()).toEqual([]);
    await expectNothingStarted();
  });

  // Coverage top-up (MOTIR-692): the scope claim itself is refused AFTER the
  // run has already opened — a race the readiness preview cannot see (another
  // claimer moved between the preview and the claim). The run still ends
  // `failed`, exactly as any other post-open failure does.
  it('a parent scope claim refused after the run opened ends it failed', async () => {
    const site = await seedRepo({ state: 'created', owner: 'motir-projects', name: 'site' });
    const story = await newCard({ kind: 'story', title: 'a story' });
    const child = await newCard({ kind: 'task', title: 'a child', parentId: story.id });
    await pinRepos(child.id, [site]);
    vi.spyOn(scopeClaimService, 'claimScope').mockResolvedValueOnce({
      claimed: false,
      outcome: 'taken',
    } as unknown as Awaited<ReturnType<typeof scopeClaimService.claimScope>>);

    await expect(start(story.identifier)).rejects.toBeInstanceOf(HostedRunCardNotReadyError);

    const runs = await runRows();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'failed', stopReason: 'halted' });
  });
});
