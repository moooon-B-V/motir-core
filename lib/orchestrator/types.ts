import type { FleetWorkloadKind } from '@/lib/ciFleet/workloads';

// The CONTAINER-ORCHESTRATOR PORT (Story MOTIR-1916 · MOTIR-1921) —
// `docs/decisions/ci-runner-fleet.md` §4 and §5, transcribed into the codebase
// as the seam every fleet card codes against.
//
// The ADR calls this "the single most load-bearing output: it is what makes this
// decision reversible." NO PROVIDER TYPE CROSSES THIS BOUNDARY. The webhook
// handler (MOTIR-1920), the gate (MOTIR-1922), the provisioner (this card) and
// the meter (MOTIR-1924) see `ContainerHandle` and `ContainerUsage` only — never
// a Fly Machine id, an EC2 instance type or a pod spec. `tests/ciFleet/
// orchestratorPortBoundary.test.ts` asserts that as a dependency guard rather
// than leaving it to convention, because a convention is exactly what erodes
// when a second adapter is a year away.
//
// ⚠️ THE ONE NON-OBVIOUS DECISION, AND THE POINT OF THE PORT: `teardown` and
// `reap` RETURN the usage record (§4). Metering is not a separate call a caller
// can forget — YOU CANNOT DESTROY A CONTAINER WITHOUT PRODUCING ITS COST ROW.
// That is `notes.html` #185 applied at the type level: the meter is built on a
// PHYSICAL quantity emitted by the same operation that guarantees teardown, so
// the two cannot drift, and MOTIR-1924's meter cannot be silently skipped by a
// path that tears down and returns early.

// ⚠️ THE PORT CARRIES A WORKLOAD (MOTIR-2025). It shipped with exactly one
// consumer and was shaped like it: a spec could only describe a CI runner, and a
// status could not say why a container stopped. `code-graph-index-fleet.md` §2
// makes indexing the SECOND consumer, and §11 records that an index container
// has no GitHub job at all — "no runner registers, no `runs-on` resolves, no
// `workflow_job` fires" — so it could only have filled `workflowJobId` by
// inventing a number, which would name the machine `motir-runner-<a lie>` and
// tag it as a CI runner in the Fly console and to the reaper.
//
// So the spec NAMES its workload and `workflowJobId` is nullable. The database
// was already there and already said why: `CiContainerUsage.workflowJobId` is
// `String?` with the comment "NULLABLE because only a CI container has one". The
// column anticipated this; the TypeScript did not.

/** Which implementation is behind the port. `fake` is a first-class member, not
 *  a test artifact: §4's rule 2 requires it to ship alongside the Fly adapter,
 *  because a port with one implementation has never been shown to be a port. */
export type OrchestratorProvider = 'fly' | 'runs_on' | 'arc' | 'fake';

/**
 * The machine class. Fixed by `ci-minutes-allowance.md` §M to be
 * Linux-2-core-EQUIVALENT — GitHub's `ubuntu-latest` on a PRIVATE repository is
 * 2 vCPU / 8 GB, and the ×1.00 multiplier is a parity PROMISE rather than a
 * measurement of whatever hardware was convenient.
 *
 * `performance`, not `shared`, is a product decision (ADR §8): the customer is
 * metered on WALL CLOCK, so a runner suffering CPU steal costs the customer more
 * billed minutes AND Motir more container-seconds — the same slowdown paid for
 * twice.
 */
export interface ContainerSize {
  readonly cpuKind: 'shared' | 'performance';
  readonly cpus: number;
  readonly memoryMb: number;
}

/** What to run. Provider-neutral: no Fly Machine config, no EC2 instance type. */
export interface ContainerSpec {
  /** Attribution, resolved BEFORE provisioning (the gate needs it too). */
  readonly orgId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly repoFullName: string;
  /**
   * WHAT this container is, from the fleet's own registry
   * (`lib/ciFleet/workloads.ts`). MOTIR-1997 declared `code_graph_index` and
   * `hosted_agent` on that union BEFORE either shipped, precisely so a new
   * workload would be COUNTED rather than discovered; the same reasoning applies
   * one layer down, to how the container is NAMED and TAGGED at the provider.
   *
   * The adapter derives the machine's name and its fleet metadata from this, so
   * an index container is recognisable in the provider's console — and to
   * `reap()` — as what it actually is.
   */
  readonly workload: FleetWorkloadKind;
  /**
   * The GitHub job this container exists to serve. One job, one container.
   *
   * NULL for every workload that is not a CI runner. An index or agent container
   * is dispatched straight onto this port and never touches Actions, so there is
   * no job id to carry — and inventing one to satisfy the type would make the
   * container unattributable at the provider.
   */
  readonly workflowJobId: number | null;
  /** OCI image ref for the runner image (digest-pinned, never a tag). */
  readonly image: string;
  /** Linux-2-core-EQUIVALENT is fixed by ci-minutes-allowance.md §M. */
  readonly size: ContainerSize;
  /** Injected at boot; never baked into the image. Carries the JIT config. */
  readonly env: Readonly<Record<string, string>>;
  /** Hard kill after this many seconds, whatever the container is doing. */
  readonly timeoutSeconds: number;
  readonly region: string;
}

