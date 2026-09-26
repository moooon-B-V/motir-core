// THE ROUTES A HOSTED RUN'S OWN CREDENTIAL MAY CALL (MOTIR-6557,
// `docs/decisions/hosted-run-runs-the-cli-as-the-app.md` §4).
//
// The container runs the CLI's own `motir run` / `motir continue`, so a run
// token must reach exactly what those commands call — for its run and its run's
// cards, and nothing else. This is the ONE list. Each route here sets
// `acceptsRunToken: true` on its `withV1Route`, and no route outside it does;
// `tests/hostedRuns/runTokenRouteTable.test.ts` holds both directions, and holds
// the list against the operations the CLI client actually calls on those paths.
//
// ⚠️ THE GRANT DOES NOT NARROW IT; THE BINDING DOES. Every route below asserts
// `project:browse` or `work_item:edit` — the two keys `HOSTED_RUN_TOKEN_GRANT`
// already holds — and a bare `work_item:edit` would reach every card in the
// project. What stops it is the `binding` column, enforced in the services:
//
//   own_run          — the path's `{id}` is the token's own run
//                      (`dispatchRunService`'s `assertRunTokenScope`).
//   run_cards        — every card the call touches is a LEG of the run or the
//                      run's SCOPE (`runTokenScopeService`, reached through
//                      `workItemsService.getWorkItemByIdentifier` and the few
//                      reads that resolve a card another way).
//   run_scope_claim  — a work-item scope (never a sprint) whose container and
//                      every member are the run's cards (`scopeClaimService`).
//   project          — a read of the run's own project; the token is bound to
//                      it (`ApiToken.projectId`, `projectAccessService`).
//   self             — the credential reading who it is. Nothing else.
//
// Pure data — a leaf module with no imports, safe for any layer and for tests.

export type RunTokenBinding = 'own_run' | 'run_cards' | 'run_scope_claim' | 'project' | 'self';

export interface RunTokenRoute {
  /** The `/api/v1` operation, or `null` for a route that has none (yet). */
  operationId: string | null;
  method: 'GET' | 'POST';
  /** The OpenAPI path, `{param}` form. */
  path: string;
  binding: RunTokenBinding;
  /** Who in the container calls it. */
  calledBy: 'cli' | 'git_credential_helper';
  /**
   * The card that builds the route, when it does not exist yet. The table test
   * requires the route file to exist — and to opt in — once this is absent.
   */
  pendingCard?: string;
}

export const RUN_TOKEN_ROUTES: readonly RunTokenRoute[] = [
  // Who the credential is — the CLI's `whoami`, for whom a claim assigns to.
  { operationId: 'getMe', method: 'GET', path: '/api/v1/me', binding: 'self', calledBy: 'cli' },

  // The run's project — the scope drain's edge read and the close-out's ready set.
  {
    operationId: 'getProjectReadySet',
    method: 'GET',
    path: '/api/v1/projects/{projectKey}/ready',
    binding: 'project',
    calledBy: 'cli',
  },
  {
    operationId: 'listProjectWorkItems',
    method: 'GET',
    path: '/api/v1/projects/{projectKey}/work-items',
    binding: 'project',
    calledBy: 'cli',
  },

  // The run's cards.
  {
    operationId: 'getWorkItem',
    method: 'GET',
    path: '/api/v1/work-items/{key}',
    binding: 'run_cards',
    calledBy: 'cli',
  },
  {
    operationId: 'listWorkItemDesigns',
    method: 'GET',
    path: '/api/v1/work-items/{key}/designs',
    binding: 'run_cards',
    calledBy: 'cli',
  },
  {
    operationId: 'getWorkItemDispatchPrompt',
    method: 'GET',
    path: '/api/v1/work-items/{key}/dispatch-prompt',
    binding: 'run_cards',
    calledBy: 'cli',
  },
  {
    operationId: 'getWorkItemHowToTest',
    method: 'GET',
    path: '/api/v1/work-items/{key}/how-to-test',
    binding: 'run_cards',
    calledBy: 'cli',
  },
  {
    operationId: 'claimWorkItem',
    method: 'POST',
    path: '/api/v1/work-items/{key}/claim',
    binding: 'run_cards',
    calledBy: 'cli',
  },
  {
    operationId: 'transitionWorkItem',
    method: 'POST',
    path: '/api/v1/work-items/{key}/transitions',
    binding: 'run_cards',
    calledBy: 'cli',
  },
  {
    operationId: 'recordWorkItemIntegration',
    method: 'POST',
    path: '/api/v1/work-items/{key}/integration',
    binding: 'run_cards',
    calledBy: 'cli',
  },
  {
    operationId: 'linkWorkItemPullRequest',
    method: 'POST',
    path: '/api/v1/work-items/{key}/pull-requests',
    binding: 'run_cards',
    calledBy: 'cli',
  },
  {
    operationId: 'completeSession',
    method: 'POST',
    path: '/api/v1/sessions/complete',
    binding: 'run_cards',
    calledBy: 'cli',
  },
  {
    operationId: 'claimScope',
    method: 'POST',
    path: '/api/v1/scope-claims',
    binding: 'run_scope_claim',
    calledBy: 'cli',
  },

  // The run itself.
  {
    operationId: 'appendDispatchRunEvents',
    method: 'POST',
    path: '/api/v1/dispatch-runs/{id}/events',
    binding: 'own_run',
    calledBy: 'cli',
  },
  {
    operationId: 'getDispatchRunCloseOutPrompt',
    method: 'GET',
    path: '/api/v1/dispatch-runs/{id}/close-out-prompt',
    binding: 'own_run',
    calledBy: 'cli',
  },
  {
    operationId: 'closeDispatchRun',
    method: 'POST',
    path: '/api/v1/dispatch-runs/{id}/close',
    binding: 'own_run',
    calledBy: 'cli',
  },
  {
    operationId: null,
    method: 'POST',
    path: '/api/v1/dispatch-runs/{id}/git-credential',
    binding: 'own_run',
    calledBy: 'git_credential_helper',
    pendingCard: 'MOTIR-6538',
  },
];

/**
 * Operations the CLI calls on a `motir run` path that a run token is DENIED,
 * each with why — so the table test can tell a deliberate refusal from drift.
 */
export const RUN_TOKEN_DENIED_CLI_OPERATIONS: Readonly<Record<string, string>> = {
  openDispatchRun:
    'the server opens a hosted run and the CLI adopts it (MOTIR-6558); a run token never opens one',
  listWorkspaces:
    "lists every workspace the dispatcher belongs to — beyond the run's own; the CLI's hosted mode resolves its owner from getMe alone (MOTIR-6558)",
  getWorkItemPlan: "`motir auto`'s plan approval — plans are not a run token's to read",
  approveWorkItemPlan: "`motir auto`'s plan approval — plans are not a run token's to decide",
  submitPlanSession:
    'the re-plan a scope run submits when its scope is refused as mis-shaped — plan authoring is not a run token’s; a hosted run reports the refusal instead',
  submitWorkItemExpansion:
    '`--include-planning` / `motir auto` expansion — an AI planning surface, never a hosted run',
};
