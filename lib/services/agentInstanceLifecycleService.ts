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
  instanceMaxRunningPerOrg,
} from '@/lib/agentInstances/config';
import {
  AgentInstanceNameInvalidError,
  AgentInstanceNameTakenError,
  AgentInstanceNotFoundError,
  AgentInstanceStartRefusedError,
  AgentInstanceStateConflictError,
  AgentInstancesUnavailableError,
  AgentProfileNotOfferedError,
} from '@/lib/agentInstances/errors';
import { buildCloneCommand } from '@/lib/agentInstances/cloneCommand';
import { imageDigestResolver, pinnedImageReference } from '@/lib/agentInstances/imageDigest';
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
import type { AgentInstanceDto } from '@/lib/dto/agentInstances';
import {
  mintProjectReadCredentials,
  revokeInstanceCloneCredential,
} from '@/lib/github/runGitCredential';
import { machineCreditsFor } from '@/lib/hostedRuns/machineRate';
import { toAgentInstanceDto } from '@/lib/mappers/agentInstanceMappers';
import { getPersistentOrchestrator, isPersistentOrchestratorConfigured } from '@/lib/orchestrator';
import { agentInstanceIntervalRepository } from '@/lib/repositories/agentInstanceIntervalRepository';
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';
import { agentInstanceChargeService } from '@/lib/services/agentInstanceChargeService';
import { sendEvent } from '@/lib/jobs/sendEvent';
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

/** The clock, as a seam so a test can move time without sleeping. */
export const agentInstanceClock = {
  now: (): Date => new Date(),
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
  pollIntervalMs: 1_000,
};

/** One row of the Instances page: the instance plus its machine time this month. */
export interface AgentInstanceListItemDto extends AgentInstanceDto {
  profileName: string;
  /** Seconds of the running intervals overlapping the current calendar month (UTC). */
  machineSecondsThisMonth: number;
  /** The credits those seconds come to — each interval rounded up once, like its charge (§5). */
  creditsThisMonth: number;
}

export interface AgentInstanceListPageDto {
  instances: AgentInstanceListItemDto[];
  total: number;
}

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
      'Your organization’s credits can’t start a machine right now. Add credits to create or wake an instance.',
    );
  }
}

/**
 * Take a fleet slot for one running interval, with the instance lane's two caps
 * decided under the SAME admission lock (§6). Returns nothing on success; throws
 * the refusal in words otherwise. `countingSelf` says whether the instance being
 * started is already counted as running (a wake reads `hibernated`, so never).
 */
async function reserveSlot(input: {
  instanceId: string;
  intervalId: string;
  organizationId: string;
  workspaceId: string;
}): Promise<void> {
  const maxRunning = instanceMaxRunning();
  const maxPerOrg = instanceMaxRunningPerOrg();
  const verdict = await fleetCeilingService.reserve({
    workload: 'agent_instance',
    ref: input.instanceId,
    ownerRef: input.intervalId,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    ttlSeconds: INSTANCE_SLOT_TTL_SECONDS,
    guard: async (tx) => {
      const fleetWide = await agentInstanceRepository.countRunning({}, tx);
      if (fleetWide >= maxRunning) return 'fleet_instances';
      const inOrg = await agentInstanceRepository.countRunning(
        { organizationId: input.organizationId },
        tx,
      );
      if (inOrg >= maxPerOrg) return 'org_instances';
      return null;
    },
  });
  if (verdict.outcome !== 'deferred') return;
  if (verdict.reason === 'workload_cap' && verdict.detail === 'org_instances') {
    throw new AgentInstanceStartRefusedError(
      'org_cap',
      `Your organization already has ${maxPerOrg} instances running. Hibernate one to start another.`,
    );
  }
  throw new AgentInstanceStartRefusedError(
    'fleet_busy',
    'Motir is running as many machines as it can right now. Try again in a few minutes.',
  );
}

function releaseSlot(instanceId: string, intervalId: string): Promise<boolean> {
  return fleetCeilingService.release('agent_instance', instanceId, intervalId);
}

