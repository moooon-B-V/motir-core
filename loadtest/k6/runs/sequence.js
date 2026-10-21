// ONE CONTAINER-LESS `motir run <KEY>`, AS A REQUEST PLAN (Story MOTIR-8538 · MOTIR-8676).
//
// The HTTP calls a single-card `motir run` makes, in the order it makes them, for
// the leg that ends the way a real run ends when its agent exits WITHOUT PUSHING
// (the `nothing_pushed` arm, MOTIR-3004). Read from the CLI as it ships:
//
//   packages/cli/src/commands/dispatch.ts:992  runCommand
//     :1043  resolveScopeTarget → GET work-items/{key}            (step read)
//     :1248  resolveOwnerId → GET /me + GET /workspaces           (step read)
//     :1252  ensureInProgress → POST work-items/{key}/claim       (step claim)
//            any outcome but claimed/mine ends the command here (:1253-1259)
//     :1261  GET work-items/{key}/dispatch-prompt                 (step prompt)
//   dispatch.ts:384  deliver
//     :505   reporter.open → POST /dispatch-runs                  (step open)
//            dispatchRunReporter.ts:243-268 beats AT OPEN          (step heartbeat)
//     :516   run_opened, flushed on enqueue                       (step events)
//   packages/cli/src/dispatchLeg.ts:149  runDispatchLeg
//     :172   checkout_ready, flushed on enqueue                   (step events)
//     :194   prompt_issued; :196 agent_started — batched to the next beat
//     :223   materializeDesignsFor → GET work-items/{key}/designs (step read)
//            the agent works; every RUN_HEARTBEAT_INTERVAL_MS the reporter
//            flushes its queue and beats (dispatchRunReporter.ts:247)
//     :232   agent_exited (exitCode 0)
//     :254   agentSubmittedReplan → GET work-items/{key}         (step read)
//     :257   workReachedRemote === 'nothing' → leg_verdict nothing_pushed,
//            with NO disposition (:160-164 sets one only for the failure arms)
//   dispatch.ts:600-606  reporter.close('completed'): flush, then
//            POST /dispatch-runs/{id}/close {stopReason:'completed'} (step close)
//
// That arm sends no transition, no card_settled, no run_closed (the leaf path
// closes through the endpoint), no delivery_linked and no ci_verdict. The server
// derives the run status from `completed` and settles the still-`running` leg as
// `failed` (dispatchRunService.ts `statusForStopReason`, `settledDisposition`).
// The card stays In Progress from the claim — which is why the scenario recycles
// it (step recycle), with two calls the CLI never makes: they are excluded from
// every run-lifecycle threshold.
//
// No agent `log` event is sent by default: the reporter strips bodies unless
// `--report-log`, and with stripping on the leg's log tee is never created
// (agentLogTee.ts:97-105). `logEventsPerBeat` adds stripped `log` events for a
// profile that wants the `--report-log` event volume; it never sends a body.
//
// PURE (no k6 import): vitest validates every body against the server's own zod
// schemas, and the profile imports `requestsPerIteration`.

/** The operations, by v1 operation id. A test pins each to `findV1Operation`. */
export const RUN_OPERATIONS = Object.freeze({
  getMe: { method: 'GET', path: '/api/v1/me' },
  listWorkspaces: { method: 'GET', path: '/api/v1/workspaces' },
  getWorkItem: { method: 'GET', path: '/api/v1/work-items/{key}' },
  claimWorkItem: { method: 'POST', path: '/api/v1/work-items/{key}/claim' },
  getWorkItemDispatchPrompt: { method: 'GET', path: '/api/v1/work-items/{key}/dispatch-prompt' },
  listWorkItemDesigns: { method: 'GET', path: '/api/v1/work-items/{key}/designs' },
  openDispatchRun: { method: 'POST', path: '/api/v1/dispatch-runs' },
  heartbeatDispatchRun: { method: 'POST', path: '/api/v1/dispatch-runs/{id}/heartbeat' },
  appendDispatchRunEvents: { method: 'POST', path: '/api/v1/dispatch-runs/{id}/events' },
  closeDispatchRun: { method: 'POST', path: '/api/v1/dispatch-runs/{id}/close' },
  updateWorkItem: { method: 'PATCH', path: '/api/v1/work-items/{key}' },
  transitionWorkItem: { method: 'POST', path: '/api/v1/work-items/{key}/transitions' },
});

