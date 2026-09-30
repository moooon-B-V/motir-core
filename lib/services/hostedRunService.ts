import { FLEET_CONTAINER_SIZE, type TeardownReason } from '@motir/orchestrator';
import { checkAgentRunCredits } from '@/lib/ai/motirAiClient';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import { DispatchRunTerminalError } from '@/lib/dispatchRuns/errors';
import {
  hostedRunWriteAccess,
  repositoriesForItems,
  revokeRunGitCredentials,
  type RunRepository,
} from '@/lib/github/runGitCredential';
import {
  HostedModelsUnavailableError,
  HostedRunAlreadyEndedError,
  HostedRunBootFailedError,
  HostedRunCancelForbiddenError,
  HostedContinueRefusedError,
  HostedRunCardNotReadyError,
  HostedRunCreditsUnavailableError,
  HostedRunNotFoundError,
  HostedRunOutOfCreditsError,
  HostedRunRepositoryNotWritableError,
  type RunGitWriteRefusal,
} from '@/lib/hostedRuns/errors';
import {
  HOSTED_RUN_STALL_WINDOW_MS,
  HOSTED_RUN_TIMEOUT_MS,
  hostedRunStallWindowMs,
  latestRunCredentialExpiry,
} from '@/lib/hostedRuns/limits';
import { hostedRunDispatchId } from '@/lib/hostedRuns/ids';
import type { MemoizingSteps } from '@/lib/jobs/supervision/inProcessSteps';
import { sendEvent } from '@/lib/jobs/sendEvent';
import type { HostedRunSuperviseData } from '@/lib/jobs/types';
import { hostedAgentFleetConfig } from '@/lib/orchestrator';
import { dispatchRunEventRepository } from '@/lib/repositories/dispatchRunEventRepository';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { ciAllowanceService } from '@/lib/services/ciAllowanceService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import {
  hostedAgentContainerService,
  type HostedAgentContainerOutcome,
  type HostedAgentContainerRequest,
  type HostedAgentLivenessVerdict,
  type HostedAgentSession,
  type HostedAgentSupervisionOptions,
} from '@/lib/services/hostedAgentContainerService';
import { hostedRunKeyService } from '@/lib/services/hostedRunKeyService';
import { hostedRunModelService, toOpenCodeModel } from '@/lib/services/hostedRunModelService';
import { projectHostedAgentSettingsService } from '@/lib/services/projectHostedAgentSettingsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectsService } from '@/lib/services/projectsService';
import { runCredentialService } from '@/lib/services/runCredentialService';
import { scopeClaimService } from '@/lib/services/scopeClaimService';
import { workItemContinueService } from '@/lib/services/workItemContinueService';
import { workItemsService } from '@/lib/services/workItemsService';
import { isClaimableState } from '@/lib/workItems/claimOutcome';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  withSystemContext,
  withWorkspaceContext,
  withWorkspaceServiceContext,
} from '@/lib/workspaces/context';

// START A HOSTED RUN, AND SUPERVISE IT (Story MOTIR-683 · MOTIR-690) — the
// composer `hostedAgentContainerService` was written to be composed by: *"no
// prompt, no run-scoped token, no gateway key, no pull request, no run record —
// those are the composer's"*. `docs/decisions/hosted-agent-run.md` and
// `docs/decisions/hosted-run-runs-the-cli-as-the-app.md` are the decisions.
//
// ⚠️ EVERY REFUSAL COMES BEFORE ANY SPEND, in this order: the card is ready, the
// model is offered, the organization has credits, every repository the run
// touches can be written, the fleet is configured. Each is a read. Only then is
// the run opened, its cards claimed, its two credentials minted and its machine
// booted — and a failure from that point on hands the run to the end path, so
// nothing minted before it is left alive.
//
// ⚠️ THE CONTAINER IS BOOTED HERE, IN THE REQUEST, AND THAT IS NOT A SHORTCUT.
// The boot's env carries the run credential and the gateway key. A job payload is
// a `job_queue` row and a step memo is a `job_step` row: neither may hold a
// secret. So the start path boots, and the durable job supervises the SESSION the
// boot returned — which is JSON with no secret in it (`HostedRunSuperviseData`).
//
// ⚠️ A RUN IS A RUN, NOT A CARD (the CLI-in-a-container decision). A LEAF is one
// leg; a PARENT is every child its scope claim yields, in dependency order. The
// repository set, the write-access check and the container are all the RUN's.

