import type { AgentInstance } from '@/generated/prisma/client';
import { INSTANCE_MAX_PER_USER } from '@/lib/agentInstances/config';
import {
  AgentInstanceImageTooOldError,
  AgentInstanceNotFoundError,
  AgentInstanceStateConflictError,
  AgentInstancesUnavailableError,
  AgentInstanceWrongProjectError,
  AgentNotSignedInError,
  AgentProfileCannotRunError,
  AgentRunCardNotReadyError,
} from '@/lib/agentInstances/errors';
import { profileCanRunCards, profileDisplayName } from '@/lib/agentInstances/profiles';
import {
  AGENT_RUN_LAUNCH_TIMEOUT_SECONDS,
  agentRunLaunchCommand,
  isAgentTerminalConfigured,
  parseLaunchAnswer,
} from '@/lib/agentInstances/terminal';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import { DispatchRunAgentBusyError, DispatchRunTerminalError } from '@/lib/dispatchRuns/errors';
import type {
  AgentRunAgentRefusal,
  AgentRunStartedDto,
  AgentsForCardDto,
} from '@/lib/dto/agentInstanceRuns';
import {
  hostedRunWriteAccess,
  repositoriesForItems,
  revokeRunGitCredentials,
} from '@/lib/github/runGitCredential';
import {
  HostedRunRepositoryNotWritableError,
  type RunGitWriteRefusal,
} from '@/lib/hostedRuns/errors';
import { latestRunCredentialExpiry } from '@/lib/hostedRuns/limits';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { toAgentForCardDto } from '@/lib/mappers/agentInstanceRunMappers';
import { getPersistentOrchestrator, isPersistentOrchestratorConfigured } from '@/lib/orchestrator';
import { PermissionDeniedError } from '@/lib/projects/errors';
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';
import {
  dispatchRunRepository,
  type RunningDispatchRunInAgent,
} from '@/lib/repositories/dispatchRunRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import {
  agentInstanceClock,
  agentInstanceHandle,
  agentInstanceLifecycleService,
} from '@/lib/services/agentInstanceLifecycleService';
import { ciAllowanceService } from '@/lib/services/ciAllowanceService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectsService } from '@/lib/services/projectsService';
import { runCredentialService } from '@/lib/services/runCredentialService';
import { scopeClaimService } from '@/lib/services/scopeClaimService';
import { workItemsService } from '@/lib/services/workItemsService';
import { isClaimableState } from '@/lib/workItems/claimOutcome';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  withSystemContext,
  withWorkspaceContext,
  withWorkspaceServiceContext,
} from '@/lib/workspaces/context';

// START A CARD'S RUN IN THE DEVELOPER'S OWN AGENT (Story MOTIR-6864 · MOTIR-7026,
// `docs/decisions/agent-instance-run.md` §1, §2, §4, §5) — the counterpart of
// `hostedRunService.start`, reusing its readiness rule, its leg order and its
// repository pre-flight, and NEVER its gateway half: no run key is minted, no
// model is chosen, no container is booted and no `AgentRunUsage` row is written.
// The run's machine time is the agent's own interval (§5).
//
// ⚠️ EVERY REFUSAL COMES BEFORE ANYTHING IS STARTED, in §4's order: access, the
// agent (the caller's, live, on the card's project), the card ready, no run
// already running in the agent, the image carries the launcher and the profile
// has an unattended command, the coding agent not recorded signed out, every
// repository writable. Each is a read. Then the WAKE, when the agent sleeps — its
// own refusals (credits, the fleet) pass through unchanged, and still nothing is
// opened. Only then is the run opened, its cards claimed and stamped, and the
// rest handed to the durable launch job.
//
// ⚠️ THE LAUNCH IS A JOB, AND THE RUN TOKEN IS MINTED THERE, NOT HERE. §4 has the
// route answer at once and a job wait for the agent to come up. The token must
// reach the agent on the exec's stdin (§2), and a job payload and a step memo are
// database rows that may hold no secret (`HostedRunSuperviseData`'s rule) — and
// only a token's hash is stored — so the token is minted by the launch step
// itself, in the same breath as the exec that carries it.
//
// ⚠️ THE RACE IS THE DATABASE'S. Two starts on one agent both pass the busy read;
// the partial unique index lets one open, and `dispatchRunService.open` names the
// winner to the loser (`namedAgentBusy`), whose refusal then names its card too.
//
// What happens AFTER the launch — the supervise job, the stall window, Cancel,
// the lost machine and every other close — is MOTIR-7027's, on {@link end}.