/** The `step` tag of each operation. */
export const STEP_OF = Object.freeze({
  getMe: 'read',
  listWorkspaces: 'read',
  getWorkItem: 'read',
  claimWorkItem: 'claim',
  getWorkItemDispatchPrompt: 'prompt',
  listWorkItemDesigns: 'read',
  openDispatchRun: 'open',
  heartbeatDispatchRun: 'heartbeat',
  appendDispatchRunEvents: 'events',
  closeDispatchRun: 'close',
  updateWorkItem: 'recycle',
  transitionWorkItem: 'recycle',
});

export const STEPS = Object.freeze([
  'read',
  'claim',
  'prompt',
  'open',
  'heartbeat',
  'events',
  'close',
  'recycle',
]);

/** dispatchRunReporter.ts `FLUSH_ON_ENQUEUE`, restated (a test pins it). */
export const FLUSH_ON_ENQUEUE = Object.freeze(['run_opened', 'checkout_ready']);
/** dispatchRunReporter.ts `RUN_HEARTBEAT_INTERVAL_MS`, restated. */
export const RUN_HEARTBEAT_INTERVAL_MS = 60_000;
/** dispatchRunReporter.ts `REPORTER_BATCH_LIMIT`, restated. */
export const REPORTER_BATCH_LIMIT = 200;

/** The `agent` a load-test run reports (the CLI sends `agent.parsed.binary`). */
export const LOADTEST_AGENT = 'loadtest';
/** dispatch.ts:604 — the stop reason the leaf path closes with. */
export const NO_PUSH_STOP_REASON = 'completed';
/** The status the run pool is seeded at, and recycled back to. */
export const SEEDED_STATUS = 'todo';

/** A concrete path for an operation: `{key}` / `{id}` substituted. */
export function pathFor(op, params = {}) {
  const def = RUN_OPERATIONS[op];
  if (!def) throw new Error(`unknown run operation: ${op}`);
  return def.path.replace(/\{(\w+)\}/g, (_, name) => {
    const v = params[name];
    if (v === undefined || v === null) throw new Error(`${op}: missing path param ${name}`);
    return encodeURIComponent(String(v));
  });
}

/** One iteration's idempotency key — unique per VU, iteration and start time. */
export function idempotencyKey(vu, iteration, epochMs) {
  return `lt-${vu}-${iteration}-${epochMs}`;
}

export function openBody({ projectKey, key, idempotencyKey: idem }) {
  return {
    projectKey,
    command: 'run',
    origin: 'local',
    idempotencyKey: idem,
    cards: [{ key, disposition: 'queued' }],
    agent: LOADTEST_AGENT,
  };
}

export function closeBody() {
  return { stopReason: NO_PUSH_STOP_REASON };
}

/** The leg's events, as `runDispatchLeg` builds them on the nothing_pushed arm. */
export const RUN_EVENTS = Object.freeze({
  runOpened: (key) => ({ kind: 'run_opened', data: { command: 'run', key } }),
  checkoutReady: (key, repository) => ({
    kind: 'checkout_ready',
    workItemKey: key,
    data: { repositories: repository ? [repository] : [], failures: 0, branch: null, branches: [] },
  }),
  promptIssued: (key) => ({ kind: 'prompt_issued', workItemKey: key }),
  agentStarted: (key) => ({
    kind: 'agent_started',
    workItemKey: key,
    disposition: 'running',
    data: { agent: LOADTEST_AGENT },
  }),
  log: (key) => ({ kind: 'log', workItemKey: key }),
  agentExited: (key) => ({
    kind: 'agent_exited',
    workItemKey: key,
    exitCode: 0,
    model: null,
    data: { model: null, signal: null },
  }),
  legVerdict: (key) => ({
    kind: 'leg_verdict',
    workItemKey: key,
    data: { kind: 'nothing_pushed' },
  }),
});

/** Split a queue into append bodies of at most `REPORTER_BATCH_LIMIT` events. */
export function batches(events) {
  const out = [];
  for (let i = 0; i < events.length; i += REPORTER_BATCH_LIMIT) {
    out.push({ events: events.slice(i, i + REPORTER_BATCH_LIMIT) });
  }
  return out;
}

