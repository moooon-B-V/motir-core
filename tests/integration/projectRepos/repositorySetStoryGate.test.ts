import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock ONLY the motir-ai boundary client — the `server-only` pre-plan read the
// repo-set derivation's §0.1.2 signal arrives over. Everything else below is the
// real chain against real Postgres, with `fetch` faked at the GitHub HTTP
// boundary (the shipped convention for the establish suites).
vi.mock('@/lib/ai/motirAiClient', () => ({ getPreplanState: vi.fn() }));

import { db } from '@/lib/db';
import { inngest } from '@/lib/jobs/client';
import { getPreplanState } from '@/lib/ai/motirAiClient';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { projectRepoEstablishService } from '@/lib/services/projectRepoEstablishService';
import { projectRepoProvisioningService } from '@/lib/services/projectRepoProvisioningService';
import {
  _resetProvisioningInstallationCache,
  _setReadinessPollForTests,
} from '@/lib/github/repoProvisioning';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import type { ProposalInput } from '@/lib/dto/plans';
import type { RawPreplanStateResponse } from '@/lib/ai/types';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { createTestProject } from '../../fixtures/projectFixtures';
import { truncateAuthTables } from '../../helpers/db';

// ─────────────────────────────────────────────────────────────────────────────
// The Story-level GATE for "Establish the project's REPOSITORY SET at plan
// approval" (Story MOTIR-1775 · MOTIR-1784) — the ASSEMBLED seams.
//
// Every subtask of this Story ships its own suite, and between them the units
// are dense: the derivation, the creation primitive, the establish machine, the
// pin carrier, the role resolver and the dispatch payload are each covered where
// they live. This file deliberately re-asserts NONE of that. What it owns is the
// residue no single subtask's units can reach — the seams where one subtask's
// real output becomes the next one's real input:
//
//   1. The N-repo create → index seam, read back through the CONSUMERS' DTOs.
//      `projectRepoProvisioningService` is the producer; its own return value is
//      already asserted in its suite. Here a real two-row establish is read back
//      through the two shapes the product actually renders and dispatches from —
//      the establish-step read model and the dispatch payload — so a key-drift
//      bug between producer and consumer cannot hide behind a green producer.
//
//   2. Project-scoped association. Two projects in ONE workspace, each with its
//      own established repository: A resolves to A's repo and B to B's, in both
//      directions, through the set, the read model and the dispatch. This is the
//      test that proves the Story's whole premise, and it is impossible to write
//      under the workspace-scoped model this Story replaced.
//
//   3. The ROLE chain, end to end. A plan whose leaves pin ROLES → the derived
//      set → the establish run → every item's `targetRepo`. Each hop has unit
//      coverage; NOTHING walked the whole chain, and it is the chain — not any
//      hop — that makes "an agent is told where to build" true for a two-repo
//      project. §5.3's two `null` outcomes are asserted here through the same
//      end-to-end path, because "no established row" and "two rows share a role"
//      are properties of a set that was DERIVED, not one a test hand-seeded.
//
// The §3 architecture/contract guards live in
// `tests/projectRepos/repositorySetContractGuards.test.ts`; the browser journey
// is MOTIR-1785; the motir-ai generator's half ships in its own repo.
// ─────────────────────────────────────────────────────────────────────────────

const MOTIR_ORG = 'motir-projects';
const INSTALLATION_ID = '778899';

