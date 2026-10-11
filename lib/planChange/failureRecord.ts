import { z } from 'zod';
import type { PlanSessionFailureReason } from '@/generated/prisma/client';

import {
  FAILURE_DETAIL_MAX,
  PLAN_SESSION_FAILURE_REASONS,
  type PlanSessionFailureRecord,
} from '@/lib/planChange/sessionWaitingState';

// THE FAILURE RECORD'S SOURCE (Story MOTIR-7905 · MOTIR-7912) — turning what core
// learned about a failed hosted attempt into the record `markFailed` stores.
//
// PURE: no repository, no client, no clock. The relays and the abandoned-plan sweep
// both build the record here, so the same failure reads the same whichever of them
// saw it first (they race, and `markFailed` is idempotent in effect).
//
// ⚠️ THE REASON IS A STABLE CODE, NEVER motir-ai's ENGLISH. `failureReason` is the
// closed enum the render cards translate; an unrecognised `reasonCode`, a missing
// `walkStop`, and an error class nobody mapped all fall to `internal` rather than
// being stored as prose or refused (a record that throws while recording a failure
// would turn one failure into two).

/** Where a walk stopped, as motir-ai's terminal `Problem.walkStop` carries it. */
export const jobWalkStopSchema = z.object({
  phase: z.enum(['lay', 'author']),
  target: z.string().nullable(),
  targetTitle: z.string().nullable().optional(),
  depth: z.number().int().nonnegative(),
  planId: z.string().nullable().optional(),
  reasonCode: z.string(),
  detail: z.string().optional(),
});

/** Parse a wire `walkStop`; a missing or malformed member reads `null` and never throws. */
export function parseJobWalkStop(raw: unknown): z.output<typeof jobWalkStopSchema> | null {
  if (raw === undefined || raw === null) return null;
  const parsed = jobWalkStopSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The latest `walk_position` frame a relay saw — the stop point when the terminal
 *  `Problem` carries none (`ai_job_abandoned` after the machine died). */
export interface JobWalkPosition {
  phase: 'lay' | 'author';
  target: string | null;
  targetTitle?: string | null;
  depth: number;
}

/** Read a `walk_position` frame's data; anything malformed is `null`. */
export function parseWalkPosition(raw: unknown): JobWalkPosition | null {
  const parsed = z
    .object({
      phase: z.enum(['lay', 'author']),
      target: z.string().nullable(),
      targetTitle: z.string().nullable().optional(),
      depth: z.number().int().nonnegative(),
    })
    .safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export type JobWalkStop = NonNullable<ReturnType<typeof parseJobWalkStop>>;

const REASONS: ReadonlySet<string> = new Set(PLAN_SESSION_FAILURE_REASONS);

/**
 * The TOTAL map from a typed motir-ai error to the stable reason. `error` is only
 * its `code` (and optional `message`), so the sweep can hand in a
 * `PlanJobStateDto.failure` as readily as a relay hands in a `MotirAiError`.
 */
export function reasonCodeFromError(
  error: { code: string } | null | undefined,
): PlanSessionFailureReason {
  switch (error?.code) {
    case 'MOTIR_AI_OUT_OF_CREDITS':
      return 'out_of_credits';
    case 'MOTIR_AI_UNAUTHORIZED':
      return 'token_expired';
    case 'MOTIR_AI_UNAVAILABLE':
    case 'MOTIR_AI_JOB_FAILED':
    case 'MOTIR_AI_BAD_REQUEST':
      return 'model_unavailable';
    default:
      return 'internal';
  }
}

export interface FailureRecordInput {
  failedJobId: string;
  now: Date;
  walkStop: JobWalkStop | null;
  lastPosition: JobWalkPosition | null;
  error: { code: string; message?: string } | null;
}

/**
 * The record `markFailed` writes. The stop point is `walkStop`, else the last
 * relayed position, else null; the reason is `walkStop.reasonCode` when it is one
 * of the five, else the mapped error; the detail is `walkStop.detail`, else the
 * error's message, capped (the data card's schema caps again on write).
 */
export function failureRecordFrom(input: FailureRecordInput): PlanSessionFailureRecord {
  const { walkStop, lastPosition, error } = input;
  const stop = walkStop ?? lastPosition;
  const reason =
    walkStop && REASONS.has(walkStop.reasonCode)
      ? (walkStop.reasonCode as PlanSessionFailureReason)
      : reasonCodeFromError(error);
  const detail = walkStop?.detail ?? error?.message ?? null;
  return {
    failedAt: input.now,
    failedJobId: input.failedJobId,
    failureReason: reason,
    failureDetail: detail === null ? null : detail.slice(0, FAILURE_DETAIL_MAX),
    failureStopPhase: stop?.phase ?? null,
    failureStopRef: stop?.target ?? null,
    failureStopTitle: stop?.targetTitle ?? null,
  };
}
