import { Prisma } from '@/generated/prisma/client';
import type {
  DispatchCardDisposition,
  DispatchCommand,
  DispatchEventKind,
  DispatchRunCard,
  DispatchRunOrigin,
  DispatchRunStatus,
  DispatchSkipReason,
  DispatchStopReason,
} from '@/generated/prisma/client';
import {
  DispatchRunEventBodyTooLargeError,
  DispatchRunEventLimitError,
  DispatchRunNotFoundError,
  DispatchRunTerminalError,
  DuplicateDispatchRunError,
  UnknownDispatchRunCardError,
} from '@/lib/dispatchRuns/errors';
import type {
  ActiveDispatchRunDto,
  DispatchRunAppendedDto,
  DispatchRunCardDto,
  DispatchRunDetailDto,
  DispatchRunDto,
  DispatchRunEventDto,
  DispatchRunListItemDto,
  DispatchRunOpenedDto,
} from '@/lib/dto/dispatchRuns';
import {
  toDispatchRunCardDto,
  toDispatchRunDto,
  toDispatchRunEventDto,
  toDispatchRunListItemDto,
} from '@/lib/mappers/dispatchRunMappers';
import { toWorkItemDeliveryDto } from '@/lib/mappers/githubMappers';
import { dispatchRunCardRepository } from '@/lib/repositories/dispatchRunCardRepository';
import { dispatchRunEventRepository } from '@/lib/repositories/dispatchRunEventRepository';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectsService } from '@/lib/services/projectsService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';

// THE DISPATCH RUN SERVICE (Story MOTIR-1789 · MOTIR-1792) — the WRITE half of
// the run seam, specified by `docs/decisions/dispatch-run-record.md`.
//
// Three operations, and they are shaped for a TRANSPORT rather than for the CLI
// that happens to be their first caller: 9.1.7's hosted orchestrator later
// becomes a second caller with `origin: 'hosted'` and nothing else changes.
//
// ── TWO THINGS THIS SERVICE MUST NEVER DO (ADR Q3) ─────────────────────────
//
//   1. It does not transition a WORK ITEM. Closing a run writes no status. The
//      CLI owns every transition and the CI-green → `in_review` promotion is
//      server-side (MOTIR-2999); a second writer here would be a duplicate write
//      path for the fact the board renders. There is no `workItemsService` and no
//      `workItemRepository.update` import below, and
//      `tests/dispatchRunService.test.ts` asserts the item is untouched across a
//      whole open → append → close cycle.
//   2. It records no pull request and no CI verdict. An EVENT may say *a pull
//      request was opened*; the FACT lives in the delivery set and the read side
//      joins it.
//
// ── ONE TRANSACTION PER METHOD, `tx` THREADED ALL THE WAY DOWN ─────────────
// The three tables are RLS-gated on `app.workspace_id`, a GUC bound by
// `withWorkspaceContext` on a TRANSACTION and by nothing else, so every
// repository call — read as well as write — takes the `tx` this service opens.
// That is `docs/decisions/bound-read-transaction-shape.md`'s convention, and
// here it is not merely a convention: an unbound read of these tables returns an
// EMPTY LIST rather than an error.

/** The opt-in log body's per-event ceiling (ADR Q4). REFUSED, never truncated. */
export const DISPATCH_RUN_EVENT_BODY_LIMIT_BYTES = 16 * 1024;

/** The per-RUN event ceiling (ADR Q4) — the bound that makes bodies safe to accept. */
export const DISPATCH_RUN_EVENT_LIMIT = 5_000;

/** How many events one append call may carry. */
export const DISPATCH_RUN_APPEND_BATCH_LIMIT = 200;

/** How long a log body is kept before the sweep clears it (ADR Q4). */
export const DISPATCH_RUN_BODY_RETENTION_DAYS = 30;