/** What a start request asks for. `model` is the BARE gateway id. */
export interface StartHostedRunInput {
  workItemKey: string;
  /**
   * The bare model id the person picked. ABSENT means "the server chooses"
   * (Story MOTIR-6989 · MOTIR-6994): the card's model is resolved from its
   * difficulty — a parent's highest among its unfinished leaves — through the
   * project's overrides and motir-ai's defaults (`resolveForWorkItem`), then
   * checked exactly as a sent model is. A sent model always wins.
   */
  model?: string;
  idempotencyKey: string;
  /**
   * `run` (the default) starts a READY card. `continue` (MOTIR-6792) resumes a
   * card whose last run DIED, on that run's branches: the container runs
   * `motir continue <KEY>` instead of `motir run <KEY>`.
   */
  mode?: 'run' | 'continue';
}

/** A start whose model is settled — sent by the person, or resolved by the server. */
type ResolvedStartInput = StartHostedRunInput & { model: string };

export interface HostedRunStarted {
  dispatchRunId: string;
  /** False when `idempotencyKey` named a run already started: nothing new happened. */
  created: boolean;
}

/** Seams a test drives. Nothing here lengthens a shipped budget. */
export interface HostedRunStartOptions {
  now?: () => Date;
  /** Passed to the container boot (its clock, its budgets). */
  supervision?: HostedAgentSupervisionOptions;
}

/**
 * How a hosted run ended, as the END PATH names it (MOTIR-6450).
 *
 * ⚠️ THERE IS NO `succeeded`, AND THAT IS THE POINT. The CLI in the container
 * decides success: it closes the run it adopted `succeeded` exactly as a local run
 * does, after linking its pull requests and moving its cards. The container's
 * exit code is the CLI's own, so an `exited` container is only a container that
 * stopped by itself — a run still OPEN at that moment is a CRASH (the CLI died
 * before closing it; `20` means the launcher never reached the CLI at all), and
 * it is closed `failed`, never `succeeded`.
 */
export type HostedRunEndOutcome =
  | 'exited'
  | 'failed'
  | 'cancelled'
  | 'backstop'
  | 'stall'
  | 'lost_supervision';

/** The exit code the image's launcher uses when it never reached the CLI. */
export const HOSTED_LAUNCHER_NEVER_REACHED_CLI = 20;

/** What {@link hostedRunService.endHostedRun} did — never a throw. JSON, because the
 *  supervisor memoizes it. */
export interface HostedRunEndResult {
  /** True when THIS call closed the run; false when the CLI (or an earlier call) had. */
  closed: boolean;
  runKey: 'revoked' | 'failed';
  runCredential: number;
  gitCredentials: { revoked: number; failed: number };
}

/** The idempotent step the supervisor ends a run under, once its container settled. */
export function hostedRunEndStepId(dispatchRunId: string): string {
  return `hosted-run-end:${dispatchRunId}`;
}

export { hostedRunDispatchId };

/** The `failureDetail` a stall settles with, and how the end path tells it apart. */
export const HOSTED_RUN_STALL_DETAIL = `stalled: no agent output for ${
  HOSTED_RUN_STALL_WINDOW_MS / 60_000
} minutes`;

/** The project key a `MOTIR-<n>` identifier belongs to. */
function projectKeyOf(identifier: string): string {
  const dash = identifier.lastIndexOf('-');
  return dash > 0 ? identifier.slice(0, dash) : identifier;
}

/**
 * The legs of a parent run in DEPENDENCY order — a stable topological sort over
 * the `is_blocked_by` edges among the children, ties broken by board position.
 * The CLI's drain orders its adopted legs the same way (`orderClaimedSet`), so
 * the positions on the run page are the order the container works them. A cycle
 * cannot drop a card: whatever cannot be placed is appended in input order.
 */