/**
 * Close the instance's open interval (if any) at `endedAt`, with `endReason`,
 * and release its slot. Idempotent: an instance with no open interval closes
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
    await releaseSlot(row.id, closed.id);
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

/** (Re)arm the instance's idle timer (§2) — the debounced `agent-instance/idle-check`. */
async function armIdleTimer(row: AgentInstance): Promise<void> {
  await sendEvent('agent-instance/idle-check', {
    workspaceId: row.workspaceId,
    instanceId: row.id,
  });
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

/** Move an instance to `failed` with its reason, closing its interval (`lost`) and releasing its slot. */
async function failInstance(row: AgentInstance, reason: string): Promise<void> {
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

async function waitFor(deadlineMs: number, done: () => Promise<boolean>): Promise<boolean> {
  const deadline = agentInstanceClock.now().getTime() + deadlineMs;
  for (;;) {
    if (await done()) return true;
    if (agentInstanceClock.now().getTime() >= deadline) return false;
    await agentInstanceClock.sleep(agentInstanceClock.pollIntervalMs);
  }
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
    return inProject(project, ctx, async (tx) => {
      const scope = { ownerId: ctx.userId, projectId: project.id };
      const rows = await agentInstanceRepository.listLiveForOwner({ ...scope, ...page }, tx);
      const total = await agentInstanceRepository.countLiveForOwner(scope, tx);
      const intervals = await agentInstanceIntervalRepository.listForInstancesSince(
        rows.map((r) => r.id),
        monthStart,
        tx,
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
      return {
        total,
        instances: rows.map((row) => ({
          ...toAgentInstanceDto(row),
          profileName: profileDisplayName(row.profileId),
          machineSecondsThisMonth: usage.get(row.id)?.seconds ?? 0,
          creditsThisMonth: usage.get(row.id)?.credits ?? 0,
        })),
      };
    });
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
        `You already have ${INSTANCE_MAX_PER_USER} instances. Delete one to create another.`,
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
    const intervalId = randomUUID();
    await reserveSlot({
      instanceId,
      intervalId,
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
      return toAgentInstanceDto(await reload(row));
    }

    await waitFor(
      INSTANCE_INLINE_BOOT_WAIT_MS,
      async () => (await this.settleBoot(instanceId)) !== 'pending',
    );
    return toAgentInstanceDto(await reload(row));
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
    const intervalId = randomUUID();
    await reserveSlot({
      instanceId,
      intervalId,
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
      await getPersistentOrchestrator().start(handle);
    } catch (err) {
      await failInstance(
        row,
        `The machine could not start: ${describeError(err)}. Wake to try again, or delete it.`,
      );
      return toAgentInstanceDto(await reload(row));
    }
    await waitFor(
      INSTANCE_INLINE_BOOT_WAIT_MS,
      async () => (await this.settleBoot(instanceId)) !== 'pending',
    );
    return toAgentInstanceDto(await reload(row));
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
    await this.beginHibernate(row.id, 'hibernated');
    return toAgentInstanceDto(await reload(row));
  },

  /**
   * Start hibernating ONE running instance, for its owner or for the sweep
   * (MOTIR-6873: `idle`, `backstop`, `credits`). Guarded `running → hibernating`,
   * then `stop`, then a bounded settle. Returns false when the instance was not
   * running (somebody else moved it first) — never an error for the sweep.
   */
  async beginHibernate(
    instanceId: string,
    endReason: AgentInstanceIntervalEndReason,
  ): Promise<boolean> {
    const row = await withSystemContext((tx) => agentInstanceRepository.findById(instanceId, tx));
    if (!row || row.deletedAt || row.state !== 'running') return false;
    if (!(await systemTransition(row, ['running'], 'hibernating'))) return false;
    const handle = handleOf(row);
    if (handle) {
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
        );
        return 'failed';
      }
    }
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

  /** Bump the idle signal (§2) — the later stories' relay and runs call it. */
  async touchActivity(instanceId: string): Promise<void> {
    const row = await withSystemContext((tx) => agentInstanceRepository.findById(instanceId, tx));
    if (!row) return;
    const moved = await withWorkspaceServiceContext(row.workspaceId, (tx) =>
      agentInstanceRepository.touchActivity(row.id, agentInstanceClock.now(), tx),
    );
    if (moved === 1 && row.state === 'running') await armIdleTimer(row);
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