/**
 * How long a run may sit `running` before the reap closes it as `timed_out` /
 * `abandoned`.
 *
 * Twelve hours, and the number is chosen against the LONGEST legitimate run
 * rather than the typical one: a `motir auto` draining a project's ready set
 * with a CI watch on each card is measured in hours, and reaping a run that is
 * still working would replace a true `running` with a false `abandoned` — which
 * is worse than the state it fixes, because it is a terminal answer nobody
 * re-examines.
 */
export const DISPATCH_RUN_ABANDON_AFTER_HOURS = 12;

/** One page of the RUNS INDEX, and the ceiling a caller cannot ask past. */
export const DISPATCH_RUN_LIST_DEFAULT_TAKE = 25;
export const DISPATCH_RUN_LIST_MAX_TAKE = 100;

/**
 * IS THIS RUN STILL GOING? — the live / past partition the runs index reads,
 * stated ONCE and TOTAL over `DispatchRunStatus`.
 *
 * ⚠️ `satisfies Record<DispatchRunStatus, boolean>` is the whole value of
 * writing it as a map rather than as `status === 'running'`. A new status is
 * then a compile error HERE, at the one place that decides which half of the
 * index a run falls into — and the alternative fails in the quietest possible
 * way, by sorting an unknown status into *past* and letting a live run vanish
 * from the surface built to watch it.
 *
 * `timed_out` is terminal on purpose: it is what the abandoned-run reap writes
 * for a run whose machine stopped reporting, so the run is over whatever the
 * process is doing.
 */
const RUN_IS_LIVE = {
  running: true,
  succeeded: false,
  failed: false,
  cancelled: false,
  timed_out: false,
} as const satisfies Record<DispatchRunStatus, boolean>;

const statusesWhere = (live: boolean): DispatchRunStatus[] =>
  (Object.keys(RUN_IS_LIVE) as DispatchRunStatus[]).filter((s) => RUN_IS_LIVE[s] === live);

/** The statuses a run is still going in — what `?status=live` narrows to. */
export const DISPATCH_RUN_LIVE_STATUSES = statusesWhere(true);
/** The statuses a run has finished in — what `?status=past` narrows to. */
export const DISPATCH_RUN_PAST_STATUSES = statusesWhere(false);

/** One card in the SET a run is opened with. */
export interface OpenDispatchRunCardInput {
  /** The card's `MOTIR-<n>` key, in this run's project. */
  key: string;
  /** `queued` (the run intends to work it) or `skipped`. */
  disposition: 'queued' | 'skipped';
  /** Required when `disposition === 'skipped'`, forbidden otherwise. */
  skipReason?: DispatchSkipReason | undefined;
}

export interface OpenDispatchRunInput {
  projectKey: string;
  command: DispatchCommand;
  origin?: DispatchRunOrigin | undefined;
  /** The container or sprint-bearing card the run was pointed at. */
  scopeKey?: string | undefined;
  /** What the CLI printed for the scope. Stored so it survives the card. */
  scopeLabel?: string | undefined;
  agent?: string | undefined;
  model?: string | undefined;
  idempotencyKey?: string | undefined;
  /** The run's SET, IN THE RUN'S OWN ORDER. `position` is the array index. */
  cards: OpenDispatchRunCardInput[];
}

/** One event in an append batch. */
export interface AppendDispatchRunEventInput {
  kind: DispatchEventKind;
  /** The card this event is about, or absent for a RUN-scoped event. */
  workItemKey?: string | undefined;
  data?: Prisma.InputJsonValue | undefined;
  /** The opt-in log body. Absent unless the run was started with `--report-log`. */
  body?: string | undefined;
  /** The leg's new disposition, applied in the SAME transaction as the event. */
  disposition?: DispatchCardDisposition | undefined;
  skipReason?: DispatchSkipReason | undefined;
  sessionBranch?: string | undefined;
  exitCode?: number | undefined;
}

