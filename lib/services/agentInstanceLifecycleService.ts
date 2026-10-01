import { randomUUID } from 'node:crypto';
import type {
  AgentInstance,
  AgentInstanceInterval,
  AgentInstanceIntervalEndReason,
  AgentInstanceState,
  Prisma,
} from '@/generated/prisma/client';
import { FLEET_CONTAINER_SIZE, type PersistentContainerHandle } from '@motir/orchestrator';
import {
  INSTANCE_HOME_PATH,
  INSTANCE_INLINE_BOOT_WAIT_MS,
  INSTANCE_INLINE_STOP_WAIT_MS,
  INSTANCE_MAX_PER_USER,
  INSTANCE_NAME_PATTERN,
  INSTANCE_SLOT_TTL_SECONDS,
  INSTANCE_VOLUME_SIZE_GB,
  instanceMaxRunning,
} from '@/lib/agentInstances/config';
import {
  AgentInstanceNameInvalidError,
  AgentInstanceNameTakenError,
  AgentInstanceNotFoundError,
  AgentInstanceRunActiveError,
  AgentInstanceStartRefusedError,
  AgentInstanceStateConflictError,
  AgentInstancesUnavailableError,
  AgentProfileNotOfferedError,
} from '@/lib/agentInstances/errors';
import { buildCloneCommand } from '@/lib/agentInstances/cloneCommand';
import {
  AGENT_RUN_LAUNCHER_PROBE_COMMAND,
  AGENT_SIGN_IN_COMMAND,
  AGENT_SIGN_IN_TIMEOUT_SECONDS,
  AGENT_TERMINAL_PROBE_COMMAND,
  agentTerminalMachineConfig,
  isAgentTerminalConfigured,
  parseSignInAnswer,
  type AgentSignInAnswer,
} from '@/lib/agentInstances/terminal';
import { imageDigestResolver, pinnedImageReference } from '@/lib/agentInstances/imageDigest';
import { imageCatalog } from '@/lib/agentInstances/imageCatalog';
import {
  isOfferedProfile,
  profileDisplayName,
  sandboxImageTag,
} from '@/lib/agentInstances/profiles';
import {
  intervalBillableSeconds,
  intervalChargeReference,
  statesThatMayEnter,
} from '@/lib/agentInstances/stateMachine';
import { checkAgentRunCredits } from '@/lib/ai/motirAiClient';
import { isCloudBilling } from '@/lib/billing/availability';
import type { AgentInstanceDto, AgentInstanceImageFields } from '@/lib/dto/agentInstances';
import {
  mintProjectReadCredentials,
  revokeInstanceCloneCredential,
} from '@/lib/github/runGitCredential';
import { machineCreditsFor } from '@/lib/hostedRuns/machineRate';
import {
  endLineReason,
  isClosedRunInAgent,
  toAgentInstanceActiveRunDto,
  toAgentInstanceDto,
  toAgentInstanceLastRunDto,
} from '@/lib/mappers/agentInstanceMappers';
import type {
  AgentInstanceActiveRunDto,
  AgentInstanceLastRunDto,
  AgentInstanceListPageDto,
  AgentInstanceStopReason,
} from '@/lib/dto/agentInstances';
import { getPersistentOrchestrator, isPersistentOrchestratorConfigured } from '@/lib/orchestrator';
import { agentInstanceIntervalRepository } from '@/lib/repositories/agentInstanceIntervalRepository';
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';
import { dispatchRunEventRepository } from '@/lib/repositories/dispatchRunEventRepository';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import type { AgentRunEndOutcome } from '@/lib/services/agentInstanceRunService';
import {
  agentInstanceActivityService,
  agentInstanceClock,
  armIdleTimer,
} from '@/lib/services/agentInstanceActivityService';
import { agentInstanceChargeService } from '@/lib/services/agentInstanceChargeService';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { fleetCeilingService } from '@/lib/services/fleetCeilingService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectsService } from '@/lib/services/projectsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  withSystemContext,
  withWorkspaceContext,
  withWorkspaceServiceContext,
} from '@/lib/workspaces/context';

// THE AGENT-INSTANCE LIFECYCLE (Story MOTIR-6860 · MOTIR-6872) — create, wake,
// hibernate and delete a developer's own long-lived agent machine, under
// `docs/decisions/agent-instances.md`.
//
// ── THE SHAPE OF EVERY OPERATION ────────────────────────────────────────────
//   1. Resolve the project and assert `instance:use` on it (§8) — and, for an
//      existing instance, that the caller OWNS it: no key, a manager's included,
//      opens someone else's (`AgentInstanceNotFoundError` either way, so an id
//      that is not yours is indistinguishable from one that does not exist).
//   2. Refuse BEFORE anything is spent (§5, §6): the offered profile, the name,
//      the per-user cap, the credit pre-flight, and — under the fleet admission
//      lock, atomically with the slot take — the two running caps and the ceiling.
//   3. ONE guarded compare-and-set on the record (§4), in a transaction.
//   4. The Fly call AFTER that transaction commits (motir-core/CLAUDE.md: side
//      effects outside the transaction), and a guarded move to `failed` with the
//      reason in words if it fails — releasing whatever was held.
//
// ── THE INTERVAL OWNS THE SLOT ───────────────────────────────────────────────
// A running interval opens at the moment a create or wake takes its fleet slot,
// and the slot's `ownerRef` IS the interval id (§6, MOTIR-2160), so a stale
// release can never free a newer interval's slot. The interval's `startedAt` is
// Motir's own instant at open and is CORRECTED to Fly's start event when the
// machine is seen running (§5: Fly's event log first, Motir's instant the
// fallback) — so boot wait is never billed where Fly attests the start. Every
// close releases the slot, whatever closed it.
//
// ── SETTLING ────────────────────────────────────────────────────────────────
// Booting and stopping take Fly seconds, so each operation waits a bounded time
// in the request and then leaves the rest to the settle functions below, which
// are IDEMPOTENT and are also what the 5-minute sweep (MOTIR-6873) calls for any
// instance still in motion. Charging a closed interval is the sweep's too.

