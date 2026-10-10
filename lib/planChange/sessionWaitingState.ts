import { z } from 'zod';
import type {
  PlanSessionAwaitingCause,
  PlanSessionFailureReason,
  PlanSessionWalkPhase,
} from '@/generated/prisma/client';

// A planning session's WAITING STATE — the one place its definitions live (Story
// MOTIR-7905 · MOTIR-7908).
//
// An OPEN session (`endedAt IS NULL`) can be waiting on its person in two ways, and
// never both (the `plan_change_session_one_wait` CHECK is the database backstop):
//
//   failed-waiting   ⟺ endedAt IS NULL AND failedAt IS NOT NULL
//   awaiting-person  ⟺ endedAt IS NULL AND awaitingPersonSince IS NOT NULL
//   not waiting      ⟺ neither
//
// ⚠️ EVERY READER IMPORTS THESE, and none re-spells them. A service that tests
// `row.failedAt !== null` and a repository that filters `failedAt: { not: null }`
// are two definitions, and the moment one of them forgets the `endedAt` half a
// session that has ended appears in a To resume list. The predicate and its Prisma
// `where` fragment sit side by side below so they cannot be edited apart.
//
// ⚠️ PURE, and importing no repository, service or client: this module is read by
// the Workbench reads, the sweeps, the gate and the resume, and every one of them
// needs it without dragging the others in.

/** What a session row says about whether it is waiting. */
export type SessionWaitingState = 'failed' | 'awaiting_person' | 'open' | 'ended';

/** The columns {@link sessionWaitingState} reads — a row, or any pick of one. */
export interface SessionWaitingRow {
  endedAt: Date | null;
  failedAt: Date | null;
  awaitingPersonSince: Date | null;
}

/** Is the session failed-waiting (open, with a failure on record)? */
export function isFailedWaiting(row: SessionWaitingRow): boolean {
  return row.endedAt === null && row.failedAt !== null;
}

/** Is the session awaiting its person (open, with a wait on record)? */
export function isAwaitingPerson(row: SessionWaitingRow): boolean {
  return row.endedAt === null && row.awaitingPersonSince !== null;
}

/**
 * The session's state. An ENDED session is `'ended'` whatever its waiting columns
 * hold: the end write clears them and the CHECK forbids otherwise, but a reader
 * that is handed a row the CHECK has not seen (a fixture, a stale cache) must not
 * report a closed conversation as waiting.
 */
export function sessionWaitingState(row: SessionWaitingRow): SessionWaitingState {
  if (row.endedAt !== null) return 'ended';
  if (row.failedAt !== null) return 'failed';
  if (row.awaitingPersonSince !== null) return 'awaiting_person';
  return 'open';
}

// ── The same definitions as Prisma `where` fragments ─────────────────────────
//
// ⚠️ PLAIN `as const` OBJECTS, NOT ANNOTATED WITH THE GENERATED `…WhereInput`. The
// generated client's projection types are named only in the repository layer
// (`tests/prisma/typeBoundary.test.ts`, MOTIR-4296); these are spread into a typed
// `where` THERE, which is where the compiler checks them against the model.
//
// ⚠️ PLAIN `as const` OBJECTS, NOT ANNOTATED WITH THE GENERATED `…WhereInput`. The
// generated client's projection types are named only in the repository layer
// (`tests/prisma/typeBoundary.test.ts`, MOTIR-4296); these are spread into a typed
// `where` THERE, which is where the compiler checks them against the model.

/** Open sessions whose latest attempt failed. */
export const FAILED_WAITING_WHERE = {
  endedAt: null,
  failedAt: { not: null },
} as const;

/** The plan statuses that are UNDECIDED — a session holding one has work in front of a person
 *  or an engine (MOTIR-7939). One definition for every read that spells the set. */
export const UNDECIDED_PLAN_STATUSES = ['generating', 'planned', 'stale'] as const;

/** The undecided statuses a PERSON is waiting to decide — the plan a failure leaves beside
 *  (situation 2), as opposed to a `generating` plan an engine is still writing. */
export const WAITING_PLAN_STATUSES = ['planned', 'stale'] as const;

/**
 * ENDED `failed` sessions that still hold a plan waiting for a decision (MOTIR-7939) — the
 * sessions that ended under the pre-MOTIR-7905 rule, which declined a `generating` plan and
 * left a `planned` / `stale` one behind a session reading Closed. `plans: some` is the
 * relation through `Plan.sessionId`, so a plan the carry moved to a new session (MOTIR-7930)
 * leaves this set on its own. Keyed on the end REASON, not a date.
 */