function orderLegs(
  children: ReadonlyArray<{ id: string }>,
  edges: ReadonlyArray<{ fromId: string; toId: string }>,
): string[] {
  const blockers = new Map<string, string[]>();
  for (const e of edges) blockers.set(e.fromId, [...(blockers.get(e.fromId) ?? []), e.toId]);
  const placed = new Set<string>();
  const out: string[] = [];
  let remaining = children.map((c) => c.id);
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

/** What the end path makes of a settled container. */
function endOutcomeFor(outcome: HostedAgentContainerOutcome): {
  outcome: HostedRunEndOutcome;
  detail: string;
} {
  if (outcome.outcome !== 'settled') {
    return {
      outcome: 'failed',
      detail: `the container ended as ${outcome.outcome}: ${outcome.detail}`,
    };
  }
  if (outcome.reason === 'job_completed') {
    return {
      outcome: 'exited',
      detail:
        outcome.exitCode === HOSTED_LAUNCHER_NEVER_REACHED_CLI
          ? `the container exited ${HOSTED_LAUNCHER_NEVER_REACHED_CLI}: the launcher never reached the CLI`
          : `the container exited ${String(outcome.exitCode)}`,
    };
  }
  if (outcome.reason === 'job_timed_out') {
    return outcome.failureDetail === HOSTED_RUN_STALL_DETAIL
      ? { outcome: 'stall', detail: HOSTED_RUN_STALL_DETAIL }
      : {
          outcome: 'backstop',
          detail:
            outcome.failureDetail ??
            `timed out at the ${HOSTED_RUN_TIMEOUT_MS / 3_600_000}-hour backstop`,
        };
  }
  if (outcome.reason === 'gate_revoked') return { outcome: 'cancelled', detail: 'cancelled' };
  return {
    outcome: 'failed',
    detail: outcome.failureDetail ?? `the container ended: ${outcome.reason}`,
  };
}

/** How a run is closed for an end outcome the CLI did not close it with. */
const CLOSE_FOR: Record<
  HostedRunEndOutcome,
  {
    stopReason: 'completed' | 'halted' | 'interrupted' | 'abandoned';
    status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
  }
> = {
  exited: { stopReason: 'halted', status: 'failed' },
  failed: { stopReason: 'halted', status: 'failed' },
  cancelled: { stopReason: 'interrupted', status: 'cancelled' },
  backstop: { stopReason: 'abandoned', status: 'timed_out' },
  stall: { stopReason: 'abandoned', status: 'timed_out' },
  lost_supervision: { stopReason: 'abandoned', status: 'timed_out' },
};

/** The word the run's closing `log` line names an end by — "crash" for a
 *  container that exited with its run still open. */
const END_LABEL: Record<HostedRunEndOutcome, string> = {
  exited: 'crash',
  failed: 'failed',
  cancelled: 'cancelled',
  backstop: 'backstop',
  stall: 'stalled',
  lost_supervision: 'lost supervision',
};

/** The `failureDetail` a cancelled run's container is torn down with. */
export const HOSTED_RUN_CANCEL_DETAIL = 'cancelled';

/** A request for a container that is already booted — the supervisor's. Its env
 *  and image are empty on purpose: the boot step replays the session (the
 *  `booted` option), and nothing reads either. */
function requestFromSession(session: HostedAgentSession): HostedAgentContainerRequest {
  return {
    dispatchId: session.dispatchId,
    runId: session.runId,
    dispatchRunId: session.dispatchRunId,
    organizationId: session.attribution.orgId,
    workspaceId: session.attribution.workspaceId,
    projectId: session.attribution.projectId,
    repoFullName: session.attribution.repoFullName,
    image: '',
    env: {},
    region: session.handle.region,
    size: session.size,
    timeoutSeconds: session.timeoutSeconds,
  };
}

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : String(err);
}

/** What the pre-flights settled — the inputs the boot needs. */
interface HostedRunPreflight {
  organizationId: string;
  repositories: RunRepository[];
  fleet: ReturnType<typeof hostedAgentFleetConfig>;
}

/**
 * EVERY REFUSAL BEFORE ANY SPEND, in order: the CI-credit gate, the model, the
 * organization's credits, every repository of the run writable, the fleet
 * configured. Each is a read. Shared by Run hosted and Continue hosted
 * (MOTIR-6792) so a continue costs and refuses exactly like a run.
 */
async function preflight(
  input: Pick<ResolvedStartInput, 'model'>,
  projectId: string,
  legIds: string[],
  ctx: ServiceContext,
): Promise<HostedRunPreflight> {
  // The CI-credit gate every dispatch entry point runs — here, before the run
  // opens, so an exhausted organization is refused rather than failed.
  await ciAllowanceService.assertDispatchAllowed(ctx);

  // ── 2 · The model, live — never a cache ──────────────────────────────────
  await hostedRunModelService.assertOffered(input.model);

  // ── 3 · Credits — the gateway's own balance rule ────────────────────────
  const organizationId = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    workspaceRepository.findOrganizationId(ctx.workspaceId, tx),
  );
  /* v8 ignore next -- a workspace always belongs to an organization */
  if (!organizationId) throw new HostedRunCreditsUnavailableError();
  const credits = await checkAgentRunCredits(organizationId);
  if (credits === null) throw new HostedRunCreditsUnavailableError();
  if (!credits.mayRun) throw new HostedRunOutOfCreditsError(credits.balanceCredits);

  // ── 3b · Every repository the run touches can be written ────────────────
  const repositories: RunRepository[] = await repositoriesForItems(
    projectId,
    ctx.workspaceId,
    legIds,
  );
  const access = await hostedRunWriteAccess(repositories);
  const refusals = access.filter((a): a is Extract<typeof a, { ok: false }> => !a.ok);
  if (refusals.length > 0) {
    throw new HostedRunRepositoryNotWritableError(
      refusals.map(({ ok: _ok, app: _app, ...refusal }) => refusal as RunGitWriteRefusal),
      repositories.length,
    );
  }
  // The fleet, last of the reads: an unconfigured deployment opens nothing.
  const fleet = hostedAgentFleetConfig();
  return { organizationId, repositories, fleet };
}