// ── A RUN IN THE AGENT (Story MOTIR-6864 · MOTIR-7027, `agent-instance-run.md` §6) ──
// A running run holds its agent: Hibernate and Delete are REFUSED, naming it
// (`AgentInstanceRunActiveError`), and the idle check skips the agent. When a
// machine stops for a reason no person chose — the 12-hour backstop, a credit
// stop, a machine lost or stopped behind Motir's back — its run is CLOSED FIRST
// through the run's one end path (`agentInstanceRunService.end`), so the record
// never shows a running run in a stopped agent. That service imports this one,
// so it is reached here by a dynamic import ({@link endRunIn}).

// The clock seam and the activity door live in `agentInstanceActivityService`
// (MOTIR-6940: the terminal relay imports them without this file's graph).
export { agentInstanceClock };

const STOP_REASONS: readonly string[] = ['credits', 'idle', 'backstop'];

interface ResolvedProject {
  id: string;
  workspaceId: string;
  organizationId: string;
}

async function resolveProject(projectKey: string, ctx: ServiceContext): Promise<ResolvedProject> {
  const project = await projectsService.getByKey(projectKey, ctx);
  await projectAccessService.assertPermission(project.id, ctx, 'instance:use');
  const organizationId = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    workspaceRepository.findOrganizationId(ctx.workspaceId, tx),
  );
  /* v8 ignore next 3 -- every workspace belongs to an organisation (Story 6.10). */
  if (!organizationId) {
    throw new AgentInstancesUnavailableError('the workspace belongs to no organization');
  }
  return { id: project.id, workspaceId: ctx.workspaceId, organizationId };
}

function requireLane(): void {
  if (!isPersistentOrchestratorConfigured()) {
    throw new AgentInstancesUnavailableError('no instance fleet is configured');
  }
}

function inProject<T>(
  project: ResolvedProject,
  ctx: ServiceContext,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return withWorkspaceContext(
    { userId: ctx.userId, workspaceId: project.workspaceId, projectId: project.id },
    fn,
  );
}

async function ownInstance(
  project: ResolvedProject,
  instanceId: string,
  ctx: ServiceContext,
): Promise<AgentInstance> {
  const row = await inProject(project, ctx, (tx) =>
    agentInstanceRepository.findLiveForOwner(instanceId, ctx.userId, tx),
  );
  if (!row || row.projectId !== project.id) throw new AgentInstanceNotFoundError(instanceId);
  return row;
}

/**
 * The persistent handle a row names, or null before `provisionPersistent`
 * answered. Exported for the run start (MOTIR-7026), which execs its launcher
 * through the same handle.
 */
export function agentInstanceHandle(row: AgentInstance): PersistentContainerHandle | null {
  return handleOf(row);
}

function handleOf(row: AgentInstance): PersistentContainerHandle | null {
  if (!row.flyApp || !row.machineId || !row.volumeId) return null;
  return {
    provider: getPersistentOrchestrator().provider,
    app: row.flyApp,
    machineId: row.machineId,
    volumeId: row.volumeId,
    region: row.region,
    createdAt: row.createdAt,
  };
}

function stopReasonOf(
  endReason: AgentInstanceIntervalEndReason | null,
): AgentInstanceStopReason | null {
  return endReason !== null && STOP_REASONS.includes(endReason)
    ? (endReason as AgentInstanceStopReason)
    : null;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : 'unknown error';
}

/**
 * The credit pre-flight (§5): may this organisation start a machine? A self-hosted
 * build charges nothing and asks nothing. An answer that could not be obtained
 * refuses too, with different words — "could not ask" is never "yes".
 */
async function assertCredits(organizationId: string): Promise<void> {
  if (!isCloudBilling()) return;
  const verdict = await checkAgentRunCredits(organizationId);
  if (verdict === null) {
    throw new AgentInstanceStartRefusedError(
      'credits_unknown',
      'Motir could not check your organization’s credits just now. Try again in a moment.',
    );
  }
  if (!verdict.mayRun) {
    throw new AgentInstanceStartRefusedError(
      'credits',
      'Your organization’s credits can’t start a machine right now. Add credits to create or wake an agent.',
    );
  }
}

/**
 * Take a slot in the agents' OWN pool for one machine run, with the pool's safety
 * valve decided under the fleet admission lock (§6, AMENDMENT 2). There is no
 * per-organisation cap: credits decide who may run. The slot is keyed on the RUN
 * (`runId`, the id of the run's first interval), because the running charge splits
 * one run into several intervals. Returns nothing on success; throws the refusal
 * in words otherwise.
 */
async function reserveSlot(input: {
  instanceId: string;
  runId: string;
  organizationId: string;
  workspaceId: string;
}): Promise<void> {
  const maxRunning = instanceMaxRunning();
  const verdict = await fleetCeilingService.reserve({
    workload: 'agent_instance',
    ref: input.instanceId,
    ownerRef: input.runId,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    ttlSeconds: INSTANCE_SLOT_TTL_SECONDS,
    guard: async (tx) => {
      const running = await agentInstanceRepository.countRunning({}, tx);
      return running >= maxRunning ? 'agent_pool_full' : null;
    },
  });
  if (verdict.outcome !== 'deferred') return;
  throw new AgentInstanceStartRefusedError(
    'fleet_busy',
    'Motir is running as many machines as it can right now. Try again in a few minutes.',
  );
}

function releaseSlot(instanceId: string, runId: string): Promise<boolean> {
  return fleetCeilingService.release('agent_instance', instanceId, runId);
}

/**
 * Close the instance's open interval (if any) at `endedAt`, with `endReason`,
 * and release its run's slot — the machine run ends here. Idempotent: an instance with no open interval closes
 * nothing and releases nothing. Returns the closed interval, or null.
 */