export const ENDED_WITH_WAITING_PLAN_WHERE = {
  endedAt: { not: null },
  endReason: 'failed',
  origin: 'conversation',
  plans: { some: { status: { in: [...WAITING_PLAN_STATUSES] } } },
} as const;

/** Open sessions waiting on their person's next turn. */
export const AWAITING_PERSON_WHERE = {
  endedAt: null,
  awaitingPersonSince: { not: null },
} as const;

/**
 * Sessions in neither wait. It does not say `endedAt: null`: an ended session is in
 * neither wait either (the end write clears both), so a caller that wants "open and
 * not waiting" spells the open half itself, and one reading across ended sessions
 * is not silently narrowed.
 */
export const NOT_WAITING_WHERE = {
  failedAt: null,
  awaitingPersonSince: null,
} as const;

// ── The input types the writes take ──────────────────────────────────────────

/** The caps on what a failure may carry — it must be storable whatever motir-ai says. */
export const FAILURE_DETAIL_MAX = 300;
export const FAILURE_STOP_REF_MAX = 200;
export const FAILURE_STOP_TITLE_MAX = 500;

/** The closed vocabulary, mirrored from the Prisma enum so a stray string is refused. */
export const PLAN_SESSION_FAILURE_REASONS = [
  'rate_limited',
  'out_of_credits',
  'model_unavailable',
  'token_expired',
  'internal',
] as const satisfies readonly PlanSessionFailureReason[];

/**
 * Cut a string to `max` characters rather than refuse it. The failure path writes
 * while recording a failure: a record that THROWS on an over-long detail would
 * turn one failure into two and lose the first.
 */
const capped = (max: number) =>
  z
    .string()
    .transform((value) => value.trim().slice(0, max))
    .nullable()
    .optional()
    .transform((value) => (value === undefined || value === '' ? null : value));

/**
 * The failure record `markFailed` writes — validated, because it crosses from a
 * wire (motir-ai's `walkStop`) into a typed column. `failureReason` must be in the
 * enum; the caller maps an unrecognised code, and a missing `walkStop`, to
 * `internal` BEFORE it gets here.
 */
export const planSessionFailureRecordSchema = z.object({
  failedAt: z.date(),
  failedJobId: z.string().min(1),
  failureReason: z.enum(PLAN_SESSION_FAILURE_REASONS),
  failureDetail: capped(FAILURE_DETAIL_MAX),
  failureStopPhase: z.enum(['lay', 'author']).nullable().optional().default(null),
  failureStopRef: capped(FAILURE_STOP_REF_MAX),
  failureStopTitle: capped(FAILURE_STOP_TITLE_MAX),
});

export interface PlanSessionFailureRecord {
  failedAt: Date;
  failedJobId: string;
  failureReason: PlanSessionFailureReason;
  failureDetail?: string | null;
  failureStopPhase?: PlanSessionWalkPhase | null;
  failureStopRef?: string | null;
  failureStopTitle?: string | null;
}

/** The wait `markAwaitingPerson` writes. */
export const planSessionAwaitingSchema = z.object({
  cause: z.enum(['question', 'reply']),
  since: z.date(),
});

export interface PlanSessionAwaiting {
  cause: PlanSessionAwaitingCause;
  since: Date;
}

/** The failure record, normalised: every optional field present, capped and trimmed. */
export type ParsedPlanSessionFailureRecord = z.output<typeof planSessionFailureRecordSchema>;

/** Validate and normalise a failure record; throws a `ZodError` on a bad shape. */
export function parsePlanSessionFailureRecord(
  input: PlanSessionFailureRecord,
): ParsedPlanSessionFailureRecord {
  return planSessionFailureRecordSchema.parse(input);
}

/** Validate a wait; throws a `ZodError` on a bad shape. */
export function parsePlanSessionAwaiting(input: PlanSessionAwaiting): PlanSessionAwaiting {
  return planSessionAwaitingSchema.parse(input);
}

/**
 * The columns that hold a failure, set to null — what `clearFailure` and the end
 * write spread. Named here so the nine columns of the two waits are listed ONCE.
 */
export const CLEARED_FAILURE_COLUMNS = {
  failedAt: null,
  failedJobId: null,
  failureReason: null,
  failureDetail: null,
  failureStopPhase: null,
  failureStopRef: null,
  failureStopTitle: null,
} as const;

/** The two awaiting columns, set to null. */
export const CLEARED_AWAITING_COLUMNS = {
  awaitingPersonSince: null,
  awaitingPersonCause: null,
} as const;
