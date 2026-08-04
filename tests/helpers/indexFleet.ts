import { vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { codeGraphIndexDispatchService } from '@/lib/services/codeGraphIndexDispatchService';
import { fakeOrchestrator } from '@/lib/orchestrator/adapters/fake';

// THE `system.code-graph-index` TEST WORLD (Story MOTIR-1981 · MOTIR-1992) —
// the fake-orchestrator fixture the index-fleet suites drive the REAL job
// through, against a REAL Postgres.
//
// ⚠️ IT LIVES HERE BECAUSE TWO SUITES DRIVE IT. `tests/jobs/code-graph-index.test.ts`
// covers the durable STEP SHAPE; `tests/jobs/code-graph-index-ledger-seam.test.ts`
// covers what the ledger's REAL readers see. A copied harness is how the two
// would silently drift onto different worlds — one stubbing a tarball redirect
// the other buffers — and a seam suite that measures a world the shape suite
// never runs proves nothing about the shipped path. One fixture, one world.

const PASSWORD = 'hunter2hunter2';

/** The pre-signed URL the resolver reads off GitHub's 302 — what the CONTAINER
 *  is handed, in place of the bytes this process no longer fetches. */
export const INDEX_TARBALL_URL =
  'https://codeload.github.com/moooon/motir-core/legacy.tar.gz/refs/heads/main?token=PRESIGNED';
export const INDEX_AI_URL = 'https://ai.example.test';
export const INDEX_SERVICE_TOKEN = 'svc-token-must-never-reach-a-container';
export const INDEX_RUN_CREDENTIAL = 'mrc1.payload.signature';
/** The repo `seedIndexWorkspace` connects by default. */
export const INDEX_REPO_REF = 'moooon/motir-core';

/** One repo to connect under the seeded installation. */
export interface IndexRepoSeed {
  owner: string;
  name: string;
}

const DEFAULT_REPOS: IndexRepoSeed[] = [{ owner: 'moooon', name: 'motir-core' }];

/** Set by the tarball response's traps: TRUE means something buffered the body. */
let tarballBodyTouched = false;

/** Did anything in the index path read the tarball RESPONSE BODY? The §2 OOM,
 *  inverted — a container-based index must never make this true. */
export function tarballBodyWasTouched(): boolean {
  return tarballBodyTouched;
}

/** Per-test reset for the byte trap. Call from `beforeEach`, beside
 *  `fakeOrchestrator.reset()`. */
export function resetTarballBodyTrap(): void {
  tarballBodyTouched = false;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A real RSA key pair, so `appAuth` can actually sign the App JWT. */
export function stubAppCredentials(): void {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_APP_ID', '999');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
}

/**
 * The INDEX job's world: the `fake` orchestrator, motir-ai reachable for the
 * run-credential mint, and GitHub answering the tarball request with the 302 the
 * resolver reads a `Location` off.
 *
 * ⚠️ THE REDIRECT'S BODY IS A TRAP, not a payload. Reading it is the §2 OOM this
 * whole architecture removes, so every buffering method fails loudly instead of
 * quietly costing a few hundred megabytes.
 */
export function stubIndexFleet(): void {
  stubAppCredentials();
  vi.stubEnv('MOTIR_AI_URL', INDEX_AI_URL);
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', INDEX_SERVICE_TOKEN);
  // Select the FAKE adapter the way a deployment selects Fly.
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string): Promise<Response> => {
      // Matched on the PARSED url, never `includes()` — a substring host check is
      // a HIGH CodeQL alert in this repo, test fixtures included.
      const parsed = new URL(String(url));
      if (parsed.host === new URL(INDEX_AI_URL).host) {
        return json(201, {
          credential: INDEX_RUN_CREDENTIAL,
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        });
      }
      if (parsed.pathname.endsWith('/access_tokens')) {
        return json(201, {
          token: 'ghs_installation_must_never_reach_a_container',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      if (parsed.pathname.includes('/tarball/')) {
        const res = new Response(null, {
          status: 302,
          headers: { location: INDEX_TARBALL_URL },
        });
        const trap = (name: string) => () => {
          tarballBodyTouched = true;
          throw new Error(`the index path read the tarball body via ${name}()`);
        };
        for (const name of ['arrayBuffer', 'blob', 'text', 'json'] as const) {
          Object.defineProperty(res, name, { value: trap(name) });
        }
        return res;
      }
      throw new Error(`unexpected fetch to ${parsed.href}`);
    }),
  );
}

// ⚠️ THERE IS NO BYTES-FETCHING WORLD TO STUB ANY MORE (MOTIR-2057). This file
// used to export `stubGithubTarballBytes` — GitHub answering `/tarball/` with a
// 200 and a body — as "the REFRESH job's world, unchanged". Refresh now drives
// the same fleet path as the first index, so BOTH jobs run against
// `stubIndexFleet()` above, whose `/tarball/` response is a 302 whose body is a
// TRAP. That is deliberate: a regression that re-fetches bytes in-process has no
// fixture that would let it pass.

export interface SeededIndexWorkspace {
  workspaceId: string;
  ownerUserId: string;
  projectIds: string[];
  installationId: string;
  /** The connected repos' `owner/name` refs, in seed order. */
  repoRefs: string[];
}

/**
 * Seed a workspace with `projectCount` projects and the given connected repos
 * (default: the single `moooon/motir-core`).
 *
 * All repos share ONE installation on purpose: `resolveCodeContext` reads a
 * single installation per workspace, so repos meant to be visible together —
 * which is exactly what the onboarding wizard's per-repo rows read — must hang
 * off the same grant.
 */
export async function seedIndexWorkspace(
  slug: string,
  projectCount: number,
  repos: IndexRepoSeed[] = DEFAULT_REPOS,
): Promise<SeededIndexWorkspace> {
  const user = await usersService.createUser({
    email: `${slug}@example.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${slug}`,
    ownerUserId: user.id,
  });
  // Drop any auto-seeded project so the count is exactly what the test asked for.
  await db.project.deleteMany({ where: { workspaceId: workspace.id } });
  const projectIds: string[] = [];
  for (let i = 0; i < projectCount; i += 1) {
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: user.id,
      name: `P${i}`,
      identifier: `PRJ${i}${slug.slice(-1).toUpperCase()}`,
    });
    projectIds.push(project.id);
  }
  const installationId = `inst-${slug}`;
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: { installationId, accountLogin: 'moooon', accountType: 'Organization' },
    repos: repos.map((repo, i) => ({
      providerRepoId: `${77 + i}`,
      owner: repo.owner,
      name: repo.name,
      defaultBranch: 'main',
      archived: false,
    })),
  });
  return {
    workspaceId: workspace.id,
    ownerUserId: user.id,
    projectIds,
    installationId,
    repoRefs: repos.map((repo) => `${repo.owner}/${repo.name}`),
  };
}