async function closeOpenInterval(
  row: AgentInstance,
  endedAt: Date,
  endReason: AgentInstanceIntervalEndReason,
): Promise<AgentInstanceInterval | null> {
  const closed = await withWorkspaceServiceContext(row.workspaceId, async (tx) => {
    const open = await agentInstanceIntervalRepository.findOpen(row.id, tx);
    if (!open) return null;
    // A clock reading before the start (Fly's stop instant behind Motir's open
    // instant, on a machine that never really started) bills nothing.
    const end = endedAt.getTime() < open.startedAt.getTime() ? open.startedAt : endedAt;
    const moved = await agentInstanceIntervalRepository.close(
      open.id,
      { endedAt: end, endReason, billableSeconds: intervalBillableSeconds(open.startedAt, end) },
      tx,
    );
    return moved === 1 ? open : null;
  });
  if (closed) {
    await releaseSlot(row.id, closed.runId);
    // Charge it now (§5); a transport failure leaves it `pending` for the sweep.
    try {
      await agentInstanceChargeService.chargeInterval(closed.id);
    } catch (err) {
      console.error(
        '[agentInstanceLifecycle] the interval charge failed; the sweep will retry it',
        {
          instanceId: row.id,
          intervalId: closed.id,
          detail: describeError(err),
        },
      );
    }
  }
  return closed;
}

/** A guarded move made by the system (the settle paths): read, check, move. */
async function systemTransition(
  row: AgentInstance,
  from: readonly AgentInstanceState[],
  to: AgentInstanceState,
  patch: { failureReason?: string | null; lastActivityAt?: Date } = {},
): Promise<boolean> {
  const moved = await withWorkspaceServiceContext(row.workspaceId, (tx) =>
    agentInstanceRepository.transition(row.id, from, to, agentInstanceClock.now(), patch, tx),
  );
  return moved === 1;
}

async function reload(row: AgentInstance): Promise<AgentInstance> {
  const fresh = await withWorkspaceServiceContext(row.workspaceId, (tx) =>
    agentInstanceRepository.findById(row.id, tx),
  );
  /* v8 ignore next -- a row is never hard-deleted. */
  if (!fresh) throw new AgentInstanceNotFoundError(row.id);
  return fresh;
}

/** The run running in this agent, with the card it works on, or null (§5's read). */
async function runningRunIn(
  row: AgentInstance,
): Promise<{ id: string; workItemKey: string | null } | null> {
  return withWorkspaceServiceContext(row.workspaceId, async (tx) => {
    const running = await dispatchRunRepository.findRunningByAgentInstance(row.id, tx);
    if (!running) return null;
    const keys = await dispatchRunRepository.findTargetKeys([running.id], tx);
    return { id: running.id, workItemKey: keys.get(running.id) ?? null };
  });
}

/** Refuse a person's Hibernate or Delete while a run is running in the agent (§6). */
async function assertNoRunningRun(
  row: AgentInstance,
  action: 'hibernated' | 'deleted',
): Promise<void> {
  const running = await runningRunIn(row);
  if (running)
    throw new AgentInstanceRunActiveError(row.id, running.id, running.workItemKey, action);
}

/**
 * Close the run running in this agent, if any, through the run's one end path —
 * BEFORE the machine it runs on is stopped or given up (§6). Never a throw.
 */
async function endRunIn(
  row: AgentInstance,
  outcome: AgentRunEndOutcome,
  detail: string,
): Promise<void> {
  const { agentInstanceRunService } = await import('@/lib/services/agentInstanceRunService');
  await agentInstanceRunService.endRunningInAgent(row, outcome, detail);
}

/** The words a run in an agent is closed with when its machine goes (§6). */
const RUN_MACHINE_LOST = 'the agent’s machine was lost';
const RUN_AGENT_STOPPED = 'the agent stopped';
const RUN_BOOT_FAILED = 'the agent stopped before the run could start';

/**
 * Move an instance to `failed` with its reason, closing its interval (`lost`) and
 * releasing its slot — and, first, closing the run running in it `failed` (§6).
 */
async function failInstance(
  row: AgentInstance,
  reason: string,
  runDetail: string = RUN_MACHINE_LOST,
): Promise<void> {
  await endRunIn(row, 'failed', runDetail);
  await systemTransition(row, ['starting', 'waking', 'running', 'hibernating'], 'failed', {
    failureReason: reason,
  });
  await closeOpenInterval(row, agentInstanceClock.now(), 'lost');
}

/** Clone the project's repositories into a freshly booted instance (§1). */
async function cloneRepositories(
  row: AgentInstance,
  handle: PersistentContainerHandle,
): Promise<void> {
  const credentials = await mintProjectReadCredentials(row.projectId, row.workspaceId);
  for (const credential of credentials) {
    try {
      const result = await getPersistentOrchestrator().exec(
        handle,
        buildCloneCommand(credential.repositories, credential.token),
        { timeoutSeconds: 600 },
      );
      if (result.exitCode !== 0) {
        throw new Error(
          `cloning ${credential.repositories.join(', ')} failed: ${result.stderr.trim().slice(0, 200) || `exit ${result.exitCode}`}`,
        );
      }
    } finally {
      await revokeInstanceCloneCredential(credential.token);
    }
  }
}

/**
 * THE TERMINAL-SERVER PROBE (`docs/decisions/agent-terminal.md` Q8 · MOTIR-6939):
 * on a booted machine whose pinned digest was not probed yet (a first boot, or a
 * digest that changed), run `motir agent-terminal --help` through the one `exec`
 * door and record whether the image serves a terminal. ONCE per digest — an
 * `absent` is an answer, never retried. It never fails the boot: the agent stays
 * usable either way, and a probe that could not run leaves `unknown` for the
 * next boot. Skipped while the terminal is off on this deployment.
 */
async function probeTerminalServer(
  row: AgentInstance,
  handle: PersistentContainerHandle,
): Promise<void> {
  if (row.terminalServerDigest === row.imageDigest) return;
  try {
    if (!isAgentTerminalConfigured()) return;
    const result = await getPersistentOrchestrator().exec(handle, AGENT_TERMINAL_PROBE_COMMAND, {
      timeoutSeconds: 30,
    });
    // A negative code is an exec whose answer carried no exit code: not an answer.
    if (result.exitCode < 0) return;
    await withWorkspaceServiceContext(row.workspaceId, (tx) =>
      agentInstanceRepository.recordTerminalServer(
        row.id,
        { terminalServer: result.exitCode === 0 ? 'present' : 'absent', digest: row.imageDigest },
        tx,
      ),
    );
  } catch (err) {
    console.warn('[agentInstanceLifecycle] the terminal-server probe did not answer', {
      instanceId: row.id,
      detail: describeError(err),
    });
  }
}

