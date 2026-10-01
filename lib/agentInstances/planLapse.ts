// The plan-lapse deletion's DATE (`docs/decisions/agent-instance-storage.md` §4,
// MOTIR-6921): when an org's AI plan lapses, each of its agents is deleted 30
// days later, at the start of that UTC day. Pure, so the service that schedules
// it and the list that shows it compute the same instant.

const DAY_MS = 24 * 60 * 60 * 1000;

/** §4: the notice period. */
export const PLAN_LAPSE_NOTICE_DAYS = 30;

/** The start of the UTC day `lapsedAt` falls on, plus the notice period. */
export function deletionDateFor(lapsedAt: Date): Date {
  const day = Date.UTC(lapsedAt.getUTCFullYear(), lapsedAt.getUTCMonth(), lapsedAt.getUTCDate());
  return new Date(day + PLAN_LAPSE_NOTICE_DAYS * DAY_MS);
}
