import type {
  DispatchCardDisposition,
  DispatchRunCardInput,
  DispatchRunEventInput,
  DispatchSkipReason,
  DispatchStopReason,
  MotirClient,
} from './client.js';

// THE DISPATCH RUN REPORTER (Story MOTIR-1789 · MOTIR-1794) — what turns a local
// run into a watchable object, built to `docs/decisions/dispatch-run-record.md`.
//
// ── ITS MOST IMPORTANT PROPERTY IS WHAT IT REFUSES TO BREAK ────────────────
// A person running `motir auto` overnight is doing REAL WORK; the run record is
// an OBSERVATION of that work. If a flaky network, an expired token or a 500
// could abort a dispatch, move a card's status or change an exit code, the
// feature would have made the product less reliable in exchange for a nicer
// page — and the first time it happened nobody would trust it again.
//
// So: **every method here swallows its own failure.** Nothing throws, nothing
// returns a rejected promise, and no caller is ever asked to handle a reporting
// error. That is the side-effect-failure-must-not-fail-the-request rule, applied
// client-side. `tests/dispatchRunReporter.test.ts` drives it with a client that
// throws on every call and asserts each method still resolves.
//
// ── OFFLINE IS A FIRST-CLASS STATE, NOT AN ERROR ──────────────────────────
// On the FIRST failure the reporter prints ONE warning naming that run reporting
// is off for this session and stops trying for the rest of the run. A warning
// per event would bury the agent's own output — which is the thing the operator
// is actually watching — under telemetry noise, and the second failure tells
// them nothing the first did not.
//
// ── IT READS NOTHING (MOTIR-3204) ─────────────────────────────────────────
// Every fact it sends is ALREADY in the process: the claim's answer, the frozen
// snapshot, the dispatch payload, the agent's exit, the CI verdict the watch
// already read. The CLI's run shape is pinned by guards — one fresh agent
// process per card, NO ready query after the claim — and a reporter that quietly
// ran a query to draw a nicer picture would trade the run's correctness for the
// page's completeness. If a payload this wants is not in hand, that is a finding
// for the ingest's shape, never a new query here.

/**
 * How many events the queue holds before it starts dropping.
 *
 * ⚠️ BOUNDED, AND IT DROPS THE OLDEST. An unbounded buffer on a machine whose
 * network is down is a memory leak that grows for as long as the run does —
 * which on `motir auto` is hours. Dropping the oldest keeps the tail, and the
 * tail is the half an operator opens a run page for.
 */
export const REPORTER_QUEUE_LIMIT = 500;

/** How many events one flush sends. Matches the ingest's own batch ceiling. */
export const REPORTER_BATCH_LIMIT = 200;

/** The one warning, printed once per session on the first failure. */
export const REPORTER_OFFLINE_WARNING =
  'motir: run reporting is unavailable — this run will not appear in Motir. ' +
  'The run itself is unaffected.';

/** What a command hands the reporter when it opens a run. */
export interface OpenDispatchRunInput {
  projectKey: string;
  command: 'next' | 'run' | 'run_scope' | 'batch' | 'auto';
  /** `runIdFromDate`'s id — carried, never re-minted. */
  runId: string;
  /**
   * The SET, in the run's own order. EMPTY for `motir auto`, which holds no
   * plan and appends a leg per iteration — materialising a list to report would
   * break the property that loop exists to have.
   */
  cards: DispatchRunCardInput[];
  scopeKey?: string;
  scopeLabel?: string;
  agent?: string;
  model?: string;
}

export interface DispatchRunReporter {
  /** Open the run. Safe to call once; a second call is ignored. */
  open(input: OpenDispatchRunInput): Promise<void>;
  /** Append a leg mid-run — `motir auto`'s per-iteration discovery. */
  addCard(card: DispatchRunCardInput): Promise<void>;
  /** Queue one event. Never awaits the network; never throws. */
  event(event: DispatchRunEventInput): void;
  /** Send whatever is queued. Never throws. */
  flush(): Promise<void>;
  /** Flush, then close the run with its stop reason. Never throws. */
  close(stopReason: DispatchStopReason): Promise<void>;
  /** True once a failure has taken reporting down for this session. */
  readonly offline: boolean;
  /** The run this reporter opened, or null when it never opened one. */
  readonly runId: string | null;
  /**
   * Whether the operator asked for log BODIES (`--report-log`).
   *
   * ⚠️ THIS IS NOT A SECOND PRIVACY CHECK, and it must never become one. The
   * strip stays in {@link DispatchRunReporter.event} — one place, so a call
   * site that forgot cannot leak. This flag answers a different question, for
   * the PRODUCER side: is it worth CAPTURING the agent's output at all? With
   * the opt-in off the answer is no, because every body captured would be
   * stripped a moment later, so `agentLogTee` reads this to skip the work
   * rather than to decide the policy.
   */
  readonly wantsLogBodies: boolean;
}

export interface DispatchRunReporterDeps {
  client: Pick<MotirClient, 'openDispatchRun' | 'appendDispatchRunEvents' | 'closeDispatchRun'>;
  /** Where the single offline warning goes. `console.error` in production. */
  warn?: (message: string) => void;
  /**
   * Whether to send opt-in LOG BODIES (ADR Q4).
   *
   * ⚠️ DEFAULT FALSE, and the default is the promise. A BYOK run executes on the
   * operator's own machine, against a checkout Motir has never seen, under a key
   * Motir does not hold — its log carries file paths, source excerpts, error
   * output and possibly environment secrets. With this off, `body` is STRIPPED
   * from every event before it leaves the process, which is why the stripping
   * happens here rather than at each call site: a call site that forgot would
   * leak, and there are dozens of them.
   */
  reportLogBodies?: boolean;
}