/**
 * THE SIGN-IN QUERY (`agent-instance-run.md` §4 · MOTIR-7026): ask the agent's
 * terminal server whether its coding agent is signed in, and record the answer
 * with its time. Never a throw: an exec that failed or gave no answer returns
 * null and leaves the recorded value standing — "could not ask" is not an answer.
 */
async function probeSignIn(
  row: AgentInstance,
  handle: PersistentContainerHandle,
): Promise<AgentSignInAnswer | null> {
  try {
    const state = parseSignInAnswer(
      await getPersistentOrchestrator().exec(handle, AGENT_SIGN_IN_COMMAND, {
        timeoutSeconds: AGENT_SIGN_IN_TIMEOUT_SECONDS,
      }),
    );
    if (state === null) return null;
    await withWorkspaceServiceContext(row.workspaceId, (tx) =>
      agentInstanceRepository.recordSignIn(
        row.id,
        { signInState: state, at: agentInstanceClock.now() },
        tx,
      ),
    );
    return state;
  } catch (err) {
    console.warn('[agentInstanceLifecycle] the sign-in query did not answer', {
      instanceId: row.id,
      detail: describeError(err),
    });
    return null;
  }
}

/**
 * THE RUN PROBES AT A BOOT (`agent-instance-run.md` §4 · MOTIR-7026), beside the
 * terminal-server probe: whether the image carries the run launcher — ONCE per
 * digest, `motir agent-terminal run --help` exiting 0 — and the coding agent's
 * sign-in, every boot. Never fails the boot. Skipped while the terminal is off:
 * the launcher is the terminal server's, so there is nothing to ask.
 */
async function probeRunCapabilities(
  row: AgentInstance,
  handle: PersistentContainerHandle,
): Promise<void> {
  if (!isTerminalOnQuietly()) return;
  try {
    if (row.runLauncherDigest !== row.imageDigest) {
      const result = await getPersistentOrchestrator().exec(
        handle,
        AGENT_RUN_LAUNCHER_PROBE_COMMAND,
        { timeoutSeconds: 30 },
      );
      if (result.exitCode >= 0) {
        await withWorkspaceServiceContext(row.workspaceId, (tx) =>
          agentInstanceRepository.recordRunLauncher(
            row.id,
            { runLauncher: result.exitCode === 0 ? 'present' : 'absent', digest: row.imageDigest },
            tx,
          ),
        );
      }
    }
  } catch (err) {
    console.warn('[agentInstanceLifecycle] the run-launcher probe did not answer', {
      instanceId: row.id,
      detail: describeError(err),
    });
  }
  await probeSignIn(row, handle);
}

/** {@link isAgentTerminalConfigured}, reading a misconfigured key as "off" (the probes never throw). */
function isTerminalOnQuietly(): boolean {
  try {
    return isAgentTerminalConfigured();
  } catch {
    return false;
  }
}

/**
 * Each listed agent's live run, and — for an agent with none — its latest closed
 * run (MOTIR-7029: the panel's run line and its "Last run" face). A BOUNDED number
 * of queries whatever the count of agents: the running runs, the latest runs of
 * the idle agents, those runs' cards, and the closing lines of the ones that did
 * not succeed — each one query, each skipped when it has nothing to ask.
 */
async function readAgentRuns(
  agentIds: readonly string[],
  tx: Prisma.TransactionClient,
): Promise<{
  active: Map<string, AgentInstanceActiveRunDto>;
  last: Map<string, AgentInstanceLastRunDto>;
}> {
  const running = await dispatchRunRepository.findRunningByAgentInstances(agentIds, tx);
  const busy = new Set(running.map((r) => r.agentInstanceId));
  const latest = (
    await dispatchRunRepository.findLatestByAgentInstances(
      agentIds.filter((id) => !busy.has(id)),
      tx,
    )
  ).filter(isClosedRunInAgent);
  const targets = await dispatchRunRepository.findTargetCards(
    [...running, ...latest].map((r) => r.id),
    tx,
  );
  const reasons = new Map<string, string | null>();
  for (const line of await dispatchRunEventRepository.listEndLinesForRuns(
    latest.filter((r) => r.status !== 'succeeded').map((r) => r.id),
    tx,
  )) {
    // Newest first: the first line seen for a run is its closing line.
    if (!reasons.has(line.dispatchRunId)) reasons.set(line.dispatchRunId, endLineReason(line.data));
  }
  const active = new Map<string, AgentInstanceActiveRunDto>();
  for (const run of running) {
    active.set(run.agentInstanceId, toAgentInstanceActiveRunDto(run, targets.get(run.id) ?? null));
  }
  const last = new Map<string, AgentInstanceLastRunDto>();
  for (const run of latest) {
    last.set(
      run.agentInstanceId,
      toAgentInstanceLastRunDto(run, targets.get(run.id) ?? null, reasons.get(run.id) ?? null),
    );
  }
  return { active, last };
}

async function waitFor(deadlineMs: number, done: () => Promise<boolean>): Promise<boolean> {
  const deadline = agentInstanceClock.now().getTime() + deadlineMs;
  for (;;) {
    if (await done()) return true;
    if (agentInstanceClock.now().getTime() >= deadline) return false;
    await agentInstanceClock.sleep(agentInstanceClock.pollIntervalMs);
  }
}

/** The catalog could not be asked: shown as "could not check", never as up to date. */
const UNKNOWN_IMAGE: AgentInstanceImageFields = { imageVersion: null, update: 'unknown' };

/**
 * The catalog's answer for each row (`agent-image-update.md` Q1, MOTIR-6949):
 * its version and its update offer. The catalog caches per profile, so a page of
 * N agents across P profiles reads the registry at most P times per window.
 * Never throws: a catalog failure is `unknown` on the rows it touched.
 */