/** What a start request asks for. */
export interface StartAgentRunInput {
  workItemKey: string;
  agentInstanceId: string;
  /** Optional: a repeated key answers the run it already started. */
  idempotencyKey?: string | undefined;
}

/** How long the launch job waits for a woken agent to come up before failing the run. */
export const AGENT_RUN_BOOT_WAIT_MS = 10 * 60 * 1000;

/** How often the launch job looks again at an agent still coming up. */
export const AGENT_RUN_LAUNCH_POLL_MS = 15_000;

/** The one idempotency key a launch job is enqueued under. */
export function agentRunLaunchKey(dispatchRunId: string): string {
  return `agent-instance-run:${dispatchRunId}`;
}

/** The ends this card closes a run with (MOTIR-7027 adds the lifecycle's). */
export type AgentRunEndOutcome = 'failed';

const CLOSE_FOR: Record<
  AgentRunEndOutcome,
  { stopReason: 'halted'; status: 'failed'; label: string }
> = {
  failed: { stopReason: 'halted', status: 'failed', label: 'failed' },
};

function projectKeyOf(identifier: string): string {
  const dash = identifier.lastIndexOf('-');
  return dash > 0 ? identifier.slice(0, dash) : identifier;
}

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : String(err);
}

/**
 * The legs of a parent run in DEPENDENCY order — `hostedRunService`'s order, so
 * a parent runs its children in the order every other run of it does.
 */
function orderLegs(
  children: readonly string[],
  edges: ReadonlyArray<{ fromId: string; toId: string }>,
): string[] {
  const blockers = new Map<string, string[]>();
  for (const e of edges) blockers.set(e.fromId, [...(blockers.get(e.fromId) ?? []), e.toId]);
  const placed = new Set<string>();
  const out: string[] = [];
  let remaining = [...children];
  while (remaining.length > 0) {
    const ready = remaining.filter((id) => (blockers.get(id) ?? []).every((b) => placed.has(b)));
    const batch = ready.length > 0 ? ready : remaining;
    for (const id of batch) {
      out.push(id);
      placed.add(id);
    }
    const done = new Set(batch);
    remaining = remaining.filter((id) => !done.has(id));
  }
  return out;
}

/** Does the image pinned today carry the launcher (§4: never probed for it reads as no)? */
function hasLauncher(row: AgentInstance): boolean {
  return row.runLauncher === 'present' && row.runLauncherDigest === row.imageDigest;
}

/**
 * THE AGENT'S OWN REFUSAL, if any — the §4 checks that belong to the agent rather
 * than to the card, in the start's order. One function for the start and the
 * picker, so a row the picker offers is a row the start accepts.
 */
function agentRefusal(
  row: AgentInstance,
  running: RunningDispatchRunInAgent | null,
  signIn: AgentInstance['signInState'] = row.signInState,
): AgentRunAgentRefusal | null {
  if (row.state === 'hibernating' || row.state === 'deleting') {
    return 'agent_instance_state_conflict';
  }
  if (running) return 'agent_instance_run_active';
  if (!profileCanRunCards(row.profileId)) return 'agent_profile_cannot_run';
  if (!hasLauncher(row)) return 'agent_instance_image_too_old';
  if (signIn === 'signed_out') return 'agent_not_signed_in';
  return null;
}

