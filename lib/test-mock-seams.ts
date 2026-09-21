// THE E2E BOUNDARY SEAMS, as ONE table every process in the lane installs from
// (Bug MOTIR-5837). Node-only.
//
// ⚠️ WHY THIS IS NOT INSIDE `instrumentation.ts` ANY MORE. That file is a
// NEXT.JS HOOK: it runs once per Next server boot and nowhere else. The E2E lane
// runs a THIRD process — the Postgres job engine's worker (`scripts/worker.ts`,
// spawned by `tests/e2e/_helpers/job-worker-process.ts`) — which never executes
// it. So while this table lived there, a job handler that reached a faked
// boundary got NO intercept at all: `pull-request/auto-merge.requested` and
// `system.pull-request-reconcile` left the box for the real `api.github.com`,
// and the approve-before-green → merges-by-itself path was unreachable from any
// spec. The worker had grown ONE seam of its own (the index writer's, MOTIR-3564)
// by hand, which is exactly the shape that re-opens the hole for the next seam.
// Now both processes call `installE2EMockSeams()`, so a seam added here is
// installed wherever its flag is set.
//
// ⚠️ A FLAG IS STILL PER PROCESS. Installing from one table does not turn a seam
// on in the worker: the worker inherits the RUNNER's environment, not
// `webServer.env`, and `job-worker-process.ts` decides which flags it mirrors.
// That is deliberate — a seam whose fake keeps state IN MEMORY
// (`E2E_TEST_GITHUB_REPOS`' "created" map, `E2E_TEST_BLOB`'s object store) would
// be a SECOND, disagreeing fake in a second process. Mirror only a seam whose
// state lives in its control/journal files.
//
// The imports inside each `install` stay DYNAMIC: `instrumentation.ts` reaches
// this module only under `NEXT_RUNTIME === 'nodejs'`, and a production worker
// that sets no flag never loads `undici`'s mock machinery at all.

import type { MockAgent } from 'undici';

/**
 * One E2E boundary seam: the env flag that turns it on, the clause its boot
 * line completes, and the installer to run. `install` receives the shared
 * MockAgent; a seam that intercepts elsewhere (E2E_TEST_BLOB replaces the S3
 * client's transport) simply ignores it.
 */
export interface MockSeam {
  readonly flag: string;
  readonly message: string;
  readonly install: (agent: MockAgent) => Promise<void>;
}

export const E2E_MOCK_SEAMS: readonly MockSeam[] = [
  {
    flag: 'E2E_TEST_OAUTH',
    message: 'Google + GitHub + GitLab OAuth endpoints mocked.',
    install: async (agent) => {
      const { installGoogleTokenMock, installGithubOAuthMock, installGitlabOAuthMock } =
        await import('@/lib/test-oauth-mock');
      installGoogleTokenMock(agent);
      // GitHub identity grant (Story 7.10 · MOTIR-897): the server-side
      // code→token exchange + /user read the OAuth callback performs — same
      // env gate, same shared agent.
      installGithubOAuthMock(agent);
      // GitLab connect grant (Story 7.23 · MOTIR-1480): the server-side
      // code→token exchange + /api/v4/user read — same env gate, same shared agent.
      installGitlabOAuthMock(agent);
    },
  },
  {
    flag: 'E2E_TEST_BLOB',
    message: 'in-process object store installed.',
    install: async () => {
      const { installBlobStoreMock } = await import('@/lib/test-blob-mock');
      // No `agent` — this seam replaces the S3 client's transport, not undici's.
      installBlobStoreMock();
    },
  },
  {
    flag: 'E2E_TEST_BILLING',
    message: 'motir-ai billing seam mocked.',
    install: async (agent) => {
      const { installBillingBoundaryMock } = await import('@/lib/test-billing-mock');
      installBillingBoundaryMock(agent);
    },
  },
  {
    // ⚠️ BEFORE `E2E_TEST_GITHUB_REPOS`, and the order is load-bearing: both seams
    // answer `GET /repos/{owner}/{name}`, undici tries intercepts in registration
    // order, and this one claims only the repositories its control file names.
    flag: 'E2E_TEST_GITHUB_MERGE',
    message: 'GitHub merge + merge-queue API mocked.',
    install: async (agent) => {
      const { installGithubMergeMock } = await import('@/lib/test-github-merge-mock');
      installGithubMergeMock(agent);
    },
  },
  {
    flag: 'E2E_TEST_GITHUB_REPOS',
    message: 'GitHub repo creation + collaborator API mocked.',
    install: async (agent) => {
      const { installGithubReposMock } = await import('@/lib/test-github-repos-mock');
      installGithubReposMock(agent);
    },
  },
  {
    flag: 'E2E_TEST_CODE_HEALTH',
    message: 'motir-ai code-health seam mocked.',
    install: async (agent) => {
      const { installCodeHealthBoundaryMock } = await import('@/lib/test-code-health-mock');
      installCodeHealthBoundaryMock(agent);
    },
  },
  {
    flag: 'E2E_TEST_LESSONS',
    message: 'motir-ai lesson-library seam mocked.',
    install: async (agent) => {
      const { installLessonsBoundaryMock } = await import('@/lib/test-lessons-mock');
      installLessonsBoundaryMock(agent);
    },
  },
  {
    flag: 'E2E_TEST_AI_JOBS',
    message: 'motir-ai jobs seam mocked.',
    install: async (agent) => {
      const { installAiJobsBoundaryMock } = await import('@/lib/test-ai-jobs-mock');
      installAiJobsBoundaryMock(agent);
    },
  },
  {
    // ⚠️ THE ONE SEAM THE LANE TURNS ON IN THE WORKER ONLY (MOTIR-3564). The
    // boundary it stubs is crossed only by the index SUPERVISOR, which is a job,
    // so `tests/e2e/_helpers/job-worker-process.ts` gives the WORKER the flag and
    // no `webServer.env` sets it. (Before MOTIR-5837 the worker installed this
    // one seam by hand; it installs from this table now, like the server.)
    //
    // Setting `MOTIR_AI_URL` + `MOTIR_AI_SERVICE_TOKEN` on the APP server
    // would not be redundant, it would be wrong: `lib/ai/availability.ts`
    // reads exactly that pair process-wide, so it flips the whole lane
    // cloud-on and four specs assert the OFF state against this server.
    flag: 'E2E_TEST_CODE_GRAPH',
    message: 'index-writer seam mocked (run-credential mint + tarball redirect).',
    install: async (agent) => {
      const { installCodeGraphBoundaryMock } = await import('@/lib/test-code-graph-mock');
      installCodeGraphBoundaryMock(agent);
    },
  },
];

/**
 * Install every seam whose flag is set in THIS process, on ONE shared agent.
 * Returns the flags it installed, in table order; `log` receives each boot line
 * (`<FLAG> active — <message>`) so each process can prefix it with its own tag.
 *
 * The gate reads the SAME table the installs iterate, so every flag that can
 * install something can also open the gate (MOTIR-3244). No flag set ⇒ no
 * agent, and nothing is imported.
 */
export async function installE2EMockSeams(log: (line: string) => void): Promise<string[]> {
  const active = E2E_MOCK_SEAMS.filter((seam) => process.env[seam.flag] === '1');
  if (active.length === 0) return [];

  const { installSharedMockAgent } = await import('@/lib/test-mock-agent');
  const agent = installSharedMockAgent();

  for (const seam of active) {
    await seam.install(agent);
    log(`${seam.flag} active — ${seam.message}`);
  }
  return active.map((seam) => seam.flag);
}
