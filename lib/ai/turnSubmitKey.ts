import type { JobKind } from '@/lib/ai/types';

/** The idempotency key of a conversation turn's submit (MOTIR-9255): one per
 *  ATTEMPT of a turn, so a re-send and a Try again of a submit that never came
 *  back reuse it, while a turn whose job ran and failed gets a fresh one — a
 *  retry of a FAILED job must run again, not answer the failure. `attempt` is the
 *  job the turn held before this submit (null for its first), `kind` the job kind,
 *  so the turn's other kinds (an ask's follow-on diagnosis) never collide. */
export function turnSubmitKey(turnId: string, kind: JobKind, attempt: string | null): string {
  return `turn:${turnId}:${kind}:${attempt ?? 'first'}`;
}
