// Next.js instrumentation hook (Next 13.4+).
//
// Runs ONCE per Node.js server boot, before any handler runs. The default
// build does nothing; the only side effects are env-gated E2E seams:
//
//   - E2E_TEST_OAUTH=1 → lib/test-oauth-mock intercepts outbound HTTPS calls
//     to Google's OAuth token endpoint and returns a synthetic id_token, so
//     Playwright drives the real Better-Auth callback handler end-to-end
//     without leaving localhost.
//   - E2E_TEST_BLOB=1 → lib/test-blob-mock installs an IN-PROCESS object store
//     at the S3 SDK's transport seam, so the attachments E2E journey performs
//     real uploads through the real route without a real blob store (CI runs
//     placeholder credentials by design). NOTE this one does NOT use the shared
//     undici agent below: undici's dispatcher governs `fetch`, and the AWS SDK
//     transports over `node:https`, so an intercept there cannot see it — see
//     that module's header (MOTIR-2389).
//   - E2E_TEST_BILLING=1 → lib/test-billing-mock intercepts the motir-ai billing
//     seam (the MOTIR_AI_URL origin's /v1/usage + /v1/stripe/*) and returns
//     synthetic plan/usage state + hosted session URLs, so the billing journeys
//     (checkout / paywall / portal) drive the real surfaces with no live Stripe
//     and no motir-ai instance (Subtask 8.1.10's dedicated cloud-on E2E lane).
//   - E2E_TEST_CODE_HEALTH=1 → lib/test-code-health-mock intercepts the motir-ai
//     code-health seam (the MOTIR_AI_URL origin's /v1/code-audit,
//     /v1/convention and /v1/code-context/refresh) and answers from a JSON
//     fixture, so the audit-coverage journey (MOTIR-2244) can drive the
//     SERVER-rendered /code-health page — which a browser `page.route` cannot
//     reach — with no motir-ai instance.
//   - E2E_TEST_LESSONS=1 → lib/test-lessons-mock intercepts the motir-ai LESSON
//     LIBRARY seam (the MOTIR_AI_URL origin's GET /v1/lessons and
//     /v1/lessons/:id) and answers from a JSON fixture, so MOTIR-3340 can drive
//     the SERVER-rendered library — which a browser `page.route` cannot reach —
//     with no motir-ai instance. A TRANSPORT mock: the real client and the real
//     permission-asserting service both stay in the path.
//   - E2E_TEST_AI_JOBS=1 → lib/test-ai-jobs-mock intercepts the motir-ai JOBS
//     seam (the MOTIR_AI_URL origin's POST /v1/jobs, GET /v1/jobs/:id and its
//     /stream). The ask journey crosses that seam three times and only the
//     stream RELAY is browser-visible, so a `page.route` stub would have to fake
//     the answer — and an answer the browser faked was never written, which is
//     precisely what MOTIR-1823's reload step has to prove.
//
//   - E2E_TEST_GITHUB_REPOS=1 → lib/test-github-repos-mock intercepts the
//     repo-PROVISIONING and COLLABORATOR calls to api.github.com (create, the
//     readiness read, the CI stub, the admin invite), so the repository-set
//     journey (MOTIR-1785) drives the real establish + access paths end to end
//     and NO REAL REPOSITORY IS EVER CREATED by the suite.
//
// All mocks share ONE undici MockAgent (lib/test-mock-agent) installed as
// the global dispatcher — installing two agents would silently disconnect
// the first mock's intercepts (only the last setGlobalDispatcher wins).
//
// Each seam above is ONE record in the `MOCKS` table inside `register()`: its
// flag, what it installs, and the line it prints at boot. The early return is
// DERIVED from that table rather than re-listing the flags, because re-listing
// them is what broke: `E2E_TEST_AI_JOBS` was read into a local and then left
// out of a hand-copied five-of-six enumeration, so a lane that set only that
// flag returned before the shared agent was installed and the jobs seam never
// registered — silently, and several layers from where it surfaced
// (MOTIR-3244). A seam added to the table now cannot be half-wired: there is
// no second list to forget it in.
//
// Why dynamic import to separate modules: Next compiles instrumentation.ts
// for BOTH Node and Edge runtimes. A static `import 'undici'` or
// `import 'node:crypto'` at the top of this file would make the Edge
// bundler emit "node module in edge runtime" errors. Dynamic-importing the
// node-only helpers from inside an `if (NEXT_RUNTIME === 'nodejs')` block
// hides those imports from the edge analysis entirely.
//
// Production safety: the env-gates keep these code paths completely dormant
// outside the Playwright run — `register()` returns immediately when neither
// flag is set.

/**
 * One E2E boundary seam: the env flag that turns it on, the clause its boot
 * line completes, and the installer to run. `install` receives the shared
 * MockAgent; a seam that intercepts elsewhere (E2E_TEST_BLOB replaces the S3
 * client's transport) simply ignores it.
 */
interface MockSeam {
  readonly flag: string;
  readonly message: string;
  readonly install: (agent: SharedMockAgent) => Promise<void>;
}

/**
 * The agent `installSharedMockAgent()` hands back. Written as a type-position
 * import so no value-level `undici` import reaches the Edge bundler — the same
 * reason every import below is dynamic.
 */
type SharedMockAgent = ReturnType<typeof import('@/lib/test-mock-agent').installSharedMockAgent>;

export async function register() {
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') return;

  const MOCKS: readonly MockSeam[] = [
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
  ];

  // The gate reads the SAME table the installs below iterate, so every flag
  // that can install something can also open the gate (MOTIR-3244).
  const active = MOCKS.filter((seam) => process.env[seam.flag] === '1');
  if (active.length === 0) return;

  const { installSharedMockAgent } = await import('@/lib/test-mock-agent');
  const agent = installSharedMockAgent();

  for (const seam of active) {
    await seam.install(agent);
    // eslint-disable-next-line no-console -- instrumentation boot is the right place for this signal
    console.log(`[INSTRUMENT] ${seam.flag} active — ${seam.message}`);
  }
}