/**
 * Stamp the legs hosted, mint the run's two credentials, boot the container and
 * hand it to the durable supervisor — for a run already OPENED (by Run hosted's
 * open, or by the continue claim's hosted opening). A failure after this starts
 * is the caller's to end.
 */
async function launch(
  run: { id: string; startedAt: string },
  input: Pick<ResolvedStartInput, 'model'>,
  target: { identifier: string; projectId: string; legIds: string[] },
  checked: HostedRunPreflight,
  ctx: ServiceContext,
  options: HostedRunStartOptions,
  extraEnv: Record<string, string> = {},
): Promise<void> {
  const now = options.now ?? ((): Date => new Date());
  const { identifier, legIds } = target;
  const { organizationId, repositories, fleet } = checked;
  const project = { id: target.projectId };
  await withWorkspaceContext({ userId: ctx.userId, workspaceId: ctx.workspaceId }, async (tx) => {
    for (const id of legIds) {
      await workItemsService.recordImplementationProvenance(
        id,
        { source: 'hosted', harness: 'opencode', model: input.model },
        tx,
      );
    }
  });

  // ── 6 · The two credentials, each dying by the backstop ────────────────
  const startedAt = new Date(run.startedAt);
  const runKey = await hostedRunKeyService.mintRunKey(
    { id: run.id, organizationId, startedAt },
    input.model,
    now(),
  );
  const runCredential = await runCredentialService.mintRunCredential(
    {
      dispatchRunId: run.id,
      dispatcherUserId: ctx.userId,
      expiresAt: latestRunCredentialExpiry(startedAt),
    },
    now(),
  );

  // ── 7 · Boot — the launcher's inputs, and no other credential ─────────
  const request: HostedAgentContainerRequest = {
    dispatchId: hostedRunDispatchId(run.id),
    runId: run.id,
    dispatchRunId: run.id,
    organizationId,
    workspaceId: ctx.workspaceId,
    projectId: project.id,
    /* v8 ignore next -- `repositoriesForItems` refuses an empty set */
    repoFullName: repositories[0]?.repository ?? '',
    image: fleet.image,
    env: {
      MOTIR_DISPATCH_RUN_ID: run.id,
      MOTIR_WORK_ITEM_KEY: identifier,
      MOTIR_API_URL: resolveBaseUrlTrimmed(),
      MOTIR_RUN_TOKEN: runCredential.token,
      MOTIR_GATEWAY_URL: runKey.containerEnv.MOTIR_GATEWAY_URL,
      MOTIR_RUN_KEY: runKey.containerEnv.MOTIR_RUN_KEY,
      MOTIR_MODEL: toOpenCodeModel(input.model),
      ...extraEnv,
    },
    region: fleet.region,
    size: FLEET_CONTAINER_SIZE,
    timeoutSeconds: HOSTED_RUN_TIMEOUT_MS / 1000,
  };
  const booted = await hostedAgentContainerService.boot(request, options.supervision);
  if (booted.phase === 'terminal') {
    const detail = bootFailureDetail(booted.outcome);
    await hostedRunService.endHostedRun(run.id, 'failed', detail);
    throw new HostedRunBootFailedError(run.id, detail);
  }

  // ── 8 · Hand the booted session to the durable supervisor ─────────────
  try {
    await sendEvent(
      'hosted-run/supervise',
      {
        workspaceId: ctx.workspaceId,
        dispatchRunId: run.id,
        session: booted.session,
        idempotencyKey: hostedRunDispatchId(run.id),
      },
      { strict: true },
    );
  } catch (err) {
    // A container nobody supervises spends until the reaper finds it. Tear it
    // down now, through the seam's own settle, and fail the run.
    await hostedAgentContainerService.settle(booted.session, {
      done: true,
      reason: 'provision_failed' satisfies TeardownReason,
      startedAt: null,
      exitCode: null,
      failureDetail: 'its supervision could not be enqueued',
    });
    throw err;
  }
}

