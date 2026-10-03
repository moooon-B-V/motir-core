import type { ProjectContext } from '@/lib/projects';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { submitJob } from '@/lib/ai/motirAiClient';
import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import { isMotirAiConfigured } from '@/lib/ai/availability';
import { MotirAiConfigError } from '@/lib/ai/errors';
import {
  buildGuideContext,
  type GuideCardInput,
  type GuideContextTurn,
  type GuideRowInput,
} from '@/lib/ai/guideWorkItem';
import type { JobContextBag } from '@/lib/ai/types';
import { isManualReadyItem } from '@/lib/dto/ready';
import type { WorkItemDto } from '@/lib/dto/workItems';
import type { PlanChangeSessionDto, PlanChangeTurnDto } from '@/lib/dto/planChange';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { deliveryMemberState } from '@/lib/workItems/deliverySet';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemTodosService } from '@/lib/services/workItemTodosService';
import { workflowsService } from '@/lib/services/workflowsService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import {
  AskAnchorNotAvailableError,
  EmptyPlanChangeTurnError,
  GuideCardClosedError,
  GuideCardNotManualError,
  PlanChangeTurnNotFoundError,
} from '@/lib/planChange/errors';
import { buildScope } from '@/lib/planChange/scope';

// The GUIDE intake (Story MOTIR-7459 · MOTIR-7464) — the motir-core side of
// "Guide me through" a manual card, against `docs/decisions/conversation-turn-
// intent.md` AMENDMENT 2.
//
// ── THE INTENT IS CHOSEN BY THE DOOR (A2.1) ──────────────────────────────────
// The debug intake (`aiAskService`) submits every turn as `ask_project` and lets
// the classifier say what it was. A guide turn is never classified: its subject
// is the card the door was pressed on, known before a word is typed. So there is
// no `ask_project` job, no redirect and no correction marker here — every `user`
// turn of a `guide`-origin conversation is recorded as `intent: 'guide'`,
// anchored on the card, and runs ONE `guide_work_item` job. The client still
// never sends an intent (§1): the SESSION's origin is what decides it, and
// `aiAskService` hands any turn addressed at a guide conversation to this
// service.
//
// ── THE GATES, ALL BEFORE ANY WRITE OR JOB (A2.4 / A2.7) ─────────────────────
//  1. the card resolves in the ACTIVE project and the caller may browse it —
//     else the planning-anchor route's no-existence-leak 404
//     ({@link AskAnchorNotAvailableError});
//  2. `ai:plan` — the key a guide job spends credits under (A2.8);
//  3. `work_item:edit` on the card — every write the turn may land is one;
//  4. the card is MANUAL (`isManualReadyItem`) — {@link GuideCardNotManualError};
//  5. the card is not Done or archived — {@link GuideCardClosedError};
//  6. Motir AI is configured.
//
// ── SIDE EFFECTS OUTSIDE THE TRANSACTION (CLAUDE.md) ─────────────────────────
// The shape `aiAskService` takes: the turn is appended (a locked DB write), then
// the job is submitted (a network call), then the turn is bound to the job in a
// second locked write. A submit that fails leaves the person's words on the
// thread with no job, and {@link aiGuideService.resubmit} re-runs that SAME
// turn. A turn that already HAS a job is never submitted again — a replayed
// resubmit returns its job — which is what makes the door replay-safe.
//
// ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────────
// It ends at the job submitted and the turn persisted. Landing the result —
// to-do writes, ticks, the comment, the close — is MOTIR-7470.

/** The words the door sends when it opens a NEW guide conversation, so Motir AI
 *  speaks first (MOTIR-7464). A real `user` turn, attributed to the person who
 *  pressed the door: pressing it is the act of asking to be guided. */
export function guideOpeningTurn(itemKey: string): string {
  return `Guide me through ${itemKey}.`;
}

/** What the door / a turn submission tells the caller. `jobId` / `turnId` are
 *  null only when the door RESUMED a conversation and sent nothing. */
export interface GuideTurnResult {
  outcome: 'guiding';
  /** The guide job now running for the turn, or null on a resume. */
  jobId: string | null;
  /** The `user` turn the job runs for, or null on a resume. */
  turnId: string | null;
  /** Whether this call STARTED the conversation (the door's first turn). */
  started: boolean;
  session: PlanChangeSessionDto;
}

/** The card a guide conversation is about, gated, plus its rows in list order. */
interface GuidedCard {
  item: WorkItemDto;
  rows: GuideRowInput[];
}