/**
 * A reporter that does NOTHING, successfully.
 *
 * The default everywhere, so wiring the reporter into a pipeline is not a
 * behaviour change until a command opens a run, and so every existing test that
 * calls those pipelines keeps passing without learning about run reporting.
 */
export const nullDispatchRunReporter: DispatchRunReporter = {
  async open() {},
  async addCard() {},
  event() {},
  async flush() {},
  async close() {},
  offline: false,
  runId: null,
  wantsLogBodies: false,
};

export function createDispatchRunReporter(deps: DispatchRunReporterDeps): DispatchRunReporter {
  const warn = deps.warn ?? ((message: string) => console.error(message));
  const queue: DispatchRunEventInput[] = [];
  let runId: string | null = null;
  /** The open call's own arguments, kept so `addCard` can re-issue it. */
  let opened: OpenDispatchRunInput | null = null;
  let offline = false;
  /** Serialises flushes, so two callers cannot interleave a batch's order. */
  let inFlight: Promise<void> = Promise.resolve();

  /** Take the reporter down for the rest of the session, once, with one line. */
  function goOffline(): void {
    if (offline) return;
    offline = true;
    queue.length = 0;
    warn(REPORTER_OFFLINE_WARNING);
  }

  /**
   * Run one reporting call, swallowing everything.
   *
   * ⚠️ THE `catch` IS THE FEATURE. Every failure mode a headless machine has —
   * a 500, a timeout, an expired PAT, no network at all — arrives here, and all
   * of them mean the same thing to the run: keep going.
   */
  async function attempt(fn: () => Promise<void>): Promise<void> {
    if (offline) return;
    try {
      await fn();
    } catch {
      goOffline();
    }
  }

  return {
    get offline() {
      return offline;
    },
    get runId() {
      return runId;
    },
    // Read by the PRODUCER side (`agentLogTee`) to decide whether capturing the
    // agent's output is worth doing. The strip below is still the only thing
    // that decides whether a body LEAVES.
    wantsLogBodies: deps.reportLogBodies === true,

    async open(input) {
      if (runId !== null) return;
      await attempt(async () => {
        const result = await deps.client.openDispatchRun({
          projectKey: input.projectKey,
          command: input.command,
          // ⚠️ THE RUN'S OWN ID, CARRIED. `runIdFromDate` already produced it,
          // `sessionBranchName` derives the branch from it and the session
          // pull-request body prints it — so a reviewer's branch, the pull
          // request they read and the run row in Motir all name the same run.
          // A second identity minted here would be a second answer to "which run
          // was this?".
          idempotencyKey: input.runId,
          cards: input.cards,
          ...(input.scopeKey === undefined ? {} : { scopeKey: input.scopeKey }),
          ...(input.scopeLabel === undefined ? {} : { scopeLabel: input.scopeLabel }),
          ...(input.agent === undefined ? {} : { agent: input.agent }),
          ...(input.model === undefined ? {} : { model: input.model }),
        });
        runId = result.runId;
        opened = input;
      });
    },

    async addCard(card) {
      const input = opened;
      if (runId === null || input === null) return;
      // ⚠️ A LEG IS APPENDED THROUGH THE **OPEN**, not through an event.
      //
      // `motir auto` holds no plan and discovers its set one card per iteration,
      // so its legs necessarily arrive after the run does — and the open is the
      // ONLY operation that takes a card set at all. An EVENT may never add a
      // card to a run, because the set IS the plan the run published; letting it
      // grow behind that plan would defeat the record.
      //
      // Re-issuing the open is safe precisely because it is idempotent on
      // `idempotencyKey`: the server finds the run it already has and adds the
      // leg. That is the same mechanism that makes a RETRY safe, used on purpose
      // rather than borrowed.
      await attempt(async () => {
        await deps.client.openDispatchRun({
          projectKey: input.projectKey,
          command: input.command,
          idempotencyKey: input.runId,
          cards: [card],
        });
      });
    },

    event(event) {
      if (offline || runId === null) return;
      // The opt-in, enforced HERE rather than at each call site: a site that
      // forgot would leak, and there are dozens of them.
      const scrubbed: DispatchRunEventInput = deps.reportLogBodies
        ? event
        : (({ body: _body, ...rest }) => rest)(event);
      queue.push(scrubbed);
      // Drop the OLDEST, so the tail survives — the half an operator opens a run
      // page for.
      while (queue.length > REPORTER_QUEUE_LIMIT) queue.shift();
    },

    async flush() {
      const id = runId;
      if (offline || id === null || queue.length === 0) return;
      const send = inFlight.then(async () => {
        while (!offline && queue.length > 0) {
          const batch = queue.splice(0, REPORTER_BATCH_LIMIT);
          await attempt(() =>
            deps.client.appendDispatchRunEvents({ runId: id, events: batch }).then(() => undefined),
          );
        }
      });
      inFlight = send;
      await send;
    },

    async close(stopReason) {
      const id = runId;
      if (id === null) return;
      await this.flush();
      await attempt(() => deps.client.closeDispatchRun({ runId: id, stopReason }));
    },
  };
}

/** The leg dispositions a verdict maps to, so no call site invents one. */
export const DISPOSITION: Record<string, DispatchCardDisposition> = {
  claimed: 'running',
  integrated: 'integrated',
  implemented: 'implemented',
  failed: 'failed',
  replanned: 'replanned',
};

/** The skip reasons the CLI's own vocabularies map to, one for one. */
export type ReporterSkipReason = DispatchSkipReason;