/** The typed error for an agent refusal (the running run is named by the caller). */
function refusalError(
  refusal: Exclude<AgentRunAgentRefusal, 'agent_instance_run_active'>,
  row: AgentInstance,
): Error {
  const name = profileDisplayName(row.profileId);
  switch (refusal) {
    case 'agent_instance_state_conflict':
      return new AgentInstanceStateConflictError(row.id, row.state, 'given a run');
    case 'agent_profile_cannot_run':
      return new AgentProfileCannotRunError(row.profileId, name);
    case 'agent_instance_image_too_old':
      return new AgentInstanceImageTooOldError(row.id);
    case 'agent_not_signed_in':
      return new AgentNotSignedInError(row.id, name);
  }
}

/** The card a running run works on, for the refusal's words. */
async function targetKeyOf(workspaceId: string, runId: string): Promise<string | null> {
  const keys = await withWorkspaceServiceContext(workspaceId, (tx) =>
    dispatchRunRepository.findTargetKeys([runId], tx),
  );
  return keys.get(runId) ?? null;
}

/** A busy refusal, naming the running run's card when the run is known. */
async function namedBusy(
  err: DispatchRunAgentBusyError,
  workspaceId: string,
): Promise<DispatchRunAgentBusyError> {
  if (err.runId === null || err.workItemKey !== null) return err;
  return new DispatchRunAgentBusyError(
    err.agentInstanceId,
    err.runId,
    await targetKeyOf(workspaceId, err.runId),
  );
}

/** What the start reads about the card: a leaf's one leg, or a parent's legs in order. */
async function readyLegs(
  project: { id: string },
  item: { id: string; identifier: string },
  ctx: ServiceContext,
): Promise<{ legIds: string[]; isParent: boolean }> {
  const children = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    workItemRepository.findChildren(item.id, tx),
  );
  if (children.length > 0) {
    const preview = await scopeClaimService.previewWorkItemScope(project.id, item.identifier, ctx);
    if (!preview.ok) throw new AgentRunCardNotReadyError(item.identifier, preview.detail);
    const edges = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemLinkRepository.findBlockedByAmong(
        preview.childIds,
        preview.childIds,
        ctx.workspaceId,
        tx,
      ),
    );
    return { legIds: orderLegs(preview.childIds, edges), isParent: true };
  }
  const state = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    workItemRepository.findClaimStateById(item.id, tx),
  );
  /* v8 ignore next -- the row was resolved a moment ago; only a delete in between gets here */
  if (!state) throw new AgentRunCardNotReadyError(item.identifier, 'it no longer exists');
  if (!isClaimableState(state)) {
    throw new AgentRunCardNotReadyError(
      item.identifier,
      `it is ${state.status}, not in the to-do category`,
    );
  }
  const readiness = await workItemsService.getReadiness(item.id, ctx);
  if (!readiness.ready) {
    throw new AgentRunCardNotReadyError(item.identifier, 'it is waiting on an open blocker');
  }
  return { legIds: [item.id], isParent: false };
}

/** Every repository of the run writable by Motir's App — the hosted pre-flight (§4 check 7). */
async function assertRepositoriesWritable(
  projectId: string,
  legIds: string[],
  ctx: ServiceContext,
): Promise<void> {
  const repositories = await repositoriesForItems(projectId, ctx.workspaceId, legIds);
  const access = await hostedRunWriteAccess(repositories, 'write');
  const refusals = access.filter((a): a is Extract<typeof a, { ok: false }> => !a.ok);
  if (refusals.length > 0) {
    throw new HostedRunRepositoryNotWritableError(
      refusals.map(({ ok: _ok, app: _app, ...refusal }) => refusal as RunGitWriteRefusal),
      repositories.length,
    );
  }
}

async function readAgent(instanceId: string): Promise<AgentInstance | null> {
  return withSystemContext((tx) => agentInstanceRepository.findById(instanceId, tx));
}

/** One pass of the launch job's wait: go, stop, or come back at `deferUntil`. */
export type AgentRunWaitVerdict = 'ready' | 'noop' | 'failed' | { deferUntil: Date };