/** Every `system.code-graph-index` job the run enqueued, in order. */
function indexJobs(): { repoName: string; workspaceId: string; repoOwner: string }[] {
  return vi
    .mocked(inngest.send)
    .mock.calls.filter((c) => (c[0] as { name: string }).name === 'system.code-graph-index')
    .map(
      (c) => (c[0] as { data: { repoName: string; workspaceId: string; repoOwner: string } }).data,
    );
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Repo names the fake GitHub already holds — how a re-run's 422 is staged. */
let existingRepos: Map<string, number>;
/** Repo names the fake GitHub refuses to create, and with which status. */
let refusals: Map<string, number>;
let nextRepoId: number;

/**
 * A GitHub good enough to establish against: it resolves the provisioning
 * installation, mints a token, creates repositories (org + template endpoints),
 * remembers them, 422s a name it already has, and serves reads. The same fake
 * `projectRepoProvisioningService.test.ts` drives, kept independent so a change
 * to either suite cannot silently re-point the other.
 */
function installGitHub(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;

      if (u.endsWith(`/orgs/${MOTIR_ORG}/installation`)) {
        return json(200, { id: Number(INSTALLATION_ID) });
      }
      if (u.includes('/access_tokens')) {
        return json(200, {
          token: 'ghs_provisioning',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      if (
        method === 'POST' &&
        (u.includes('/generate') || u.endsWith(`/orgs/${MOTIR_ORG}/repos`))
      ) {
        const name = String(body?.['name']);
        const refusal = refusals.get(name);
        if (refusal) {
          return json(refusal, { message: 'Organization has disabled repository creation' });
        }
        if (existingRepos.has(name)) {
          return json(422, {
            message: 'Repository creation failed.',
            errors: [
              {
                resource: 'Repository',
                field: 'name',
                message: 'name already exists on this account',
              },
            ],
          });
        }
        const id = nextRepoId++;
        existingRepos.set(name, id);
        return json(201, { id, name, owner: { login: MOTIR_ORG } });
      }
      if (method === 'GET' && u.includes(`/repos/${MOTIR_ORG}/`)) {
        const name = u.split('/').pop()!;
        const id = existingRepos.get(name);
        if (!id) return json(404, { message: 'Not Found' });
        return json(200, { id, name, owner: { login: MOTIR_ORG }, default_branch: 'main' });
      }
      if (method === 'PUT') return json(201, { content: {} });
      throw new Error(`unexpected fetch: ${method} ${u}`);
    }),
  );
}

/** A pre-plan wire body carrying §0.1.2's signal (the rest is irrelevant here). */
function preplanWith(session: { platform?: string | null } | null): RawPreplanStateResponse {
  return {
    session: session === null ? null : (session as RawPreplanStateResponse['session']),
    docs: [],
    catalog: null,
  };
}

/** Create a plan, append the given proposals, mark it planned, and APPROVE it —
 *  the shipped onboarding sequence, which is also what fires the derivation. */
async function approveWith(fx: WorkItemFixture, proposals: ProposalInput[]): Promise<void> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Build it' }, fx.ctx);
  await plansService.addProposals(plan.id, proposals, fx.ctx);
  await plansService.markPlanned(plan.id, fx.ctx);
  await plansService.approvePlan(plan.id, fx.ctx);
}

/** A leaf proposal pinning a repo ROLE — the pin the onboarding path emits. */
function leaf(title: string, role: string | null): ProposalInput {
  return {
    op: 'add',
    proposedFields: { title, kind: 'task', targetRepoRole: role },
  } as ProposalInput;
}

/** The materialized work items, by title. */
async function itemsByTitle(projectId: string) {
  const rows = await db.workItem.findMany({ where: { projectId } });
  return new Map(rows.map((r) => [r.title, r]));
}

beforeEach(async () => {
  await truncateAuthTables();
  existingRepos = new Map();
  refusals = new Map();
  nextRepoId = 700_001;
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();
  _setReadinessPollForTests({ attempts: 2, delayMs: 0 });
  installGitHub();
  vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] } as never);
  vi.mocked(getPreplanState).mockResolvedValue(preplanWith({ platform: null }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  _setReadinessPollForTests(null);
});

afterAll(async () => {
  await db.$disconnect();
});

// ── 1 · the N-repo create → index seam, through the CONSUMERS' DTOs ──────────