/** An opaque, provider-agnostic reference. Persisted; survives a process restart.
 *  That persistence is what makes the reaper possible: a crashed orchestrator
 *  leaves the handle on the intent row, and the sweeper reads it back. */
export interface ContainerHandle {
  readonly provider: OrchestratorProvider;
  /** Fly Machine id; EC2 instance id; pod name. Opaque above the adapter. */
  readonly id: string;
  readonly region: string;
  readonly createdAt: Date;
}

/**
 * Why a container was destroyed. Recorded on the usage row, because "how did
 * this container end" is the question the fleet's operational story is made of
 * and it is unanswerable after the fact from a timestamp alone.
 */
export type TeardownReason =
  | 'job_completed'
  | 'job_timed_out'
  | 'provision_failed'
  | 'gate_revoked'
  | 'reaped'; // the orchestrator crashed; the sweeper found it

/**
 * Provider-truth status, for the reaper and for diagnostics (§4's `describe`).
 *
 * `exists: false` is a REAL answer, not an error: `auto_destroy` means the happy
 * path ends with the machine deleting itself, so "gone" is the expected terminal
 * observation rather than a failure to observe.
 */
export interface ContainerStatus {
  readonly handleId: string;
  readonly exists: boolean;
  /** The provider's own state string (`created` / `started` / `stopped` /
   *  `destroyed` on Fly). Empty when the container is already gone. */
  readonly state: string;
  /** True once the container has run and stopped, or is gone entirely. */
  readonly terminal: boolean;
  readonly createdAt: Date | null;
  readonly startedAt: Date | null;
  readonly stoppedAt: Date | null;
  /**
   * The container's own exit status, when the provider still reports one.
   *
   * ⚠️ FOR A CI RUNNER THIS CARRIED NO INFORMATION — the runner reports to
   * GitHub, so Motir never needed to know how the process ended. FOR AN INDEX
   * CONTAINER IT IS THE ENTIRE DIAGNOSTIC CHANNEL: the container writes no
   * ledger row and its logs are the operator's, so the dispatcher sees a machine
   * that stopped and a number. `motir-ai`'s indexer image spends a whole
   * taxonomy on it (`src/indexer/exitCodes.ts`: `10` CONFIG · `20` FETCH · `30`
   * BUILD · `40` UPLOAD · `41` RECORD · `50` CREDENTIAL_REFUSED · `70`
   * UNEXPECTED, every value kept below 125 so `137` stays unambiguously the
   * kernel's OOM-kill), and none of it reached Motir through a port that only
   * said `state: 'stopped'`.
   *
   * ⚠️ `null` IS A REAL ANSWER, NOT A GAP, and the consumer must treat it as its
   * own case rather than as success. `auto_destroy` means a machine may be gone
   * before anyone can read it, and a provider is not obliged to have kept the
   * exit event. "Stopped, code unknown" is a third outcome beside "exited 0" and
   * "exited 30".
   *
   * ⚠️ THE PORT DOES NOT INTERPRET THE NUMBER. Mapping `20` to "re-dispatch" and
   * `50` to "mint a fresh credential" belongs to the dispatch service; here it
   * simply becomes observable, as a plain number — never as a provider event
   * type (§4 rule 1).
   */
  readonly exitCode: number | null;
}

/**
 * The CONTAINER-SECONDS RECORD (§5) — what the cost meter consumes and what the
 * fleet's own reconciliation audits. PER RUNNER, never aggregated at write time.
 *
 * ⚠️ THE FIELDS ARE FIXED BY THE ADR, THE SCHEMA IS MOTIR-1924'S. MOTIR-1921
 * EMITS the record from `teardown` / `reap`; MOTIR-1924 persists it into
 * `ci_container_usage` — workspace-scoped, with RLS — via the sink. Keeping the
 * fields here and the table there is what stops the meter, the reconciliation
 * and the margin readout each inventing their own shape; the model's columns
 * mirror this interface one-for-one, and they have to stay that way.
 */
export interface ContainerUsage {
  readonly handleId: string;
  readonly provider: OrchestratorProvider;
  readonly region: string;

  // Attribution — copied from the spec, so a row is readable without a join.
  readonly orgId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly repoFullName: string;
  /** WHICH workload this container ran. The fleet org is SHARED — runners, index
   *  containers and Epic 9's agents all bill the same uncapped account — so a
   *  cost row that cannot say which workload it was merges three margins into
   *  one number and makes "what did indexing cost us?" unanswerable. */
  readonly workload: FleetWorkloadKind;
  /** Null for every non-CI workload; see `ContainerSpec.workflowJobId`. The
   *  `ci_container_usage.workflow_job_id` column is already `String?` for
   *  exactly this reason. */
  readonly workflowJobId: number | null;