export const agentInstanceRunService = {
  /**
   * START a card's run in the caller's own agent (§4). Answers once the run is
   * open, its cards claimed and its launch enqueued; the launch job wakes nothing
   * and waits for the agent this start woke.
   *
   * Throws, with NOTHING opened, claimed, minted or woken: the access errors
   * (`PermissionDeniedError` for `instance:use`, `ProjectAccessDeniedError`),
   * `AgentInstanceNotFoundError`, `AgentInstanceWrongProjectError`,
   * `AgentInstanceStateConflictError`, `AgentRunCardNotReadyError`,
   * `DispatchRunAgentBusyError` (naming the running run and its card),
   * `AgentProfileCannotRunError`, `AgentInstanceImageTooOldError`,
   * `AgentNotSignedInError`, `HostedRunRepositoryNotWritableError`,
   * `AgentInstancesUnavailableError`, `CiCreditsExhaustedError`. Then the wake's
   * own refusals, UNCHANGED (`AgentInstanceStartRefusedError`, …) — still with
   * nothing opened. A failure after the open ends the run `failed` and is rethrown.
   */
  async start(input: StartAgentRunInput, ctx: ServiceContext): Promise<AgentRunStartedDto> {
    const identifier = input.workItemKey.trim().toUpperCase();

    // ── 1 · Access: `instance:use` on the project and edit on the card ────────
    const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
    await projectAccessService.assertPermission(project.id, ctx, 'instance:use');
    await projectAccessService.assertCanEdit(project.id, ctx);
    const item = await workItemsService.getWorkItemByIdentifier(project.id, identifier, ctx);

    // ── 0 · The same press again — answered with the run it already started ──
    if (input.idempotencyKey) {
      const key = input.idempotencyKey;
      const already = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        dispatchRunRepository.findByIdempotencyKey(ctx.workspaceId, key, tx),
      );
      if (already) return { dispatchRunId: already.id, created: false, woke: false };
    }

    // ── 2 · The agent: the caller's, live, on the card's project ─────────────
    const agent = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => agentInstanceRepository.findLiveForOwner(input.agentInstanceId, ctx.userId, tx),
    );
    if (!agent) throw new AgentInstanceNotFoundError(input.agentInstanceId);
    if (agent.projectId !== project.id) throw new AgentInstanceWrongProjectError(agent.id);
    if (agent.state === 'hibernating' || agent.state === 'deleting') {
      throw refusalError('agent_instance_state_conflict', agent);
    }

    // ── 3 · The card is ready ────────────────────────────────────────────────
    const { legIds, isParent } = await readyLegs(project, item, ctx);

    // ── 4 · No run already running in the agent (the index is the real guard) ─
    const running = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      dispatchRunRepository.findRunningByAgentInstance(agent.id, tx),
    );
    if (running) {
      throw new DispatchRunAgentBusyError(
        agent.id,
        running.id,
        await targetKeyOf(ctx.workspaceId, running.id),
      );
    }

    // ── 5, 6 · The profile, the image, the sign-in ───────────────────────────
    if (!isPersistentOrchestratorConfigured() || !isAgentTerminalConfigured()) {
      throw new AgentInstancesUnavailableError('an agent cannot be reached to start a run');
    }
    // A RUNNING agent is asked now (§4: the start's own live probe), and its answer
    // wins over the record; a sleeping one's last answer stands, and the launch
    // job asks again once it is up. A probe that gives no answer leaves the record.
    const live =
      agent.state === 'running' && agentRefusal(agent, null, 'unknown') === null
        ? await agentInstanceLifecycleService.probeSignIn(agent.id)
        : null;
    const refusal = agentRefusal(agent, null, live ?? agent.signInState);
    if (refusal !== null) {
      throw refusalError(
        refusal as Exclude<AgentRunAgentRefusal, 'agent_instance_run_active'>,
        agent,
      );
    }

    // ── 7 · Every repository writable; the CI-credit gate every dispatch runs ─
    await assertRepositoriesWritable(project.id, legIds, ctx);
    await ciAllowanceService.assertDispatchAllowed(ctx);

    // ── 8 · Wake, when the agent sleeps — its refusals pass through UNCHANGED ─
    let woke = false;
    if (agent.state === 'hibernated' || agent.state === 'failed') {
      const woken = await agentInstanceLifecycleService.wake(project.identifier, agent.id, ctx);
      if (woken.state === 'failed') {
        throw new AgentInstanceStateConflictError(agent.id, woken.state, 'given a run');
      }
      woke = true;
    }

    // ── 9 · Open the run, one leg per card, `origin: instance` (§5) ──────────
    const legKeys = await withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
      const rows = await workItemRepository.findByIds(legIds, tx);
      const byId = new Map(rows.map((r) => [r.id, r.identifier]));
      return legIds.map((id) => byId.get(id) ?? '');
    });
    const command = isParent ? 'run_scope' : 'run';
    let opened;
    try {
      opened = await dispatchRunService.open(
        {
          projectKey: project.identifier,
          command,
          origin: 'instance',
          agentInstanceId: agent.id,
          agent: agent.profileId,
          idempotencyKey: input.idempotencyKey,
          cards: legKeys.map((key) => ({ key, disposition: 'queued' as const })),
          ...(isParent ? { scopeKey: identifier, scopeLabel: item.title } : {}),
        },
        ctx,
      );
    } catch (err) {
      // Lost the race to another start: the winner is named, with its card.
      if (err instanceof DispatchRunAgentBusyError) throw await namedBusy(err, ctx.workspaceId);
      throw err;
    }
    const run = opened.run;
    /* v8 ignore next -- race-only: two presses of one key both passed the read above */
    if (!opened.created) return { dispatchRunId: run.id, created: false, woke };

    try {
      await dispatchRunService.appendEvents(
        run.id,
        [
          {
            kind: 'run_opened',
            data: {
              command,
              key: identifier,
              origin: 'instance',
              agentInstanceId: agent.id,
              agent: agent.profileId,
            },
          },
        ],
        ctx,
      );

      // ── 10 · Claim and stamp every leg — `byok`, harness = the profile (§5) ─
      if (isParent) {
        const claim = await scopeClaimService.claimScope(
          { kind: 'work_item', projectId: project.id, identifier },
          ctx,
        );
        if (!claim.claimed) {
          throw new AgentRunCardNotReadyError(identifier, `its scope claim was ${claim.outcome}`);
        }
      } else {
        const claim = await workItemsService.claimWorkItem(project.id, identifier, ctx);
        if (claim.outcome !== 'claimed' && claim.outcome !== 'mine') {
          throw new AgentRunCardNotReadyError(identifier, `its claim was ${claim.outcome}`);
        }
      }
      await withWorkspaceContext(
        { userId: ctx.userId, workspaceId: ctx.workspaceId },
        async (tx) => {
          for (const id of legIds) {
            await workItemsService.recordImplementationProvenance(
              id,
              { source: 'byok', harness: agent.profileId, model: null },
              tx,
            );
          }
        },
      );

      // ── 11 · Hand the launch to its durable job — nothing secret in it ─────
      await sendEvent(
        'agent-instance-run/launch',
        {
          workspaceId: ctx.workspaceId,
          dispatchRunId: run.id,
          idempotencyKey: agentRunLaunchKey(run.id),
        },
        { strict: true },
      );
      return { dispatchRunId: run.id, created: true, woke };
    } catch (err) {
      await this.end(run.id, 'failed', `the run could not start: ${detailOf(err)}`);
      throw err;
    }
  },

  /**
   * THE LAUNCH JOB'S WAIT (§4) — one pass: `ready` once the run is still open and
   * its agent is `running`; `noop` for a run already closed (a cancel, a reap);
   * `failed` once the run was ended because its agent stopped or never came up.
   * An agent still `starting` / `waking` is settled once and the answer is
   * `{ deferUntil }` — the job DEFERS to it (the engine's defer is the jobs
   * runtime's, never a service's).
   */
  async awaitAgent(dispatchRunId: string): Promise<AgentRunWaitVerdict> {
    const run = await withSystemContext((tx) => dispatchRunRepository.findById(dispatchRunId, tx));
    if (!run || run.status !== 'running' || !run.agentInstanceId) return 'noop';
    let agent = await readAgent(run.agentInstanceId);
    if (agent && (agent.state === 'starting' || agent.state === 'waking')) {
      await agentInstanceLifecycleService.settleBoot(agent.id);
      agent = await readAgent(agent.id);
    }
    if (agent && !agent.deletedAt && agent.state === 'running') return 'ready';
    if (agent && !agent.deletedAt && (agent.state === 'starting' || agent.state === 'waking')) {
      const now = agentInstanceClock.now();
      if (now.getTime() - run.startedAt.getTime() < AGENT_RUN_BOOT_WAIT_MS) {
        return { deferUntil: new Date(now.getTime() + AGENT_RUN_LAUNCH_POLL_MS) };
      }
      await this.end(dispatchRunId, 'failed', 'the agent did not come up in time');
      return 'failed';
    }
    await this.end(dispatchRunId, 'failed', 'the agent stopped before the run could start');
    return 'failed';
  },

  /**
   * THE LAUNCH (§1, §2) — the launch job's memoized step, on a `running` agent:
   * the launcher and the sign-in read LIVE (a woken agent's boot probe has just
   * recorded both), then the run token minted and handed to
   * `motir agent-terminal run <KEY> --run-id <id>` on the exec's STDIN — never in
   * its argv, never in an environment. Any failure ends the run `failed` with
   * the reason in words, which revokes the token (§6 "the launch job finds …").
   * Returns JSON with no secret in it: the step memo is a database row.
   */
  async launchNow(dispatchRunId: string): Promise<'launched' | 'failed' | 'noop'> {
    const run = await withSystemContext((tx) => dispatchRunRepository.findById(dispatchRunId, tx));
    if (!run || run.status !== 'running' || !run.agentInstanceId || !run.createdById) {
      return 'noop';
    }
    const agent = await readAgent(run.agentInstanceId);
    const handle = agent ? agentInstanceHandle(agent) : null;
    if (!agent || agent.deletedAt || agent.state !== 'running' || !handle) {
      await this.end(dispatchRunId, 'failed', 'the agent stopped before the run could start');
      return 'failed';
    }
    const name = profileDisplayName(agent.profileId);
    if (!hasLauncher(agent)) {
      await this.end(dispatchRunId, 'failed', new AgentInstanceImageTooOldError(agent.id).message);
      return 'failed';
    }
    if ((await agentInstanceLifecycleService.probeSignIn(agent.id)) === 'signed_out') {
      await this.end(dispatchRunId, 'failed', new AgentNotSignedInError(agent.id, name).message);
      return 'failed';
    }

    const target = await targetKeyOf(run.workspaceId, run.id);
    /* v8 ignore next 4 -- every run this service opens has a scope or a first leg */
    if (!target) {
      await this.end(dispatchRunId, 'failed', 'the run names no card');
      return 'failed';
    }
    let detail: string;
    try {
      const credential = await runCredentialService.mintRunCredential({
        dispatchRunId,
        dispatcherUserId: run.createdById,
        expiresAt: latestRunCredentialExpiry(run.startedAt),
      });
      const result = await getPersistentOrchestrator().exec(
        handle,
        agentRunLaunchCommand(target, dispatchRunId),
        {
          timeoutSeconds: AGENT_RUN_LAUNCH_TIMEOUT_SECONDS,
          stdin: JSON.stringify({ apiUrl: resolveBaseUrlTrimmed(), token: credential.token }),
        },
      );
      const answer = parseLaunchAnswer(result);
      if (answer.ok) {
        await dispatchRunService.appendEvents(
          dispatchRunId,
          [
            {
              kind: 'log',
              body: `[motir] run started in agent ${agent.name} (${name})\n`,
              data: { agentInstanceId: agent.id, session: answer.session },
            },
          ],
          { userId: run.createdById, workspaceId: run.workspaceId },
        );
        await agentInstanceLifecycleService.touchActivity(agent.id);
        return 'launched';
      }
      detail = `the agent’s terminal server refused it (${answer.error})`;
    } catch (err) {
      detail = detailOf(err);
    }
    await this.end(dispatchRunId, 'failed', `the run could not start in the agent: ${detail}`);
    return 'failed';
  },

  /**
   * THE END PATH of a run in an agent (§6) — revoke the run token and every App
   * git token, then close the run ONLY IF it is still open (the CLI in the agent
   * closes the run it adopted), with a `log` line naming why. It mints and revokes
   * no gateway key: there is none. Idempotent, and never a throw. This card ends
   * only a launch that failed; MOTIR-7027 adds the lifecycle's ends (the lost
   * machine, the stall, Cancel) and stops the run's session in the agent.
   */
  async end(
    dispatchRunId: string,
    outcome: AgentRunEndOutcome,
    detail: string,
  ): Promise<{ closed: boolean; runCredential: number }> {
    let runCredential = 0;
    try {
      runCredential = (await runCredentialService.revokeRunCredential(dispatchRunId)).revoked;
    } catch (err) {
      /* v8 ignore next 4 -- a database fault mid end-path; the close below still runs */
      console.error('[agentInstanceRunService] could not revoke the run credential', {
        dispatchRunId,
        detail: detailOf(err),
      });
    }
    await revokeRunGitCredentials(dispatchRunId);

    const run = await withSystemContext((tx) => dispatchRunRepository.findById(dispatchRunId, tx));
    if (!run || run.status !== 'running' || !run.createdById)
      return { closed: false, runCredential };
    const ctx: ServiceContext = { userId: run.createdById, workspaceId: run.workspaceId };
    const close = CLOSE_FOR[outcome];
    try {
      await dispatchRunService.appendEvents(
        dispatchRunId,
        [
          {
            kind: 'log',
            body: `[motir] run in agent ended (${close.label}): ${detail}\n`,
            data: { end: outcome },
          },
        ],
        ctx,
      );
      await dispatchRunService.close(
        dispatchRunId,
        { stopReason: close.stopReason, status: close.status },
        ctx,
      );
      return { closed: true, runCredential };
    } catch (err) {
      /* v8 ignore next 6 -- the CLI closed it between the read and the close: its status stands */
      if (!(err instanceof DispatchRunTerminalError)) {
        console.error('[agentInstanceRunService] could not close the run', {
          dispatchRunId,
          detail: detailOf(err),
        });
      }
      return { closed: false, runCredential };
    }
  },

  /**
   * The caller's OWN agents on the card's project, each with the run it is
   * running and why it cannot run this card, if it cannot (§4) — the card's
   * agent picker (MOTIR-7028). Another member's agent never appears (§8). A
   * bounded number of queries, whatever the count: one list, one running-run
   * read for all of them, one read of those runs' cards. A caller without
   * `instance:use` has no agents to offer.
   */
  async listAgentsForCard(workItemKey: string, ctx: ServiceContext): Promise<AgentsForCardDto> {
    const identifier = workItemKey.trim().toUpperCase();
    const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
    await workItemsService.getWorkItemByIdentifier(project.id, identifier, ctx);
    try {
      await projectAccessService.assertPermission(project.id, ctx, 'instance:use');
    } catch (err) {
      if (err instanceof PermissionDeniedError) return { agents: [] };
      /* v8 ignore next -- the project was resolved above; browse cannot fail here */
      throw err;
    }
    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: project.id },
      async (tx) => {
        const rows = await agentInstanceRepository.listLiveForOwner(
          { ownerId: ctx.userId, projectId: project.id, take: INSTANCE_MAX_PER_USER, skip: 0 },
          tx,
        );
        const running = await dispatchRunRepository.findRunningByAgentInstances(
          rows.map((r) => r.id),
          tx,
        );
        const keys = await dispatchRunRepository.findTargetKeys(
          running.map((r) => r.id),
          tx,
        );
        const byAgent = new Map(running.map((r) => [r.agentInstanceId, r]));
        return {
          agents: rows.map((row) => {
            const run = byAgent.get(row.id) ?? null;
            return toAgentForCardDto(
              row,
              run ? { id: run.id, workItemKey: keys.get(run.id) ?? null } : null,
              agentRefusal(row, run),
            );
          }),
        };
      },
    );
  },
};