describe('establishing an N-row set, read back through the consumers', () => {
  it('serves both repositories through the establish read model and the dispatch payload', async () => {
    const fx = await makeWorkItemFixture();
    await projectRepoSetService.addRow(fx.projectId, { role: 'web', name: 'acme-web' }, fx.ctx);
    await projectRepoSetService.addRow(fx.projectId, { role: 'api', name: 'acme-api' }, fx.ctx);

    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    // ── the UI consumer: the establish step's read model, NOT the producer's
    // return value. A rename or drop between the two shapes lands here.
    const view = await projectRepoEstablishService.getEstablishView(fx.projectId, fx.ctx);
    expect(view.hostOwner).toBe(MOTIR_ORG);
    expect(
      view.set.rows.map((r) => [r.role, r.name, r.state, r.established, r.realizedRepo?.owner]),
    ).toEqual([
      ['web', 'acme-web', 'created', true, MOTIR_ORG],
      ['api', 'acme-api', 'created', true, MOTIR_ORG],
    ]);

    // ── the DISPATCH consumer: the payload an agent is actually handed. The
    // producer never builds this shape; the mappers do, from the rows it wrote.
    await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'build the api half',
        assigneeId: null,
        descriptionMd: null,
        targetRepo: 'acme-api',
      },
      fx.ctx,
    );
    const dispatch = await workItemsService.getNextReady(fx.projectId, {}, fx.ctx);
    expect(dispatch).toMatchObject({
      targetRepo: 'acme-api',
      targetRepoDefaultBranch: 'main',
    });
    expect(dispatch!.targetRepoCloneUrl).toContain(`${MOTIR_ORG}/acme-api`);

    // ── and the index fan-out is PER REPO, carrying the creating workspace.
    expect(indexJobs().map((d) => d.repoName)).toEqual(['acme-web', 'acme-api']);
    expect(new Set(indexJobs().map((d) => d.workspaceId))).toEqual(new Set([fx.workspaceId]));
  });

  it('shows a PARTIALLY established set honestly to both consumers', async () => {
    // Rows are independent (ADR §4), so the consumers must render a half-done set
    // rather than a broken one — the producer's per-row honesty is only useful if
    // it survives the read back.
    const fx = await makeWorkItemFixture();
    await projectRepoSetService.addRow(fx.projectId, { role: 'web', name: 'acme-web' }, fx.ctx);
    await projectRepoSetService.addRow(fx.projectId, { role: 'api', name: 'acme-api' }, fx.ctx);
    refusals.set('acme-api', 403);

    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    const view = await projectRepoEstablishService.getEstablishView(fx.projectId, fx.ctx);
    expect(view.set.rows.map((r) => [r.name, r.state, r.established])).toEqual([
      ['acme-web', 'created', true],
      ['acme-api', 'failed', false],
    ]);
    expect(view.set.rows[1]!.failureReason).toBeTruthy();
    expect(view.set.rows[1]!.realizedRepo).toBeNull();

    // ONE index job — the failed row enqueued nothing.
    expect(indexJobs().map((d) => d.repoName)).toEqual(['acme-web']);

    // DISPATCH answers from what EXISTS, not from what was planned. One row
    // established means one repository, so the unpinned item resolves to it —
    // this is the single-repo case, not a guess across two. Pinned because the
    // distinction is easy to get backwards in either direction: refusing here
    // would strand a project whose second repo failed, and resolving once the
    // second one lands would be the guess the Story forbids.
    await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'unpinned',
        assigneeId: null,
        descriptionMd: null,
      },
      fx.ctx,
    );
    expect((await workItemsService.getNextReady(fx.projectId, {}, fx.ctx))!.targetRepo).toBe(
      'acme-web',
    );

    // …and the moment the retry lands the second repository, the same read goes
    // NULL: two established repos and no pin is the refusal to guess.
    refusals.delete('acme-api');
    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);
    expect((await workItemsService.getNextReady(fx.projectId, {}, fx.ctx))!.targetRepo).toBeNull();
  });
});