/** The step ids a run passed to `step.run`, in call order. */
export function indexStepIds(ctx: { step: { run: { mock: { calls: unknown[][] } } } }): string[] {
  return ctx.step.run.mock.calls.map((call) => String(call[0]));
}

/**
 * Pre-fulfilled `step.sleep` state, so the engine can cross the boundaries —
 * BOTH kinds: the admission queue's waits and supervision's poll waits.
 *
 * ⚠️ `step.sleep` HANGS `InngestTestEngine` UNLESS ITS STATE IS SUPPLIED. The
 * engine only records state for steps that RAN, and a sleep never "runs" — so an
 * un-stubbed sleep is re-found forever and `execute()` never resolves (it fails
 * as a test TIMEOUT, which reads like a slow test rather than a missing stub).
 * Supply more than the loop can use.
 */
export function indexSleepSteps(projectIds: string[], perProject = 6) {
  return projectIds.flatMap((projectId) =>
    Array.from({ length: perProject }, (_, i) => i + 1).flatMap((n) => [
      { id: `index-wait:${projectId}:${n}`, handler: () => null },
      { id: `index-admit-wait:${projectId}:${n}`, handler: () => null },
    ]),
  );
}

/**
 * One `system.code-graph-index` event.
 *
 * ⚠️ THE EVENT ID IS PINNED. `InngestTestEngine` mints a FRESH one (and a fresh
 * runId) per execution, and `defineJob` correlates its ledger row by
 * (functionId, eventId) — so a generated id makes a two-execution assertion read
 * two different runs, and two repos dispatched in one test collide unless the id
 * carries the repo.
 */
export function indexEventFor(args: {
  installationId: string;
  workspaceId: string;
  repoOwner?: string;
  repoName?: string;
  eventId?: string;
}) {
  const repoOwner = args.repoOwner ?? 'moooon';
  const repoName = args.repoName ?? 'motir-core';
  return {
    name: 'system.code-graph-index' as const,
    id: args.eventId ?? `evt-${args.installationId}-${repoOwner}-${repoName}`,
    data: {
      installationId: args.installationId,
      workspaceId: args.workspaceId,
      repoOwner,
      repoName,
      defaultBranch: 'main',
    },
  };
}

/**
 * One `system.code-graph-refresh` event — a default-branch push.
 *
 * The payload is the index event's (`CodeGraphRefreshData = CodeGraphIndexData`),
 * which is WHY the two jobs can share `runIndexFleetSteps` since MOTIR-2057. The
 * event id is pinned for the reason above.
 */
export function refreshEventFor(args: {
  installationId: string;
  workspaceId: string;
  repoOwner?: string;
  repoName?: string;
  eventId?: string;
}) {
  const indexEvent = indexEventFor(args);
  return { ...indexEvent, name: 'system.code-graph-refresh' as const };
}

/** The `system.code-graph-refresh` ledger rows, newest last. */
export async function refreshJobRuns() {
  return db.jobRun.findMany({
    where: { functionId: 'system.code-graph-refresh' },
    orderBy: { startedAt: 'asc' },
  });
}

/**
 * The container exits WHILE SUPERVISION SLEEPS — which is what really happens,
 * and the only way a real poll ever sees a terminal machine. Wraps the genuine
 * `pollIndexContainer` rather than replacing it, so the classification, the
 * deadlines and the read-failure tolerance are all still the shipped ones.
 */
export function containerExitsWith(exitCode: number | null): void {
  const realPoll = codeGraphIndexDispatchService.pollIndexContainer.bind(
    codeGraphIndexDispatchService,
  );
  vi.spyOn(codeGraphIndexDispatchService, 'pollIndexContainer').mockImplementation(
    async (session, previous, options) => {
      for (const id of fakeOrchestrator.liveContainerIds()) {
        fakeOrchestrator.completeJob(id, { exitCode });
      }
      return realPoll(session, previous, options);
    },
  );
}

/** The `system.code-graph-index` ledger rows, newest last. */
export async function indexJobRuns() {
  return db.jobRun.findMany({
    where: { functionId: 'system.code-graph-index' },
    orderBy: { startedAt: 'asc' },
  });
}