function actorOf(ctx: ProjectContext): ServiceContext {
  return { userId: ctx.userId, workspaceId: ctx.workspaceId };
}

/**
 * Resolve the guided card and assert every gate, in the order the header states.
 * Nothing is written by this; it is the precondition of every write below.
 */
async function requireGuidableCard(itemKey: string, ctx: ProjectContext): Promise<GuidedCard> {
  const actor = actorOf(ctx);
  let item: WorkItemDto;
  try {
    // The KEYED read, pinned to the active project: another project's key simply
    // does not resolve. It asserts browse.
    // Keys are case-insensitive everywhere else in the API (`buildScope` folds
    // them the same way), so the door accepts `motir-9` for `MOTIR-9`.
    item = await workItemsService.getWorkItemByIdentifier(
      ctx.projectId,
      itemKey.trim().toUpperCase(),
      actor,
    );
  } catch (err) {
    if (
      err instanceof WorkItemNotFoundError ||
      err instanceof ProjectAccessDeniedError ||
      err instanceof ProjectNotFoundError
    ) {
      throw new AskAnchorNotAvailableError();
    }
    throw err;
  }
  if (item.projectId !== ctx.projectId) throw new AskAnchorNotAvailableError();

  await projectAccessService.assertPermission(ctx.projectId, actor, 'ai:plan');
  await projectAccessService.assertPermission(ctx.projectId, actor, 'work_item:edit');

  if (!isManualReadyItem(item)) throw new GuideCardNotManualError(item.identifier);
  if (item.archivedAt) throw new GuideCardClosedError(item.identifier, 'archived');
  const terminal = await workflowsService.getTerminalStatusKeys(ctx.projectId, ctx.workspaceId);
  if (terminal.has(item.status)) throw new GuideCardClosedError(item.identifier, 'done');

  if (!isMotirAiConfigured()) {
    throw new MotirAiConfigError('MOTIR_AI_URL / MOTIR_AI_SERVICE_TOKEN are not set');
  }

  const list = await workItemTodosService.listTodos(item.id, actor);
  const rows: GuideRowInput[] = list.items.map((r) => ({
    id: r.id,
    text: r.text,
    notesMd: r.notesMd,
    commandText: r.commandText,
    executor: r.executor,
    done: r.done,
  }));
  return { item, rows };
}

/** The card's fields as the job reads them, with its linked pull requests. Read
 *  FRESH for every turn (A2.3), never from a cached copy on the session. */
async function readGuideCard(item: WorkItemDto, ctx: ProjectContext): Promise<GuideCardInput> {
  const deliveries = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    workItemDeliveryRepository.listByWorkItem(item.id, tx),
  );
  return {
    identifier: item.identifier,
    title: item.title,
    type: item.type,
    executor: item.executor,
    statusKey: item.status,
    descriptionMd: item.descriptionMd,
    explanationMd: item.explanationMd,
    pullRequests: deliveries.map((d) => ({
      url: `https://github.com/${d.repo.owner}/${d.repo.name}/pull/${d.pullRequest.number}`,
      state: deliveryMemberState(d.pullRequest),
    })),
  };
}

/** The conversation so far, as the job reads it — `user` and `assistant` turns
 *  in `seq` order, up to and including `throughTurnId`. A `system` marker is not
 *  conversation and is left out. */
function contextTurns(session: PlanChangeSessionDto, throughTurnId: string): GuideContextTurn[] {
  const out: GuideContextTurn[] = [];
  for (const t of session.turns) {
    if (t.role === 'user' || t.role === 'assistant') out.push({ role: t.role, body: t.body });
    if (t.id === throughTurnId) break;
  }
  return out;
}

/** Submit ONE `guide_work_item` job. The tenant resolution is the shipped one;
 *  an out-of-credits org surfaces as the client's typed error and the turn
 *  stays on the thread with no job (A2.4: nothing lands from a turn that did not
 *  run). */