// ── 2 · project-scoped association ───────────────────────────────────────────

describe('two projects in ONE workspace', () => {
  it('each resolves to its OWN repository, in both directions, through every read', async () => {
    // The Story's whole premise. Under the workspace-scoped model that preceded
    // it, both projects saw both repositories and neither could be answered.
    const alpha = await makeWorkItemFixture({ name: 'Acme', identifier: 'ALP' });
    const betaProject = await createTestProject({
      workspaceId: alpha.workspaceId,
      actorUserId: alpha.ownerId,
      name: 'Beta',
      identifier: 'BET',
    });
    const beta: WorkItemFixture = { ...alpha, project: betaProject, projectId: betaProject.id };

    await projectRepoSetService.addRow(
      alpha.projectId,
      { role: 'web', name: 'alpha-web' },
      alpha.ctx,
    );
    await projectRepoSetService.addRow(beta.projectId, { role: 'web', name: 'beta-web' }, beta.ctx);
    await projectRepoProvisioningService.establishSet(alpha.projectId, alpha.ctx);
    await projectRepoProvisioningService.establishSet(beta.projectId, beta.ctx);

    // The SET read is scoped to its project — neither sees the sibling's row.
    expect(
      (await projectRepoSetService.listByProject(alpha.projectId, alpha.ctx)).map((r) => r.name),
    ).toEqual(['alpha-web']);
    expect(
      (await projectRepoSetService.listByProject(beta.projectId, beta.ctx)).map((r) => r.name),
    ).toEqual(['beta-web']);

    // So is the establish READ MODEL.
    const alphaView = await projectRepoEstablishService.getEstablishView(
      alpha.projectId,
      alpha.ctx,
    );
    const betaView = await projectRepoEstablishService.getEstablishView(beta.projectId, beta.ctx);
    expect(alphaView.set.rows.map((r) => r.name)).toEqual(['alpha-web']);
    expect(betaView.set.rows.map((r) => r.name)).toEqual(['beta-web']);

    // And so is DISPATCH: each project's unpinned item resolves to its own repo,
    // even though BOTH repositories are connected to the one workspace — which is
    // exactly the state that used to make this ambiguous.
    for (const [fx, name] of [
      [alpha, 'alpha-web'],
      [beta, 'beta-web'],
    ] as const) {
      await workItemsService.createWorkItem(
        {
          projectId: fx.projectId,
          kind: 'task',
          title: `${name} work`,
          assigneeId: null,
          descriptionMd: null,
        },
        fx.ctx,
      );
      const dispatch = await workItemsService.getNextReady(fx.projectId, {}, fx.ctx);
      expect(dispatch!.targetRepo).toBe(name);
      expect(dispatch!.targetRepoCloneUrl).toContain(name);
    }
  });
});

// ── 3 · the ROLE chain, end to end ───────────────────────────────────────────