export interface CloseDispatchRunInput {
  stopReason: DispatchStopReason;
  /**
   * The run's terminal status. Omitted, it is DERIVED from the stop reason —
   * `halted` is a failure, everything else is not — which is the mapping every
   * caller would otherwise re-implement, differently.
   */
  status?: 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | undefined;
}

/** The project key a `MOTIR-<n>` identifier belongs to. */
function projectKeyOf(identifier: string): string {
  const dash = identifier.lastIndexOf('-');
  return dash > 0 ? identifier.slice(0, dash) : identifier;
}

/** The dispositions a leg can still leave at close. */
const NON_TERMINAL: readonly DispatchCardDisposition[] = ['queued', 'running'];

/**
 * The terminal STATUS a stop reason implies.
 *
 * Derived rather than supplied, because it is the mapping every caller would
 * otherwise re-implement — differently — and the three interesting rows are the
 * ones a naive mapping gets wrong:
 *
 *   * `halted` is the only FAILURE. An agent failed and the loop stopped.
 *   * `interrupted` is `cancelled`, not failed: somebody pressed Ctrl-C, which
 *     is a decision rather than a fault.
 *   * `abandoned` is `timed_out`, and only the reap writes it — a process that
 *     died cannot report that it died.
 *   * `replanned` is a SUCCESS, and this is the row that matters most. The
 *     agent refused a card, submitted a plan and exited 0; a run summary that
 *     calls that a failure teaches an operator to ignore failures.
 */
function statusForStopReason(
  stopReason: DispatchStopReason,
): 'succeeded' | 'failed' | 'cancelled' | 'timed_out' {
  if (stopReason === 'halted') return 'failed';
  if (stopReason === 'interrupted') return 'cancelled';
  if (stopReason === 'abandoned') return 'timed_out';
  return 'succeeded';
}

/**
 * What an unsettled leg becomes when the run closes under it.
 *
 * `queued` → `not_reached`: the run took the card and never got to it, which is
 * neither a skip (nothing decided to leave it out) nor a failure (nothing ran).
 *
 * `running` → `failed`: the run ended while an agent was on this card and
 * nothing ever reported an outcome. Calling that `not_reached` would say the
 * opposite of what happened, and there is no terminal member meaning *unknown* —
 * `failed` is the only one that does not claim work landed, which is the safe
 * direction for a card somebody now has to look at.
 */
function settledDisposition(current: DispatchCardDisposition): DispatchCardDisposition {
  return current === 'running' ? 'failed' : 'not_reached';
}