  // The machine class actually provisioned (may differ from requested on a
  // fallback), which is why it is reported rather than assumed from the spec.
  readonly cpuKind: 'shared' | 'performance';
  readonly cpus: number;
  readonly memoryMb: number;

  // The physical quantity. Provider timestamps where available, ours otherwise.
  readonly createdAt: Date;
  readonly startedAt: Date | null; // null iff it never started (provision_failed)
  readonly stoppedAt: Date;
  readonly billableSeconds: number; // ceil(stoppedAt - startedAt); 0 when never started

  // The commercial mapping, resolved from the DATED rate table at teardown.
  readonly usdPerSecond: string; // decimal string — never a float
  readonly costUsd: string; // billableSeconds × usdPerSecond
  readonly rateEffectiveFrom: Date | null; // WHICH row was applied; null when unpriced

  readonly terminalState: string; // provider-reported
  readonly teardownReason: TeardownReason;
}

/**
 * The port. Four operations, and the fourth is the one that makes the other
 * three survivable.
 */
export interface ContainerOrchestrator {
  readonly provider: OrchestratorProvider;

  /** Boot exactly one container. Throws a typed error; NEVER leaves an untracked
   *  container — an adapter that creates a machine and then fails must destroy it
   *  before it throws, or the reaper is the only thing standing between Motir and
   *  an invoice. */
  provision(spec: ContainerSpec): Promise<ContainerHandle>;

  /** Destroy it and RETURN what it cost. IDEMPOTENT: a second call on a destroyed
   *  container returns the same usage, never throws. Idempotence is load-bearing
   *  — the `finally` path and the reaper can both reach the same container, and a
   *  throw from the second one would turn a tidy-up into an incident. */
  teardown(
    handle: ContainerHandle,
    reason: TeardownReason,
    context: UsageAttribution,
  ): Promise<ContainerUsage>;

  /** Provider-truth status, for the reaper and for diagnostics. */
  describe(handle: ContainerHandle): Promise<ContainerStatus>;

  /** The crash-safe sweeper: destroy every container this orchestrator owns that
   *  is older than `olderThan`, returning one usage record each. Called on a
   *  schedule. It queries the PROVIDER, never in-process state — the case it
   *  exists for is the process that held that state having died. */
  reap(olderThan: Date, resolve: UsageAttributionResolver): Promise<ContainerUsage[]>;
}

/**
 * The attribution a usage row carries, threaded into `teardown` rather than
 * remembered by the adapter.
 *
 * WHY IT IS AN ARGUMENT AND NOT ADAPTER STATE: teardown must work after a
 * process restart, from nothing but the persisted handle. An adapter that
 * remembered the spec it booted would produce correct rows right up until the
 * one case the reaper exists for — a crash — and then produce unattributed ones,
 * which is precisely when attribution matters most.
 */
export interface UsageAttribution {
  readonly orgId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly repoFullName: string;
  /** Threaded in for the same reason the rest of the attribution is: the reaper
   *  builds this from the PERSISTED record after a crash, and a usage row that
   *  cannot name its workload is a cost nobody can assign. */
  readonly workload: FleetWorkloadKind;
  /** Null for every non-CI workload; see `ContainerSpec.workflowJobId`. */
  readonly workflowJobId: number | null;
  readonly size: ContainerSize;
  /**
   * When the CALLER saw the container start, if it did.
   *
   * ⚠️ THIS IS NOT REDUNDANT WITH THE PROVIDER'S OWN TIMESTAMP, and the reason is
   * the happy path. `auto_destroy: true` means a successful run ends with the
   * machine DELETING ITSELF, so by the time teardown reads the provider the
   * machine — and its event log, the source of the provider-attested start
   * instant — is frequently already gone. Without a caller-observed fallback the
   * best-behaved containers would be exactly the ones that produced a
   * zero-second usage row, and Motir's own cost would read as near zero while
   * the invoice did not.
   *
   * The provider's timestamp WINS whenever it is still available (§5 prefers
   * provider-attested instants); this is the fallback, and its use is visible in
   * the row because a caller-observed start is the caller's clock.
   */
  readonly observedStartedAt: Date | null;
}

/**
 * How the reaper recovers attribution for a container it found on the provider:
 * by looking the handle up against the intent table. Returns null when nothing
 * owns it, which is itself a finding — a container Motir booted and has no record
 * of is still destroyed, and still reported.
 */
export type UsageAttributionResolver = (
  handle: ContainerHandle,
) => Promise<UsageAttribution | null>;