describe('a plan that pins ROLES, from approval to a dispatchable repo', () => {
  it('proposes two rows, establishes them, and pins every item to its role’s repo', async () => {
    const fx = await makeWorkItemFixture();

    await approveWith(fx, [leaf('The web half', 'web'), leaf('The API half', 'api')]);

    // The distinct roles FED the derivation — two rows, each attributed to the
    // rung the ladder actually climbed.
    const proposed = await projectRepoSetService.listByProject(fx.projectId, fx.ctx);
    expect(proposed.map((r) => [r.role, r.state, r.proposalSignal])).toEqual([
      ['web', 'proposed', 'plan-item-role'],
      ['api', 'proposed', 'plan-item-role'],
    ]);
    // …and at approve time NOTHING is pinned: the repositories do not exist yet.
    expect([...(await itemsByTitle(fx.projectId)).values()].map((i) => i.targetRepo)).toEqual([
      null,
      null,
    ]);

    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    // Establishing the rows is what resolves the pins — each item to ITS role's
    // repository, not to the primary and not to a guess.
    const items = await itemsByTitle(fx.projectId);
    const web = items.get('The web half')!;
    const api = items.get('The API half')!;
    expect(web.targetRepoRole).toBe('web');
    expect(api.targetRepoRole).toBe('api');
    expect(web.targetRepo).toBe(proposed[0]!.name);
    expect(api.targetRepo).toBe(proposed[1]!.name);
    expect(web.targetRepo).not.toBe(api.targetRepo);

    // And the agent is told where to build — through the dispatch payload, which
    // is the only surface that claim is true on.
    const dispatch = await workItemsService.getNextReady(fx.projectId, {}, fx.ctx);
    expect(dispatch!.targetRepo).toBe(web.targetRepo);
    expect(dispatch!.targetRepoCloneUrl).toContain(web.targetRepo!);
  });

  it('a one-role plan proposes ONE row, named without a role suffix', async () => {
    const fx = await makeWorkItemFixture();

    await approveWith(fx, [leaf('All of it', 'web'), leaf('Also this', 'web')]);

    const rows = await projectRepoSetService.listByProject(fx.projectId, fx.ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe('web');
    expect(rows[0]!.name).not.toMatch(/-web$/);

    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    const items = await itemsByTitle(fx.projectId);
    expect([...items.values()].map((i) => i.targetRepo)).toEqual([rows[0]!.name, rows[0]!.name]);
  });

  it('a plan pinning NO role behaves exactly as a pre-role project did', async () => {
    const fx = await makeWorkItemFixture();

    await approveWith(fx, [leaf('Just work', null), leaf('More work', null)]);

    // One default row, attributed to a rung that is NOT the plan's roles.
    const rows = await projectRepoSetService.listByProject(fx.projectId, fx.ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.proposalSignal).not.toBe('plan-item-role');

    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    // No role, so the ROLE pass pins nothing — and the item still dispatches,
    // because a single-repo project resolves by its set, exactly as before.
    const items = await itemsByTitle(fx.projectId);
    expect([...items.values()].every((i) => i.targetRepoRole === null)).toBe(true);
    expect([...items.values()].every((i) => i.targetRepo === null)).toBe(true);
    expect((await workItemsService.getNextReady(fx.projectId, {}, fx.ctx))!.targetRepo).toBe(
      rows[0]!.name,
    );
  });

  it('leaves a role with NO established row unpinned — §5.3’s first null outcome', async () => {
    const fx = await makeWorkItemFixture();
    await approveWith(fx, [leaf('The web half', 'web'), leaf('The API half', 'api')]);
    const rows = await projectRepoSetService.listByProject(fx.projectId, fx.ctx);
    refusals.set(rows[1]!.name, 403);

    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    const items = await itemsByTitle(fx.projectId);
    // The role that established is pinned; the one that failed is honestly null —
    // NOT fallen back onto its sibling's repository.
    expect(items.get('The web half')!.targetRepo).toBe(rows[0]!.name);
    expect(items.get('The API half')!.targetRepo).toBeNull();
  });

  it('leaves a role carried by TWO rows unpinned — §5.3’s second null outcome', async () => {
    // Ambiguity is a property of the SET, so it must survive the whole chain: the
    // plan pinned one role, the user split it into two services, and the correct
    // answer is no answer rather than an arbitrary pick.
    const fx = await makeWorkItemFixture();
    await approveWith(fx, [leaf('The API half', 'api')]);
    await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'api', name: 'acme-api-search', label: 'search' },
      fx.ctx,
    );

    await projectRepoProvisioningService.establishSet(fx.projectId, fx.ctx);

    const rows = await projectRepoSetService.listByProject(fx.projectId, fx.ctx);
    expect(rows.filter((r) => r.role === 'api' && r.established)).toHaveLength(2);
    expect((await itemsByTitle(fx.projectId)).get('The API half')!.targetRepo).toBeNull();
  });
});