/**
 * The plan for one iteration, split at the run open (whose `id` the later
 * requests need):
 *
 *   `before` — me, workspaces, read, claim, prompt (the claim's answer decides
 *              whether the rest runs)
 *   `open`   — the open request
 *   `after`  — every request after the open, in order, each `{ op, step, params,
 *              body?, atMs }`; `atMs` is when it is sent, measured from the open
 *              (the agent's working time is the gap between the designs read
 *              and the replan read). `params.id` is filled from the open's answer.
 *
 * `options`: `{ key, projectKey, repository, agentSeconds, logEventsPerBeat,
 * recycle, idempotencyKey }`.
 */
export function planIteration(options) {
  const { key, projectKey, repository = null, recycle = true } = options;
  const agentMs = Math.max(0, Math.round((options.agentSeconds ?? 0) * 1000));
  const logsPerBeat = Math.max(0, Math.floor(options.logEventsPerBeat ?? 0));
  const req = (op, extra = {}) => ({ op, step: STEP_OF[op], params: { key }, ...extra });

  const before = [
    req('getMe', { params: {} }),
    req('listWorkspaces', { params: {} }),
    req('getWorkItem'),
    req('claimWorkItem'),
    req('getWorkItemDispatchPrompt'),
  ];
  const open = req('openDispatchRun', {
    params: {},
    body: openBody({ projectKey, key, idempotencyKey: options.idempotencyKey }),
  });

  const after = [];
  const append = (events, atMs) => {
    for (const body of batches(events)) after.push(req('appendDispatchRunEvents', { body, atMs }));
  };
  // Beat at open, then the two flush-on-enqueue events, each in its own batch.
  after.push(req('heartbeatDispatchRun', { atMs: 0 }));
  append([RUN_EVENTS.runOpened(key)], 0);
  append([RUN_EVENTS.checkoutReady(key, repository)], 0);
  // Batched until the next beat or the close.
  let queue = [RUN_EVENTS.promptIssued(key), RUN_EVENTS.agentStarted(key)];
  after.push(req('listWorkItemDesigns', { atMs: 0 }));

  // The agent works: each interval, the queue is flushed and the run beats.
  for (let t = RUN_HEARTBEAT_INTERVAL_MS; t <= agentMs; t += RUN_HEARTBEAT_INTERVAL_MS) {
    for (let i = 0; i < logsPerBeat; i += 1) queue.push(RUN_EVENTS.log(key));
    if (queue.length > 0) append(queue, t);
    queue = [];
    after.push(req('heartbeatDispatchRun', { atMs: t }));
  }

  // The agent exits 0; the replan check; nothing reached the remote.
  queue.push(RUN_EVENTS.agentExited(key));
  after.push(req('getWorkItem', { atMs: agentMs }));
  queue.push(RUN_EVENTS.legVerdict(key));
  append(queue, agentMs);
  after.push(req('closeDispatchRun', { body: closeBody(), atMs: agentMs }));

  if (recycle) {
    after.push(req('updateWorkItem', { body: { assigneeId: null }, atMs: agentMs }));
    after.push(req('transitionWorkItem', { body: { status: SEEDED_STATUS }, atMs: agentMs }));
  }
  return { before, open, after };
}

/** Every request of an iteration, in order (the claim answered claimed/mine). */
export function iterationRequests(options) {
  const plan = planIteration(options);
  return [...plan.before, plan.open, ...plan.after];
}

/**
 * Requests one full iteration makes — the number the per-token rate is computed
 * from. The run command owns the check (it reads MOTIR_API_V1_RATE_LIMIT back).
 */
export function requestsPerIteration({ agentSeconds, recycle = true, logEventsPerBeat = 0 }) {
  return iterationRequests({
    key: 'X-1',
    projectKey: 'X',
    agentSeconds,
    recycle,
    logEventsPerBeat,
    idempotencyKey: 'x',
  }).length;
}

/**
 * The run-pool cards a VU owns: a disjoint slice of its project's pool, by the
 * VU's position among the project's run agents. Empty when the pool has fewer
 * cards than run agents — never another VU's card.
 */
export function runSlice(manifest, agent) {
  const project = manifest.projects.find((p) => p.id === agent.projectId);
  if (!project) return [];
  const peers = manifest.agents.filter((a) => a.role === 'run' && a.projectId === agent.projectId);
  const pos = peers.findIndex((a) => a.tokenId === agent.tokenId);
  if (pos < 0) return [];
  return project.pools.run.filter((_, i) => i % peers.length === pos);
}