/**
 * CONTINUE HOSTED (Story MOTIR-6527 · MOTIR-6792) — Run hosted's start, with the
 * continue claim where the readiness check and the open were.
 *
 * ⚠️ THE ORDER IS THE CONTRACT. Read which card the continue takes over (the
 * card, or the parent of a dead parent run's leg) WITHOUT a lock; run every
 * pre-flight Run hosted runs, in its order, over the resumed run's repositories;
 * and only then take the claim — so a person told "out of credits" has not
 * locked the card against a teammate's terminal `motir continue`. The claim opens
 * the hosted run itself (its hosted opening, MOTIR-6790): one row is the lock and
 * the run, with ONE `run_opened`. A failure after it ends the run through the
 * shared end path, which never writes the card — so it is continuable again.
 */
async function startContinue(
  input: ResolvedStartInput,
  identifier: string,
  projectId: string,
  ctx: ServiceContext,
  options: HostedRunStartOptions,
  now: Date,
): Promise<HostedRunStarted> {
  const preview = await workItemContinueService.previewHostedContinue(
    projectId,
    identifier,
    ctx,
    now,
  );
  if (!preview.ok) {
    throw new HostedContinueRefusedError(
      identifier,
      preview.reason,
      preview.holder,
      preview.startedAt,
      preview.parentKey,
    );
  }
  const target = preview.key;
  const checked = await preflight(input, projectId, preview.legItemIds, ctx);

  let replayed = false;
  const claim = await workItemContinueService.claimContinue(projectId, target, ctx, now, {
    opening: {
      origin: 'hosted',
      agent: 'opencode',
      model: input.model,
      idempotencyKey: input.idempotencyKey,
    },
    onReplay: () => {
      replayed = true;
    },
  });
  // ⚠️ RACE-ONLY BELOW: the preview refused every state the claim refuses, so
  // these three answers reach here only when a terminal continue or another
  // start won in the gap between the preview and the claim's lock.
  /* v8 ignore next 9 -- race-only: the preview refused this state a moment earlier */
  if (claim.outcome === 'not_continuable') {
    throw new HostedContinueRefusedError(
      target,
      claim.reason ?? 'no_dead_run',
      claim.holder,
      claim.startedAt,
      claim.parentKey,
    );
  }
  // `mine` is the caller's OWN open continue — a terminal one, never this
  // opening (a repeat of the key is answered `claimed`). A hosted start does not
  // adopt a run somebody's terminal holds, even their own.
  /* v8 ignore next 3 -- race-only: a continue opened since the preview holds the lock */
  if (claim.outcome !== 'claimed' || claim.runId === null) {
    throw new HostedContinueRefusedError(target, 'taken', claim.holder, claim.startedAt);
  }
  const runId = claim.runId;
  // The same press, raced past the short-circuit above: its run is booting.
  /* v8 ignore next -- race-only: two presses of one key both passed the short-circuit */
  if (replayed) return { dispatchRunId: runId, created: false };
  /* v8 ignore next -- a `claimed` answer always carries its run's start */
  const startedAt = claim.startedAt ?? now.toISOString();

  try {
    await launch(
      { id: runId, startedAt },
      input,
      { identifier: target, projectId, legIds: preview.legItemIds },
      checked,
      ctx,
      options,
      { MOTIR_RUN_MODE: 'continue' },
    );
    return { dispatchRunId: runId, created: true };
  } catch (err) {
    if (!(err instanceof HostedRunBootFailedError)) {
      await hostedRunService.endHostedRun(
        runId,
        'failed',
        `the continue could not start: ${detailOf(err)}`,
      );
    }
    throw err;
  }
}

/**
 * The model a start runs on (MOTIR-6994): the person's pick when they sent one
 * (trimmed), else the card's resolution — a leaf's difficulty, a parent's highest
 * among its unfinished leaves. Nothing to resolve (motir-ai offers no model) is
 * `HostedModelsUnavailableError`, the same refusal the picker path answers; the
 * resolved id is then checked by the pre-flight exactly as a sent one is.
 */
async function settleModel(
  sent: string | undefined,
  workItemId: string,
  ctx: ServiceContext,
): Promise<string> {
  const picked = sent?.trim();
  if (picked) return picked;
  const resolved = await projectHostedAgentSettingsService.resolveForWorkItem(workItemId, ctx);
  if (!resolved) throw new HostedModelsUnavailableError('no model is offered');
  return resolved.model;
}