export const dispatchRunService = {
  /**
   * OPEN a run WITH ITS SET.
   *
   * ⚠️ THE SET ARRIVES HERE, AND THIS IS THE OPERATION THE WHOLE RECORD IS
   * SHAPED AROUND. A scoped run has just claimed eleven cards; a batch has just
   * frozen a snapshot of nine taken and four skipped. That knowledge exists for
   * exactly one moment, in one process — reconstructing it afterwards from a
   * stream of per-card events would yield a list of what the run GOT ROUND TO,
   * and would lose the skipped cards entirely, which exist nowhere else at all.
   *
   * IDEMPOTENT on `idempotencyKey`: the read runs first and a repeat returns the
   * EXISTING run with `created: false`. The unique index is the arbiter of the
   * narrow race between that read and the insert, and a `P2002` is translated
   * rather than allowed to escape.
   */
  async open(input: OpenDispatchRunInput, ctx: ServiceContext): Promise<DispatchRunOpenedDto> {
    const project = await projectsService.getByKey(input.projectKey, ctx);
    await projectAccessService.assertCanEdit(project.id, ctx);

    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: project.id },
      async (tx) => {
        if (input.idempotencyKey) {
          const existing = await dispatchRunRepository.findByIdempotencyKey(
            ctx.workspaceId,
            input.idempotencyKey,
            tx,
          );
          if (existing) {
            const withCards = await dispatchRunRepository.findByIdWithCards(existing.id, tx);
            /* v8 ignore next -- the row was just read inside this transaction */
            if (!withCards) throw new DispatchRunNotFoundError(existing.id);
            const seq = (await dispatchRunEventRepository.maxSeq(existing.id, tx)) ?? 0;
            return { run: toDispatchRunDto(withCards, seq), created: false };
          }
        }

        // Resolve the SET before writing anything: a run whose plan names a card
        // that is not in this project is a client bug, and half a set is worse
        // than none.
        const keys = input.cards.map((c) => c.key.trim().toUpperCase());
        const items = await workItemRepository.findByIdentifiers(project.id, keys, tx);
        const byKey = new Map(items.map((i) => [i.identifier, i]));
        const scopeItem = input.scopeKey
          ? await workItemRepository.findByIdentifier(
              project.id,
              input.scopeKey.trim().toUpperCase(),
              tx,
            )
          : null;
        if (input.scopeKey && !scopeItem) {
          throw new UnknownDispatchRunCardError(input.scopeKey.trim().toUpperCase());
        }
        for (const key of keys) {
          if (!byKey.has(key)) throw new UnknownDispatchRunCardError(key);
        }

        let run;
        try {
          run = await dispatchRunRepository.create(
            {
              workspace: { connect: { id: ctx.workspaceId } },
              project: { connect: { id: project.id } },
              command: input.command,
              origin: input.origin ?? 'local',
              ...(scopeItem ? { scope: { connect: { id: scopeItem.id } } } : {}),
              ...(input.scopeLabel !== undefined ? { scopeLabel: input.scopeLabel } : {}),
              ...(input.agent !== undefined ? { agent: input.agent } : {}),
              ...(input.model !== undefined ? { model: input.model } : {}),
              ...(input.idempotencyKey !== undefined
                ? { idempotencyKey: input.idempotencyKey }
                : {}),
              createdBy: { connect: { id: ctx.userId } },
            },
            tx,
          );
        } catch (err) {
          // The narrow window between the read above and this insert. Translate
          // it: a raw `P2002` escaping the service would reach a client as a
          // bare 500 for a condition that has a correct, specific answer.
          if (
            input.idempotencyKey &&
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === 'P2002'
          ) {
            throw new DuplicateDispatchRunError(input.idempotencyKey);
          }
          throw err;
        }

        if (keys.length > 0) {
          await dispatchRunCardRepository.createMany(
            input.cards.map((card, position) => {
              const key = keys[position]!;
              return {
                workspaceId: ctx.workspaceId,
                dispatchRunId: run.id,
                workItemId: byKey.get(key)!.id,
                workItemKey: key,
                position,
                disposition: card.disposition,
                ...(card.skipReason !== undefined ? { skipReason: card.skipReason } : {}),
              };
            }),
            tx,
          );
        }

        const withCards = await dispatchRunRepository.findByIdWithCards(run.id, tx);
        /* v8 ignore next -- the row was just written inside this transaction */
        if (!withCards) throw new DispatchRunNotFoundError(run.id);
        return { run: toDispatchRunDto(withCards, 0), created: true };
      },
    );
  },

  /**
   * APPEND a batch of events, and apply any leg dispositions they carry.
   *
   * ⚠️ THE `seq` IS SERVER-ASSIGNED, UNDER THE RUN'S OWN ROW LOCK. Two things
   * need that lock and they are the same lock: the terminal check (a read-derived
   * refusal — see `close` for the full argument), and the allocation of the next
   * `seq`. Reading the max and adding one WITHOUT the lock hands two concurrent
   * appenders the same number, and the unique index would then reject one of them
   * — turning a routine retry into a lost batch. With it, the second appender
   * waits and numbers from what the first actually wrote.
   *
   * ⚠️ AND THE DISPOSITION MOVES IN THE SAME TRANSACTION AS ITS EVENT. That is
   * the difference between a viewer seeing a card go `implemented` at the moment
   * it happens and seeing every card change at close: the surface's whole reason
   * to exist is the first one.
   */
  async appendEvents(
    runId: string,
    events: AppendDispatchRunEventInput[],
    ctx: ServiceContext,
  ): Promise<DispatchRunAppendedDto> {
    for (const event of events) {
      if (event.body !== undefined) {
        const bytes = Buffer.byteLength(event.body, 'utf8');
        if (bytes > DISPATCH_RUN_EVENT_BODY_LIMIT_BYTES) {
          throw new DispatchRunEventBodyTooLargeError(DISPATCH_RUN_EVENT_BODY_LIMIT_BYTES, bytes);
        }
      }
    }

    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        const locked = await dispatchRunRepository.findTerminalStateForUpdate(runId, tx);
        if (!locked) throw new DispatchRunNotFoundError(runId);
        if (locked.status !== 'running') {
          throw new DispatchRunTerminalError(runId, locked.status);
        }

        const existingCount = await dispatchRunEventRepository.countByRun(runId, tx);
        if (existingCount + events.length > DISPATCH_RUN_EVENT_LIMIT) {
          throw new DispatchRunEventLimitError(runId, DISPATCH_RUN_EVENT_LIMIT);
        }

        const legs = await dispatchRunCardRepository.listByRun(runId, tx);
        const legByKey = new Map(
          legs.filter((l) => l.workItemKey !== null).map((l) => [l.workItemKey!, l]),
        );

        let seq = (await dispatchRunEventRepository.maxSeq(runId, tx)) ?? 0;
        const rows: Prisma.DispatchRunEventCreateManyInput[] = [];
        const touched = new Map<string, DispatchRunCard>();

        for (const event of events) {
          let leg: DispatchRunCard | null = null;
          if (event.workItemKey !== undefined) {
            const key = event.workItemKey.trim().toUpperCase();
            leg = touched.get(key) ?? legByKey.get(key) ?? null;
            if (!leg) throw new UnknownDispatchRunCardError(key);
          }

          seq += 1;
          rows.push({
            workspaceId: ctx.workspaceId,
            dispatchRunId: runId,
            ...(leg ? { dispatchRunCardId: leg.id } : {}),
            seq,
            kind: event.kind,
            ...(event.data !== undefined ? { data: event.data } : {}),
            ...(event.body !== undefined ? { body: event.body } : {}),
          });

          // The leg's own move, in this same transaction. Applied event by event
          // rather than folded at the end, so a batch that moves one card twice
          // leaves it where its LAST event says — the order the reporter sent.
          if (
            leg &&
            (event.disposition !== undefined ||
              event.sessionBranch !== undefined ||
              event.exitCode !== undefined)
          ) {
            const now = new Date();
            const disposition = event.disposition;
            const updated = await dispatchRunCardRepository.update(
              leg.id,
              {
                ...(disposition !== undefined
                  ? {
                      disposition,
                      // The CHECK constraint asserts the pairing in both
                      // directions, so a move OFF `skipped` must clear the
                      // reason rather than leave it behind.
                      skipReason: disposition === 'skipped' ? (event.skipReason ?? null) : null,
                      ...(disposition === 'running' && leg.startedAt === null
                        ? { startedAt: now }
                        : {}),
                      ...(!NON_TERMINAL.includes(disposition) ? { endedAt: now } : {}),
                    }
                  : {}),
                ...(event.sessionBranch !== undefined
                  ? { sessionBranch: event.sessionBranch }
                  : {}),
                ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
              },
              tx,
            );
            touched.set(updated.workItemKey ?? updated.id, updated);
          }
        }

        const appended = await dispatchRunEventRepository.createMany(rows, tx);
        return {
          runId,
          appended,
          seq,
          cards: [...touched.values()].map(toDispatchRunCardDto),
        };
      },
    );
  },

  /**
   * CLOSE the run: its terminal status, its stop reason, and every leg that is
   * still unsettled.
   *
   * ⚠️ READ-DERIVED, SO IT LOCKS. Two things race to close one run — the CLI's
   * own `run_closed` report, and the abandoned-run reap that decided nothing was
   * holding it. Without the lock both read `running`, both write, and the
   * LOSER's write lands: a run that finished cleanly ends up recorded as
   * `timed_out`, which is the one outcome a reader would take as evidence that
   * something went wrong. With it, the second closer re-reads a row that is
   * already terminal and gets a typed error instead of overwriting an answer.
   *
   * A serial test passes without the lock and proves nothing, which is why
   * `tests/dispatchRunService.test.ts` drives two SIMULTANEOUS closes against a
   * warm pool and asserts exactly one wins.
   */
  async close(
    runId: string,
    input: CloseDispatchRunInput,
    ctx: ServiceContext,
  ): Promise<DispatchRunDto> {
    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        const locked = await dispatchRunRepository.findTerminalStateForUpdate(runId, tx);
        if (!locked) throw new DispatchRunNotFoundError(runId);
        if (locked.status !== 'running') {
          throw new DispatchRunTerminalError(runId, locked.status);
        }

        const endedAt = new Date();
        await dispatchRunRepository.update(
          runId,
          {
            status: input.status ?? statusForStopReason(input.stopReason),
            stopReason: input.stopReason,
            endedAt,
          },
          tx,
        );

        // Settle whatever the run left in flight. One update per leg rather than
        // an `updateMany`, because the target disposition DEPENDS on where each
        // leg was — a `queued` card was never reached, a `running` one was.
        const legs = await dispatchRunCardRepository.listByRun(runId, tx);
        for (const leg of legs) {
          if (!NON_TERMINAL.includes(leg.disposition)) continue;
          await dispatchRunCardRepository.update(
            leg.id,
            { disposition: settledDisposition(leg.disposition), endedAt },
            tx,
          );
        }

        const withCards = await dispatchRunRepository.findByIdWithCards(runId, tx);
        /* v8 ignore next -- the row was just written inside this transaction */
        if (!withCards) throw new DispatchRunNotFoundError(runId);
        const seq = (await dispatchRunEventRepository.maxSeq(runId, tx)) ?? 0;
        return toDispatchRunDto(withCards, seq);
      },
    );
  },

  /**
   * The run WITH its set — the read the ingest operations answer with, and the
   * one MOTIR-1793's browser routes will compose.
   */
  async getRun(runId: string, ctx: ServiceContext): Promise<DispatchRunDto> {
    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        const run = await dispatchRunRepository.findByIdWithCards(runId, tx);
        if (!run) throw new DispatchRunNotFoundError(runId);
        const seq = (await dispatchRunEventRepository.maxSeq(runId, tx)) ?? 0;
        return toDispatchRunDto(run, seq);
      },
    );
  },

  /**
   * THE RUN AS THE BROWSER READS IT — the header, its set, and what each leg
   * SHIPPED (MOTIR-1793).
   *
   * ⚠️ THE DELIVERIES ARE JOINED HERE, and that is the whole reason this method
   * exists beside {@link getRun}. The run record holds no pull-request and no CI
   * column (ADR Q3), so the page's *did this ship / is it green* comes from
   * `work_item_delivery` and `derivePrCiState` — the product's ONE CI derivation.
   * Recomputing it here would be a second verdict that drifts from the pill a
   * person reads on the same card.
   *
   * ONE batched read for the whole set, not one per leg: a sprint run's card set
   * is not small, and a per-leg read would be an N+1 on the run view's only query.
   */
  async getRunDetail(runId: string, ctx: ServiceContext): Promise<DispatchRunDetailDto> {
    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        const run = await dispatchRunRepository.findByIdWithCards(runId, tx);
        if (!run) throw new DispatchRunNotFoundError(runId);
        const seq = (await dispatchRunEventRepository.maxSeq(runId, tx)) ?? 0;

        const workItemIds = run.cards
          .map((card) => card.workItemId)
          .filter((id): id is string => id !== null);
        const deliveries = await workItemDeliveryRepository.listByWorkItemsWithChecks(
          workItemIds,
          tx,
        );
        const byWorkItem = new Map<string, ReturnType<typeof toWorkItemDeliveryDto>[]>();
        for (const row of deliveries) {
          const list = byWorkItem.get(row.workItemId) ?? [];
          list.push(toWorkItemDeliveryDto(row));
          byWorkItem.set(row.workItemId, list);
        }

        const base = toDispatchRunDto(run, seq);
        return {
          ...base,
          cards: base.cards.map((card) => ({
            ...card,
            // A leg whose card was deleted has no deliveries to join and never
            // will — an empty array, never a missing key.
            deliveries: card.workItemId ? (byWorkItem.get(card.workItemId) ?? []) : [],
          })),
        };
      },
    );
  },

  /**
   * ONE CARD'S RUN HISTORY, newest first, cursor-paginated.
   *
   * ⚠️ "EVERY RUN THAT CARRIED A LEG FOR THIS CARD", not "every run that NAMED
   * it" — which is the correct question now that a run covers a set. The sprint
   * run that swept a card up is exactly the run its owner wants to find, and it
   * never named the card at all.
   *
   * Newest-first is load-bearing rather than a default: the card page's run
   * section reads the CURRENT run off the first row of the first page, which is
   * why there is no second single-run endpoint to keep in step with this one.
   */
  async listRunsForWorkItemKey(
    key: string,
    page: { take: number; cursor?: string | undefined },
    ctx: ServiceContext,
  ): Promise<DispatchRunDto[]> {
    const identifier = key.trim().toUpperCase();
    const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
    await projectAccessService.assertCanBrowse(project.id, ctx);

    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: project.id },
      async (tx) => {
        const item = await workItemRepository.findByIdentifier(project.id, identifier, tx);
        if (!item) throw new WorkItemNotFoundError(identifier);
        const runs = await dispatchRunRepository.listByWorkItem(item.id, page, tx);
        // The `seq` on a HISTORY row is not worth a read per run — the page
        // renders a list, and a client that opens one asks for its detail.
        return runs.map((run) => toDispatchRunDto(run, 0));
      },
    );
  },

  /**
   * A PROJECT'S RUNS — current AND past, newest first, cursor-paginated
   * (MOTIR-3922). The read the RUNS INDEX stands on.
   *
   * ⚠️ THIS IS THE QUESTION THE STORY SHIPPED THREE READS WITHOUT ANSWERING.
   * One run by id, one card's runs, and the project's live runs each start from
   * something the caller already holds — an id, or a card already known to be in
   * the set. So a run that finished last night could not be found at all. This
   * one starts from the project, which is the only handle a person opening Motir
   * actually has.
   *
   * Two narrowings, and both are applied by the QUERY rather than to the page —
   * a filtered page would be short, and at a boundary empty with a cursor still
   * to follow, which every client reads as the end of the list:
   *
   *   · `statuses` — the live / past partition, from {@link RUN_IS_LIVE}.
   *   · `scopeWorkItemKey` — runs whose SCOPE is that container, which is a
   *     different question from `listRunsForWorkItemKey`'s: a scoped run's legs
   *     are the container's CHILDREN, so a story never appears in its own card
   *     history and this is the only way to ask for its runs.
   *
   * Rows carry the set as COUNTS, never as legs. The index renders a list that
   * grows without bound — run headers are append-only and the retention sweep
   * clears event BODIES, not rows — so a row that carried every leg would make
   * the list pay for a run view nobody opened.
   */
  async listRunsForProject(
    projectKey: string,
    page: {
      take: number;
      cursor?: string | undefined;
      statuses?: DispatchRunStatus[] | undefined;
      scopeWorkItemKey?: string | undefined;
    },
    ctx: ServiceContext,
  ): Promise<DispatchRunListItemDto[]> {
    const project = await projectsService.getByKey(projectKey, ctx);
    await projectAccessService.assertCanBrowse(project.id, ctx);

    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: project.id },
      async (tx) => {
        const bounded = {
          take: Math.min(Math.max(page.take, 1), DISPATCH_RUN_LIST_MAX_TAKE),
          ...(page.cursor ? { cursor: page.cursor } : {}),
          ...(page.statuses && page.statuses.length > 0 ? { statuses: page.statuses } : {}),
        };

        // A SCOPE narrowing resolves its key inside the same transaction, so the
        // lookup is subject to the same workspace binding as the read it gates —
        // an unresolvable key is a 404 rather than an empty list, which is the
        // difference between "that story has no runs" and "that story is not
        // yours" (finding #44 keeps those indistinguishable to the CLIENT; they
        // must not be indistinguishable to this method).
        const runs = await (async () => {
          if (!page.scopeWorkItemKey) {
            return dispatchRunRepository.listByProject(project.id, bounded, tx);
          }
          const identifier = page.scopeWorkItemKey.trim().toUpperCase();
          const scope = await workItemRepository.findByIdentifier(project.id, identifier, tx);
          if (!scope) throw new WorkItemNotFoundError(identifier);
          return dispatchRunRepository.listByScope(scope.id, bounded, tx);
        })();

        return runs.map(toDispatchRunListItemDto);
      },
    );
  },

  /**
   * A PROJECT'S LIVE RUNS, in ONE request — the `/ready` strip's read.
   *
   * ⚠️ IT LOOKS LIKE A CONVENIENCE AND IS NOT. Two surfaces need the same
   * question answered, and the alternative is each of them filtering a paginated
   * history client-side and disagreeing about what *active* means. It is also
   * the shape that keeps `/ready` to ONE request: a per-row endpoint is an N+1
   * on the busiest surface in the product.
   *
   * Narrow by construction — each leg's key and disposition, nothing else.
   */
  async listActiveRunsForProject(
    projectKey: string,
    ctx: ServiceContext,
  ): Promise<ActiveDispatchRunDto[]> {
    const project = await projectsService.getByKey(projectKey, ctx);
    await projectAccessService.assertCanBrowse(project.id, ctx);

    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: project.id },
      async (tx) => {
        const runs = await dispatchRunRepository.listActiveByProject(project.id, tx);
        return runs.map((run) => ({
          id: run.id,
          command: run.command,
          origin: run.origin,
          scopeLabel: run.scopeLabel,
          startedAt: run.startedAt.toISOString(),
          cards: run.cards.map((card) => ({
            key: card.workItemKey,
            disposition: card.disposition,
          })),
        }));
      },
    );
  },

  /**
   * ONE PAGE of the stream, after `sinceSeq` — what the SSE route polls.
   *
   * It returns the run's STATUS beside the events on purpose: the stream's
   * termination condition is *the run reached a terminal status*, and asking for
   * that separately would open a window in which the last events arrive after
   * the status says the run is over, so a client's final frames are lost.
   */
  async readStreamPage(
    runId: string,
    sinceSeq: number,
    take: number,
    ctx: ServiceContext,
  ): Promise<{ events: DispatchRunEventDto[]; status: DispatchRunDto['status'] }> {
    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        const run = await dispatchRunRepository.findById(runId, tx);
        if (!run) throw new DispatchRunNotFoundError(runId);
        const events = await dispatchRunEventRepository.listSince(runId, sinceSeq, take, tx);
        // ⚠️ THE EVENTS ARE READ AFTER THE STATUS, INSIDE ONE TRANSACTION. Read
        // the other way round, an event appended between the two reads would be
        // reported by a page whose status already said `running` — harmless — but
        // a status read AFTER the events could say `succeeded` while events the
        // same transaction had not yet seen were already committed, and the
        // stream would close on top of them.
        return { events: events.map(toDispatchRunEventDto), status: run.status };
      },
    );
  },
};

export type { DispatchRunCardDto };