async function imageFieldsFor(
  rows: readonly AgentInstance[],
): Promise<Map<string, AgentInstanceImageFields>> {
  // No instance lane on this deployment: nothing could be updated, and a list
  // read must not reach a registry for it.
  if (!isPersistentOrchestratorConfigured()) return new Map();
  const answers = await Promise.all(
    rows.map(async (row): Promise<[string, AgentInstanceImageFields]> => {
      try {
        return [row.id, await imageCatalog.updateFor(row.profileId, row.imageDigest)];
      } catch (err) {
        console.warn('[agentInstanceLifecycle] the image catalog failed', {
          instanceId: row.id,
          detail: describeError(err),
        });
        return [row.id, UNKNOWN_IMAGE];
      }
    }),
  );
  return new Map(answers);
}

async function toDtoWithImage(row: AgentInstance): Promise<AgentInstanceDto> {
  const image = await imageFieldsFor([row]);
  return toAgentInstanceDto(row, image.get(row.id) ?? UNKNOWN_IMAGE);
}

export const agentInstanceLifecycleService = {
  /** The caller's own live instances on the project, newest first, one page (§4, §8). */
  async list(
    projectKey: string,
    page: { take: number; skip: number },
    ctx: ServiceContext,
  ): Promise<AgentInstanceListPageDto> {
    const project = await resolveProject(projectKey, ctx);
    const now = agentInstanceClock.now();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const page_ = await inProject(project, ctx, async (tx) => {
      const scope = { ownerId: ctx.userId, projectId: project.id };
      const rows = await agentInstanceRepository.listLiveForOwner({ ...scope, ...page }, tx);
      const total = await agentInstanceRepository.countLiveForOwner(scope, tx);
      const intervals = await agentInstanceIntervalRepository.listForInstancesSince(
        rows.map((r) => r.id),
        monthStart,
        tx,
      );
      const latestClosed = new Map(
        (
          await agentInstanceIntervalRepository.listLatestClosedForInstances(
            rows.filter((r) => r.state === 'hibernated').map((r) => r.id),
            tx,
          )
        ).map((i) => [i.agentInstanceId, i.endReason]),
      );
      const usage = new Map<string, { seconds: number; credits: number }>();
      for (const interval of intervals) {
        // Only the part of an interval inside this month counts; an open one runs to now.
        const from = interval.startedAt < monthStart ? monthStart : interval.startedAt;
        const to = interval.endedAt ?? now;
        const seconds = intervalBillableSeconds(from, to);
        const credits = interval.credits ?? machineCreditsFor(seconds, to);
        const acc = usage.get(interval.agentInstanceId) ?? { seconds: 0, credits: 0 };
        usage.set(interval.agentInstanceId, {
          seconds: acc.seconds + seconds,
          credits: acc.credits + credits,
        });
      }
      const runs = await readAgentRuns(
        rows.map((r) => r.id),
        tx,
      );
      return { total, rows, usage, latestClosed, runs };
    });
    // The registry is asked OUTSIDE the transaction, once per profile per cache
    // window (`agent-image-update.md` Q1) — never once per row.
    const image = await imageFieldsFor(page_.rows);
    const { usage, latestClosed, runs } = page_;
    return {
      total: page_.total,
      instances: page_.rows.map((row) => ({
        ...toAgentInstanceDto(row, image.get(row.id) ?? UNKNOWN_IMAGE),
        profileName: profileDisplayName(row.profileId),
        machineSecondsThisMonth: usage.get(row.id)?.seconds ?? 0,
        creditsThisMonth: usage.get(row.id)?.credits ?? 0,
        stopReason: stopReasonOf(latestClosed.get(row.id) ?? null),
        activeRun: runs.active.get(row.id) ?? null,
        lastRun: runs.last.get(row.id) ?? null,
      })),
    };
  },

  /**
   * Create an instance (§1, §4): refuse or boot. On success the instance is
   * `starting` or — when the machine reported running within the inline wait —
   * `running` with the project's repositories cloned.
   */
  async create(
    projectKey: string,
    input: { name: string; profileId: string },
    ctx: ServiceContext,
  ): Promise<AgentInstanceDto> {
    const project = await resolveProject(projectKey, ctx);
    requireLane();
    const name = input.name.trim();
    if (!INSTANCE_NAME_PATTERN.test(name)) throw new AgentInstanceNameInvalidError();
    if (!isOfferedProfile(input.profileId)) {
      throw new AgentProfileNotOfferedError(input.profileId, profileDisplayName(input.profileId));
    }

    const mine = await withSystemContext((tx) =>
      agentInstanceRepository.countLiveForOwnerEverywhere(ctx.userId, tx),
    );
    if (mine >= INSTANCE_MAX_PER_USER) {
      throw new AgentInstanceStartRefusedError(
        'user_cap',
        `You already have ${INSTANCE_MAX_PER_USER} agents. Delete one to create another.`,
      );
    }
    const clash = await inProject(project, ctx, async (tx) => {
      const rows = await agentInstanceRepository.listLiveForOwner(
        { ownerId: ctx.userId, projectId: project.id, take: INSTANCE_MAX_PER_USER, skip: 0 },
        tx,
      );
      return rows.some((r) => r.name === name);
    });
    if (clash) throw new AgentInstanceNameTakenError(name);

    await assertCredits(project.organizationId);
    const imageTag = sandboxImageTag(input.profileId);
    const imageDigest = await imageDigestResolver.resolve(imageTag);

    const instanceId = randomUUID();
    // Before anything is taken: a misconfigured master key refuses here, loudly.
    const terminal = agentTerminalMachineConfig(instanceId);
    const intervalId = randomUUID();
    await reserveSlot({
      instanceId,
      runId: intervalId,
      organizationId: project.organizationId,
      workspaceId: project.workspaceId,
    });

    const orchestrator = getPersistentOrchestrator();
    const region = orchestrator.defaultRegion();
    const openedAt = agentInstanceClock.now();
    let row: AgentInstance;
    try {
      row = await inProject(project, ctx, async (tx) => {
        const created = await agentInstanceRepository.create(
          {
            id: instanceId,
            workspaceId: project.workspaceId,
            organizationId: project.organizationId,
            projectId: project.id,
            ownerId: ctx.userId,
            name,
            profileId: input.profileId,
            imageTag,
            imageDigest,
            region,
          },
          tx,
        );
        await agentInstanceIntervalRepository.open(
          {
            id: intervalId,
            workspaceId: project.workspaceId,
            organizationId: project.organizationId,
            agentInstanceId: instanceId,
            runId: intervalId,
            runStartedAt: openedAt,
            startedAt: openedAt,
            chargeReference: intervalChargeReference(intervalId),
          },
          tx,
        );
        return created;
      });
    } catch (err) {
      await releaseSlot(instanceId, intervalId);
      // The partial unique index: a concurrent create won the same name.
      if (isUniqueViolation(err)) throw new AgentInstanceNameTakenError(name);
      throw err;
    }

    try {
      const handle = await orchestrator.provisionPersistent({
        orgId: project.organizationId,
        workspaceId: project.workspaceId,
        projectId: project.id,
        instanceId,
        image: pinnedImageReference(imageTag, imageDigest),
        size: FLEET_CONTAINER_SIZE,
        // No credential of the user's, and none of Motir's: the instance knows only
        // which record it is (§9's rule — Motir never pre-fills a sign-in).
        env: { MOTIR_INSTANCE_ID: instanceId },
        region,
        volumeSizeGb: INSTANCE_VOLUME_SIZE_GB,
        mountPath: INSTANCE_HOME_PATH,
        // agent-terminal.md Q2–Q4: the terminal server as the main process, its
        // public service, and the per-instance key (`MOTIR_TERMINAL_KEY`) — a key
        // that opens only this machine's shell, never a credential of the user's.
        terminal,
      });
      await withWorkspaceServiceContext(project.workspaceId, (tx) =>
        agentInstanceRepository.setHandle(
          instanceId,
          { flyApp: handle.app, machineId: handle.machineId, volumeId: handle.volumeId },
          tx,
        ),
      );
    } catch (err) {
      await failInstance(row, `The machine could not be created: ${describeError(err)}`);
      return await toDtoWithImage(await reload(row));
    }

    await waitFor(
      INSTANCE_INLINE_BOOT_WAIT_MS,
      async () => (await this.settleBoot(instanceId)) !== 'pending',
    );
    return await toDtoWithImage(await reload(row));
  },

  /** Wake a `hibernated` or `failed` instance (§2, §4): refuse or start. Every wake is a cold boot. */
  async wake(
    projectKey: string,
    instanceId: string,
    ctx: ServiceContext,
  ): Promise<AgentInstanceDto> {
    const project = await resolveProject(projectKey, ctx);
    requireLane();
    const row = await ownInstance(project, instanceId, ctx);
    const from = statesThatMayEnter('waking');
    if (!from.includes(row.state))
      throw new AgentInstanceStateConflictError(row.id, row.state, 'woken');
    const handle = handleOf(row);
    if (!handle) throw new AgentInstanceStateConflictError(row.id, row.state, 'woken');

    await assertCredits(project.organizationId);
    const terminal = agentTerminalMachineConfig(row.id);
    const intervalId = randomUUID();
    await reserveSlot({
      instanceId,
      runId: intervalId,
      organizationId: project.organizationId,
      workspaceId: project.workspaceId,
    });

    const now = agentInstanceClock.now();
    const moved = await inProject(project, ctx, async (tx) => {
      const n = await agentInstanceRepository.transition(
        row.id,
        from,
        'waking',
        now,
        { failureReason: null, lastActivityAt: now },
        tx,
      );
      if (n === 1) {
        await agentInstanceIntervalRepository.open(
          {
            id: intervalId,
            workspaceId: row.workspaceId,
            organizationId: row.organizationId,
            agentInstanceId: row.id,
            runId: intervalId,
            runStartedAt: now,
            startedAt: now,
            chargeReference: intervalChargeReference(intervalId),
          },
          tx,
        );
      }
      return n;
    });
    if (moved !== 1) {
      // A concurrent wake (or the sweep) got there first: it holds its own slot.
      await releaseSlot(instanceId, intervalId);
      const fresh = await reload(row);
      throw new AgentInstanceStateConflictError(row.id, fresh.state, 'woken');
    }

    try {
      // agent-terminal.md Q8: an agent whose machine config predates the current
      // one is brought up to date BEFORE the start (the machine stays stopped
      // while it is rewritten, its image digest and home volume untouched).
      if (terminal) await getPersistentOrchestrator().ensureMachineConfig(handle, terminal);
      await getPersistentOrchestrator().start(handle);
    } catch (err) {
      await failInstance(
        row,
        `The machine could not start: ${describeError(err)}. Wake to try again, or delete it.`,
      );
      return await toDtoWithImage(await reload(row));
    }
    await waitFor(
      INSTANCE_INLINE_BOOT_WAIT_MS,
      async () => (await this.settleBoot(instanceId)) !== 'pending',
    );
    return await toDtoWithImage(await reload(row));
  },

  /** Hibernate a `running` instance at its owner's request (§2). */
  async hibernate(
    projectKey: string,
    instanceId: string,
    ctx: ServiceContext,
  ): Promise<AgentInstanceDto> {
    const project = await resolveProject(projectKey, ctx);
    requireLane();
    const row = await ownInstance(project, instanceId, ctx);
    if (row.state !== 'running') {
      throw new AgentInstanceStateConflictError(row.id, row.state, 'hibernated');
    }
    // §6: never under a running run — the person cancels it first.
    await assertNoRunningRun(row, 'hibernated');
    // The loser of a race (another hibernate, the sweep) read `running` too, but its
    // guarded transition moved nothing: it is refused, never told it succeeded.
    if (!(await this.beginHibernate(row.id, 'hibernated'))) {
      throw new AgentInstanceStateConflictError(row.id, (await reload(row)).state, 'hibernated');
    }
    return await toDtoWithImage(await reload(row));
  },

  /**
   * Start hibernating ONE running instance, for its owner or for the sweep
   * (MOTIR-6873: `idle`, `backstop`, `credits`). Guarded `running → hibernating`,
   * then `stop`, then a bounded settle. Returns false when the instance was not
   * running (somebody else moved it first) — never an error for the sweep.
   *
   * A RUN IN THE AGENT (§6, MOTIR-7027): the backstop and a credit stop still
   * stop the machine — money and the 12-hour bound hold over a machine running a
   * card — and close its run FIRST (`timed_out`; `failed`, *"out of credits"*).
   * Every other reason (a person's Hibernate, the idle check) is REFUSED with
   * `AgentInstanceRunActiveError`, naming the run, and nothing moves.
   */
  async beginHibernate(
    instanceId: string,
    endReason: AgentInstanceIntervalEndReason,
  ): Promise<boolean> {
    const row = await withSystemContext((tx) => agentInstanceRepository.findById(instanceId, tx));
    if (!row || row.deletedAt || row.state !== 'running') return false;
    if (endReason === 'backstop') {
      await endRunIn(row, 'backstop', 'the agent reached its 12-hour backstop');
    } else if (endReason === 'credits') {
      await endRunIn(row, 'failed', 'out of credits');
    } else {
      await assertNoRunningRun(row, 'hibernated');
    }
    if (!(await systemTransition(row, ['running'], 'hibernating'))) return false;
    const handle = handleOf(row);
    if (handle) {
      // §4 (MOTIR-7026): the last sign-in answer before the volume goes quiet is
      // what a start reads while the agent sleeps. Best effort, never a refusal.
      if (isTerminalOnQuietly()) await probeSignIn(row, handle);
      try {
        await getPersistentOrchestrator().stop(handle);
      } catch (err) {
        console.warn('[agentInstanceLifecycle] stop failed; the sweep will settle it', {
          instanceId: row.id,
          detail: describeError(err),
        });
      }
    }
    await waitFor(
      INSTANCE_INLINE_STOP_WAIT_MS,
      async () => (await this.settleStop(row.id, endReason)) !== 'pending',
    );
    return true;
  },

  /** Delete an instance and its home (§1, §4): guarded, then machine then volume. */
  async delete(projectKey: string, instanceId: string, ctx: ServiceContext): Promise<void> {
    const project = await resolveProject(projectKey, ctx);
    requireLane();
    const row = await ownInstance(project, instanceId, ctx);
    // §6: never under a running run — the person cancels it first.
    await assertNoRunningRun(row, 'deleted');
    const moved = await inProject(project, ctx, (tx) =>
      agentInstanceRepository.transition(
        row.id,
        statesThatMayEnter('deleting'),
        'deleting',
        agentInstanceClock.now(),
        {},
        tx,
      ),
    );
    if (moved !== 1) throw new AgentInstanceStateConflictError(row.id, row.state, 'deleted');
    await this.settleDelete(row.id);
  },

  /**
   * SETTLE A BOOT (`starting` / `waking`), idempotently. `running` → correct the
   * interval's start to Fly's, clone on a first boot, move to `running`.
   * `gone` / `failed` → `failed`, interval closed `lost`, slot released. Still
   * booting → `'pending'`. Called inline by create and wake, and by the sweep.
   */
  async settleBoot(instanceId: string): Promise<'running' | 'failed' | 'pending' | 'noop'> {
    const row = await withSystemContext((tx) => agentInstanceRepository.findById(instanceId, tx));
    if (!row || row.deletedAt || (row.state !== 'starting' && row.state !== 'waking'))
      return 'noop';
    const handle = handleOf(row);
    if (!handle) return 'pending';
    let status;
    try {
      status = await getPersistentOrchestrator().describePersistent(handle);
    } catch {
      return 'pending';
    }
    if (status.state === 'gone' || status.state === 'failed') {
      await failInstance(
        row,
        'The machine stopped before it finished starting. Wake to try again, or delete it.',
        RUN_BOOT_FAILED,
      );
      return 'failed';
    }
    if (status.state !== 'running') return 'pending';

    if (row.state === 'starting') {
      try {
        await cloneRepositories(row, handle);
      } catch (err) {
        await failInstance(
          row,
          `The project’s repositories could not be cloned: ${describeError(err)}`,
          RUN_BOOT_FAILED,
        );
        return 'failed';
      }
    }
    await probeTerminalServer(row, handle);
    await probeRunCapabilities(row, handle);
    const fresh = await reload(row);
    if (fresh.state !== row.state) return 'noop';
    await withWorkspaceServiceContext(row.workspaceId, async (tx) => {
      const open = await agentInstanceIntervalRepository.findOpen(row.id, tx);
      if (open && status.startedAt && status.startedAt > open.startedAt) {
        await agentInstanceIntervalRepository.correctStart(open.id, status.startedAt, tx);
      }
    });
    const moved = await systemTransition(row, [row.state], 'running', {
      lastActivityAt: agentInstanceClock.now(),
    });
    if (!moved) return 'noop';
    await armIdleTimer(row);
    return 'running';
  },

  /**
   * SETTLE A STOP (`hibernating`), idempotently: once Fly reports the machine
   * stopped, close the interval at Fly's stop instant with `endReason` and move
   * to `hibernated`. A machine found gone fails the instance (`lost`). Called
   * inline by {@link beginHibernate} with the reason it was started for, and by
   * the sweep for a stop a previous pass left in motion (then `hibernated`).
   */
  async settleStop(
    instanceId: string,
    endReason: AgentInstanceIntervalEndReason = 'hibernated',
  ): Promise<'hibernated' | 'failed' | 'pending' | 'noop'> {
    const row = await withSystemContext((tx) => agentInstanceRepository.findById(instanceId, tx));
    if (!row || row.deletedAt || row.state !== 'hibernating') return 'noop';
    const handle = handleOf(row);
    /* v8 ignore next -- a hibernating instance was running, so it has a handle. */
    if (!handle) return 'pending';
    let status;
    try {
      status = await getPersistentOrchestrator().describePersistent(handle);
    } catch {
      return 'pending';
    }
    if (status.state === 'gone') {
      await failInstance(
        row,
        'The machine was lost while it was stopping. Its home may be gone; delete it.',
      );
      return 'failed';
    }
    if (status.state !== 'stopped') return 'pending';
    await closeOpenInterval(row, status.stoppedAt ?? agentInstanceClock.now(), endReason);
    return (await systemTransition(row, ['hibernating'], 'hibernated')) ? 'hibernated' : 'noop';
  },

  /**
   * SETTLE A DELETE (`deleting`), idempotently: destroy the machine then the
   * volume, close the open interval (`deleted`), release the slot, stamp
   * `deletedAt`. A destroy that fails leaves the instance `deleting` for the sweep.
   */
  async settleDelete(instanceId: string): Promise<'deleted' | 'pending' | 'noop'> {
    const row = await withSystemContext((tx) => agentInstanceRepository.findById(instanceId, tx));
    if (!row || row.deletedAt || row.state !== 'deleting') return 'noop';
    const handle = handleOf(row);
    if (handle) {
      try {
        await getPersistentOrchestrator().destroyPersistent(handle);
      } catch (err) {
        console.warn('[agentInstanceLifecycle] destroy failed; the sweep will retry it', {
          instanceId: row.id,
          detail: describeError(err),
        });
        return 'pending';
      }
    }
    await closeOpenInterval(row, agentInstanceClock.now(), 'deleted');
    await withWorkspaceServiceContext(row.workspaceId, (tx) =>
      agentInstanceRepository.markDeleted(row.id, agentInstanceClock.now(), tx),
    );
    return 'deleted';
  },

  /**
   * Ask a RUNNING agent's terminal server for its sign-in now and record it
   * (`agent-instance-run.md` §4 — the start's live probe). Null when the agent is
   * not running, has no handle, or the query gave no answer.
   */
  async probeSignIn(instanceId: string): Promise<AgentSignInAnswer | null> {
    const row = await withSystemContext((tx) => agentInstanceRepository.findById(instanceId, tx));
    if (!row || row.deletedAt || row.state !== 'running') return null;
    const handle = handleOf(row);
    if (!handle) return null;
    return probeSignIn(row, handle);
  },

  /** Bump the idle signal (§2) — the later stories' relay and runs call it. */
  async touchActivity(instanceId: string): Promise<void> {
    await agentInstanceActivityService.touchActivity(instanceId);
  },

  /**
   * THE RUNNING CHARGE (AMENDMENT 2) — charge a running machine for the minutes it
   * has already used, without stopping it. The open interval closes `rolled` at its
   * last WHOLE-minute boundary and the next interval of the same run opens there,
   * in one transaction; the closed one is then charged like any other, once, under
   * its own key. So the organisation's balance falls while the machine runs, and a
   * later credit check sees it — which a charge made only when the machine stops
   * could never give. Whole minutes keep the rounding exact: ⌈seconds ÷ 60⌉ of a
   * whole-minute interval is its minutes, and only a run's final interval rounds.
   * The run — its slot and its 12-hour backstop — carries on untouched.
   */
  async rollInterval(instanceId: string): Promise<'rolled' | 'noop'> {
    const row = await withSystemContext((tx) => agentInstanceRepository.findById(instanceId, tx));
    if (!row || row.deletedAt || row.state !== 'running') return 'noop';
    const now = agentInstanceClock.now();
    const rolled = await withWorkspaceServiceContext(row.workspaceId, async (tx) => {
      const open = await agentInstanceIntervalRepository.findOpen(row.id, tx);
      if (!open) return null;
      const wholeMinutes = Math.floor((now.getTime() - open.startedAt.getTime()) / 60_000);
      if (wholeMinutes < 1) return null;
      const boundary = new Date(open.startedAt.getTime() + wholeMinutes * 60_000);
      // The close is guarded: a hibernate or delete that closed it first wins, and
      // this roll then opens nothing.
      const moved = await agentInstanceIntervalRepository.close(
        open.id,
        { endedAt: boundary, endReason: 'rolled', billableSeconds: wholeMinutes * 60 },
        tx,
      );
      if (moved !== 1) return null;
      const nextId = randomUUID();
      await agentInstanceIntervalRepository.open(
        {
          id: nextId,
          workspaceId: row.workspaceId,
          organizationId: row.organizationId,
          agentInstanceId: row.id,
          runId: open.runId,
          runStartedAt: open.runStartedAt,
          startedAt: boundary,
          chargeReference: intervalChargeReference(nextId),
        },
        tx,
      );
      return open;
    });
    if (!rolled) return 'noop';
    try {
      await agentInstanceChargeService.chargeInterval(rolled.id);
    } catch (err) {
      console.error('[agentInstanceLifecycle] a running charge failed; the sweep will retry it', {
        instanceId: row.id,
        intervalId: rolled.id,
        detail: describeError(err),
      });
    }
    return 'rolled';
  },

  /**
   * RECONCILE ONE RUNNING INSTANCE against the machine (§5) — the sweep's read.
   * A machine found `stopped` (a crash with no restart, an operator) closes the
   * interval at Fly's stop instant and rests at `hibernated`; one found `gone`
   * fails the instance and closes the interval `lost` — charged either way.
   */
  async reconcileRunning(instanceId: string): Promise<'ok' | 'hibernated' | 'failed' | 'noop'> {
    const row = await withSystemContext((tx) => agentInstanceRepository.findById(instanceId, tx));
    if (!row || row.deletedAt || row.state !== 'running') return 'noop';
    const handle = handleOf(row);
    if (!handle) return 'noop';
    let status;
    try {
      status = await getPersistentOrchestrator().describePersistent(handle);
    } catch {
      return 'noop';
    }
    if (status.state === 'gone' || status.state === 'failed') {
      await failInstance(
        row,
        'The machine was lost. Its home may be gone; wake it to try again, or delete it.',
      );
      return 'failed';
    }
    if (status.state === 'stopped') {
      // A machine that stopped behind Motir's back takes its run with it (§6).
      await endRunIn(row, 'failed', RUN_AGENT_STOPPED);
      if (!(await systemTransition(row, ['running'], 'hibernated'))) return 'noop';
      await closeOpenInterval(row, status.stoppedAt ?? agentInstanceClock.now(), 'hibernated');
      return 'hibernated';
    }
    return 'ok';
  },
};

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === 'P2002';
}