export const hostedRunService = {
  /**
   * Start a hosted run on a READY card — a leaf, or a parent through its
   * children — and return its id once its container is booted and supervised.
   *
   * Throws, before anything is opened: `HostedRunCardNotReadyError`,
   * `HostedModelNotOfferedError` / `HostedModelsUnavailableError`,
   * `HostedRunOutOfCreditsError` / `HostedRunCreditsUnavailableError`,
   * `HostedRunRepositoryNotWritableError`, `RunGitCredentialUnavailableError`,
   * `OrchestratorNotConfiguredError`, `CiCreditsExhaustedError`, and the not-found
   * errors of the card read. After the run opened, a failure ends it as `failed`
   * and is rethrown (`HostedRunBootFailedError` for a container that never came up).
   */
  async start(
    input: StartHostedRunInput,
    ctx: ServiceContext,
    options: HostedRunStartOptions = {},
  ): Promise<HostedRunStarted> {
    const now = options.now ?? ((): Date => new Date());
    const identifier = input.workItemKey.trim().toUpperCase();
    const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
    await projectAccessService.assertCanEdit(project.id, ctx);
    const item = await workItemsService.getWorkItemByIdentifier(project.id, identifier, ctx);

    // ── 0 · The same press again — answered with the run it already started ──
    // Before readiness, deliberately: the first press claimed the card, so a
    // retried request would otherwise be refused as not ready rather than told
    // which run it started.
    const already = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      dispatchRunRepository.findByIdempotencyKey(ctx.workspaceId, input.idempotencyKey, tx),
    );
    if (already) return { dispatchRunId: already.id, created: false };

    // A CONTINUE of a dead run (MOTIR-6792) — the card is In Progress by design,
    // so it takes the continue claim's path instead of the readiness below.
    if (input.mode === 'continue') {
      const model = await settleModel(input.model, item.id, ctx);
      return startContinue({ ...input, model }, identifier, project.id, ctx, options, now());
    }

    // ── 1 · READY — a leaf by the keyed claim's rule, a parent by the scope claim's ──
    const children = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepository.findChildren(item.id, tx),
    );
    const isParent = children.length > 0;
    let legIds: string[];
    if (isParent) {
      const preview = await scopeClaimService.previewWorkItemScope(project.id, identifier, ctx);
      if (!preview.ok) throw new HostedRunCardNotReadyError(identifier, preview.detail);
      const edges = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        workItemLinkRepository.findBlockedByAmong(
          preview.childIds,
          preview.childIds,
          ctx.workspaceId,
          tx,
        ),
      );
      legIds = orderLegs(
        preview.childIds.map((id) => ({ id })),
        edges,
      );
    } else {
      const state = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        workItemRepository.findClaimStateById(item.id, tx),
      );
      /* v8 ignore next -- the row was resolved above; only a delete in between gets here */
      if (!state) throw new HostedRunCardNotReadyError(identifier, 'it no longer exists');
      if (!isClaimableState(state)) {
        throw new HostedRunCardNotReadyError(
          identifier,
          `it is ${state.status}, not in the to-do category`,
        );
      }
      const readiness = await workItemsService.getReadiness(item.id, ctx);
      if (!readiness.ready) {
        throw new HostedRunCardNotReadyError(identifier, 'it is waiting on an open blocker');
      }
      legIds = [item.id];
    }
    // ── 1b · The model — the person's pick, else the card's difficulty ───────
    const model = await settleModel(input.model, item.id, ctx);
    const checked = await preflight({ model }, project.id, legIds, ctx);

    // ── 4 · Open the run, one leg per card, idempotent on the key ───────────
    const legKeys = await withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
      const rows = await workItemRepository.findByIds(legIds, tx);
      const byId = new Map(rows.map((r) => [r.id, r.identifier]));
      return legIds.map((id) => byId.get(id) ?? '');
    });
    const command = isParent ? 'run_scope' : 'run';
    const opened = await dispatchRunService.open(
      {
        projectKey: project.identifier,
        command,
        origin: 'hosted',
        agent: 'opencode',
        model,
        idempotencyKey: input.idempotencyKey,
        cards: legKeys.map((key) => ({ key, disposition: 'queued' as const })),
        ...(isParent ? { scopeKey: identifier, scopeLabel: item.title } : {}),
      },
      ctx,
    );
    const run = opened.run;
    if (!opened.created) return { dispatchRunId: run.id, created: false };

    try {
      await dispatchRunService.appendEvents(
        run.id,
        [
          {
            kind: 'run_opened',
            data: { command, key: identifier, origin: 'hosted', model },
          },
        ],
        ctx,
      );

      // ── 5 · Claim and stamp every leg ──────────────────────────────────────
      if (isParent) {
        const claim = await scopeClaimService.claimScope(
          { kind: 'work_item', projectId: project.id, identifier },
          ctx,
        );
        if (!claim.claimed) {
          throw new HostedRunCardNotReadyError(identifier, `its scope claim was ${claim.outcome}`);
        }
      } else {
        const claim = await workItemsService.claimWorkItem(project.id, identifier, ctx);
        if (claim.outcome !== 'claimed' && claim.outcome !== 'mine') {
          throw new HostedRunCardNotReadyError(identifier, `its claim was ${claim.outcome}`);
        }
      }
      await launch(
        run,
        { model },
        { identifier, projectId: project.id, legIds },
        checked,
        ctx,
        options,
      );
      return { dispatchRunId: run.id, created: true };
    } catch (err) {
      if (!(err instanceof HostedRunBootFailedError)) {
        await this.endHostedRun(run.id, 'failed', `the run could not start: ${detailOf(err)}`);
      }
      throw err;
    }
  },

  /**
   * ONE PASS of a booted run's supervision — the durable job's body. It usually
   * defers (`JobRunDefer`) and returns only once the container has settled, after
   * which the run is ended through {@link endHostedRun} in its own memoized step.
   *
   * No wall-clock deadline but the backstop the container was booted with. The
   * STALL read runs before every poll: a run whose latest event is older than the
   * stall window has an agent alive and silent, and is ended.
   */
  async supervise(
    jobRunId: string,
    data: HostedRunSuperviseData,
    options: HostedAgentSupervisionOptions & { steps: MemoizingSteps },
  ): Promise<HostedAgentContainerOutcome> {
    const outcome = await hostedAgentContainerService.advance(
      jobRunId,
      requestFromSession(data.session),
      {
        ...options,
        booted: data.session,
        liveness: (session, now) => this.livenessOf(data.dispatchRunId, session, now),
      },
    );
    const end = endOutcomeFor(outcome);
    await options.steps.run(hostedRunEndStepId(data.dispatchRunId), () =>
      this.endHostedRun(data.dispatchRunId, end.outcome, end.detail),
    );
    return outcome;
  },

  /**
   * What the supervisor reads before each poll (MOTIR-6450): a run a person
   * CANCELLED — closed `cancelled` by {@link cancel} — is torn down now with the
   * cancel's teardown reason; otherwise the stall read decides.
   */
  async livenessOf(
    dispatchRunId: string,
    session: HostedAgentSession,
    now: Date,
  ): Promise<HostedAgentLivenessVerdict> {
    const run = await withWorkspaceServiceContext(session.attribution.workspaceId, (tx) =>
      dispatchRunRepository.findById(dispatchRunId, tx),
    );
    if (run?.status === 'cancelled') {
      return { reason: 'gate_revoked', detail: HOSTED_RUN_CANCEL_DETAIL };
    }
    return this.stallDetail(dispatchRunId, session, now);
  },

  /**
   * CANCEL a running hosted run (MOTIR-6450) — the dispatcher or a project admin.
   *
   * It ends the run through {@link endHostedRun} at once: the gateway key, the run
   * credential and every git token are revoked, so the agent can spend and push
   * nothing more, and the run is closed `cancelled`. The CONTAINER is torn down by
   * its supervisor at the next poll (at most `AGENT_MAX_POLL_INTERVAL_MS`), with
   * the cancel's `gate_revoked` reason, then charged and released as every settled
   * container is — the supervisor stays the ONE owner of the machine, so a cancel
   * racing a poll can never tear it down twice or meter it twice.
   *
   * Refuses — each before anything is revoked — a run that does not exist or is in
   * another workspace (404), is not hosted (404), is not the caller's to cancel
   * (403), or has already ended (409). A cancel racing the CLI's own close resolves
   * to whichever close landed first; the other is a no-op.
   */
  async cancel(dispatchRunId: string, ctx: ServiceContext): Promise<{ dispatchRunId: string }> {
    const run = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      dispatchRunRepository.findById(dispatchRunId, tx),
    );
    if (!run || run.workspaceId !== ctx.workspaceId || run.origin !== 'hosted') {
      throw new HostedRunNotFoundError(dispatchRunId);
    }
    if (run.createdById !== ctx.userId) {
      try {
        await projectAccessService.assertCanManage(run.projectId, ctx);
      } catch (err) {
        // A member who cannot even browse the project sees no run (no existence
        // leak); one who can but is not an admin is refused.
        if (err instanceof ProjectNotFoundError) throw new HostedRunNotFoundError(dispatchRunId);
        throw new HostedRunCancelForbiddenError(dispatchRunId);
      }
    }
    if (run.status !== 'running') throw new HostedRunAlreadyEndedError(dispatchRunId, run.status);
    await this.endHostedRun(dispatchRunId, 'cancelled', 'cancelled by a person');
    return { dispatchRunId };
  },

  /**
   * The STALL read: the stall detail when the run's latest event — or its boot,
   * before it has written one — is older than the stall window, else `null`.
   */
  async stallDetail(
    dispatchRunId: string,
    session: HostedAgentSession,
    now: Date,
  ): Promise<string | null> {
    const latest = await withWorkspaceServiceContext(session.attribution.workspaceId, (tx) =>
      dispatchRunEventRepository.findLatestCreatedAt(dispatchRunId, tx),
    );
    const bootedAt = new Date(session.bootedAt).getTime();
    const lastSign = Math.max(latest?.getTime() ?? 0, bootedAt);
    return now.getTime() - lastSign >= hostedRunStallWindowMs() ? HOSTED_RUN_STALL_DETAIL : null;
  },

  /**
   * THE END PATH (MOTIR-6450) — the ONE function every way a hosted run ends
   * calls: a start that failed after the run opened, a supervision whose
   * container settled (the CLI's exit, a stall, the backstop), a person's
   * cancel, and a lost supervision chain the sweep found.
   *
   * ⚠️ THE CONTAINER IS SETTLED BY ITS OWNER, BEFORE THIS IS CALLED. The
   * supervisor's settle step and the sweep's settler each tear it down, record
   * its usage, charge it and release its slot, and only then end the run here; a
   * cancel ends the run first and the supervisor tears the machine down at its
   * next poll (see {@link cancel}). One owner per container is what makes a
   * teardown, a usage row and a release happen exactly once.
   *
   * Then, unconditionally: revoke the gateway key, the run credential and every
   * recorded git token. Then close the run ONLY IF it is still open — the CLI in
   * the container closes the run it adopted, exactly as a local run does — with a
   * `log` event naming which end it was (crash, failed, cancelled, stalled,
   * backstop, lost supervision) and any revocation that failed. A run the CLI
   * already closed keeps its status; the ingest refuses events on a closed run, so
   * nothing more is written to it.
   *
   * It links NO pull request and writes NO work-item status, on any end: on
   * success the CLI already did both, and no other end moves a card (the run-dies
   * decision). Idempotent — revocations are, and the close is skipped for a run
   * already closed — and never a throw.
   */
  async endHostedRun(
    dispatchRunId: string,
    outcome: HostedRunEndOutcome,
    detail: string,
  ): Promise<HostedRunEndResult> {
    const key = await hostedRunKeyService.revokeRunKey(dispatchRunId);
    let runCredential = 0;
    try {
      runCredential = (await runCredentialService.revokeRunCredential(dispatchRunId)).revoked;
    } catch (err) {
      console.error('[hostedRunService] could not revoke the run credential', {
        dispatchRunId,
        detail: detailOf(err),
      });
    }
    const git = await revokeRunGitCredentials(dispatchRunId);
    const gitCredentials = {
      revoked: git.filter((g) => g.status !== 'failed').length,
      failed: git.filter((g) => g.status === 'failed').length,
    };

    const run = await withSystemContext((tx) => dispatchRunRepository.findById(dispatchRunId, tx));
    let closed = false;
    if (run && run.status === 'running' && run.createdById) {
      const ctx: ServiceContext = { userId: run.createdById, workspaceId: run.workspaceId };
      const failures = [
        ...(key.ok ? [] : [`the run key could not be revoked (${key.reason})`]),
        ...(gitCredentials.failed > 0
          ? [`${gitCredentials.failed} git token(s) could not be revoked`]
          : []),
      ];
      try {
        await dispatchRunService.appendEvents(
          dispatchRunId,
          [
            {
              kind: 'log',
              body: `[motir] hosted run ended (${END_LABEL[outcome]}): ${detail}${
                failures.length > 0 ? ` — ${failures.join('; ')}` : ''
              }\n`,
              data: { end: outcome },
            },
          ],
          ctx,
        );
        const close = CLOSE_FOR[outcome];
        await dispatchRunService.close(
          dispatchRunId,
          { stopReason: close.stopReason, status: close.status },
          ctx,
        );
        closed = true;
      } catch (err) {
        // The CLI closed it between the read and the close: its status stands.
        if (!(err instanceof DispatchRunTerminalError)) {
          console.error('[hostedRunService] could not close the hosted run', {
            dispatchRunId,
            detail: detailOf(err),
          });
        }
      }
    }
    return {
      closed,
      runKey: key.ok ? 'revoked' : 'failed',
      runCredential,
      gitCredentials,
    };
  },
};

/** The reason line for a container that ended at boot, on the run and in the error. */
function bootFailureDetail(outcome: HostedAgentContainerOutcome): string {
  /* v8 ignore next -- boot() ends admission, pull and provision failures only; a SETTLED container is poll()'s, never boot()'s */
  if (outcome.outcome === 'settled') return `the container ended at boot (${outcome.reason})`;
  return `${outcome.outcome}: ${outcome.detail}`;
}