async function submitGuideJob(
  guided: GuidedCard,
  session: PlanChangeSessionDto,
  turn: PlanChangeTurnDto,
  ctx: ProjectContext,
): Promise<{ jobId: string }> {
  const card = await readGuideCard(guided.item, ctx);
  const guideContext = buildGuideContext(card, guided.rows, contextTurns(session, turn.id));
  const { organizationId, isMeta, internalBilling } = await resolveTenantOrg({
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  const context: JobContextBag = { prompt: turn.body, guideContext };
  return submitJob(
    'guide_work_item',
    {
      organizationId,
      isMeta,
      internalBilling,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      projectKey: ctx.project.identifier,
    },
    context,
    { userId: ctx.userId },
  );
}

/** The guided card's key on a guide conversation — its one target. */
function guidedKeyOf(session: PlanChangeSessionDto): string {
  const key = session.targetKeys[0];
  if (session.origin !== 'guide' || !key) throw new PlanChangeTurnNotFoundError('(guide)');
  return key;
}

/** Run a `user` turn that is on the thread and has no job yet, and bind it. */
async function runTurn(
  guided: GuidedCard,
  session: PlanChangeSessionDto,
  turn: PlanChangeTurnDto,
  ctx: ProjectContext,
  started: boolean,
): Promise<GuideTurnResult> {
  const { jobId } = await submitGuideJob(guided, session, turn, ctx);
  const bound = await planChangeSessionsService.recordTurnIntent(
    turn.id,
    'guide',
    ctx,
    { jobId },
    { sessionId: session.id },
  );
  return { outcome: 'guiding', jobId, turnId: turn.id, started, session: bound };
}

export const aiGuideService = {
  /**
   * The Guide me through DOOR (A2.2). Opens the guide conversation on `itemKey`:
   *
   *  * on a card WITH to-do rows, the member's latest guide conversation on it is
   *    RESUMED and nothing is sent (`jobId: null`);
   *  * otherwise — no prior guide conversation, or a card with NO rows, whose
   *    temporary walk cannot be resumed — a NEW conversation starts with the
   *    door's opening turn, and that turn's job is submitted, so Motir AI speaks
   *    first.
   *
   * `text` replaces the default opening words when the door carries its own.
   */
  async open(
    itemKey: string,
    ctx: ProjectContext,
    opts: { text?: string } = {},
  ): Promise<GuideTurnResult> {
    const guided = await requireGuidableCard(itemKey, ctx);
    const scope = buildScope([guided.item.identifier]);
    const body = opts.text?.trim() || guideOpeningTurn(guided.item.identifier);
    const { session, opened } = await planChangeSessionsService.openGuideWithFirstTurn(
      ctx,
      scope,
      body,
      { resume: guided.rows.length > 0 },
    );
    if (!opened) {
      return { outcome: 'guiding', jobId: null, turnId: null, started: false, session };
    }
    const first = session.turns.at(-1);
    if (!first) throw new PlanChangeTurnNotFoundError('(the turn just appended)');
    return runTurn(guided, session, first, ctx, true);
  },

  /**
   * A person's next turn in a guide conversation. Appended as `intent: 'guide'`,
   * anchored on the card, then ONE `guide_work_item` job runs for it. Reached
   * from the guide door's own route and from `POST /api/ai/ask`, which hands any
   * turn addressed at a guide conversation here (A2.1).
   */
  async submitTurn(
    body: string,
    ctx: ProjectContext,
    opts: { sessionId: string },
  ): Promise<GuideTurnResult> {
    const trimmed = body.trim();
    if (!trimmed) throw new EmptyPlanChangeTurnError();
    const current = await planChangeSessionsService.getById(ctx, opts.sessionId);
    const guided = await requireGuidableCard(guidedKeyOf(current), ctx);
    const address = { sessionId: current.id };
    const appended = await planChangeSessionsService.appendTurn(trimmed, ctx, address, {
      intent: 'guide',
      anchorKey: guided.item.identifier,
    });
    const turn = appended.turns.at(-1);
    if (!turn) throw new PlanChangeTurnNotFoundError('(the turn just appended)');
    return runTurn(guided, appended, turn, ctx, false);
  },

  /**
   * Re-run a `user` turn already on a guide conversation — the RETRY after a
   * failed submit. REPLAY-SAFE: a turn that already has a job is returned with
   * that job and nothing is submitted, so a reload, a second tab or a retried
   * request never runs (or bills) one turn twice. No second `user` turn is ever
   * appended. There is no `flip`: a guide turn has no other intent (A2.1).
   */
  async resubmit(
    turnId: string,
    ctx: ProjectContext,
    opts: { sessionId: string },
  ): Promise<GuideTurnResult> {
    const current = await planChangeSessionsService.getById(ctx, opts.sessionId);
    const turn = current.turns.find((t) => t.id === turnId);
    if (!turn || turn.role !== 'user') throw new PlanChangeTurnNotFoundError(turnId);
    const guided = await requireGuidableCard(guidedKeyOf(current), ctx);
    if (turn.jobId) {
      return { outcome: 'guiding', jobId: turn.jobId, turnId, started: false, session: current };
    }
    return runTurn(guided, current, turn, ctx, false);
  },
};
