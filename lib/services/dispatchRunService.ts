import { Prisma } from '@/generated/prisma/client';
import type {
  DispatchCardDisposition,
  DispatchCommand,
  DispatchEventKind,
  DispatchRunCard,
  DispatchRunOrigin,
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
  DispatchRunAppendedDto,
  DispatchRunCardDto,
  DispatchRunDto,
  DispatchRunOpenedDto,
} from '@/lib/dto/dispatchRuns';
import { toDispatchRunCardDto, toDispatchRunDto } from '@/lib/mappers/dispatchRunMappers';
import { dispatchRunCardRepository } from '@/lib/repositories/dispatchRunCardRepository';
import { dispatchRunEventRepository } from '@/lib/repositories/dispatchRunEventRepository';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectsService } from '@/lib/services/projectsService';
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
};

export type { DispatchRunCardDto };
