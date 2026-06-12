import type { SavedFilterSubscriptionSchedule } from '@prisma/client';

// Filter-subscription schedule logic (Story 6.2 · Subtask 6.2.5) — Prisma-free
// pure helpers so the cron's due-ness check is frozen-clock testable in
// isolation and the save dialog can validate a schedule client-side (the
// lib/savedFilters/constants pattern).
//
// TIMEZONE: every `hour` is interpreted in UTC — the app's pinned timezone
// (lib/utils/datetime pins UTC; no per-workspace timezone is persisted yet —
// the recorded extension). UTC has no DST, so a "daily at 09:00" subscription
// fires at exactly one instant per day, every day, with none of the
// double-fire / skip a wall-clock-with-DST would introduce. The schedule
// editor surfaces this ("on the workspace timezone" copy) and the due-ness
// test asserts stability across the dates a DST transition would have shifted.

/** Max result rows an email carries — our page unit (Jira caps at 200). */
export const SUBSCRIPTION_RESULT_CAP = 50;

/** Valid `hour` range (inclusive), UTC. */
export const SUBSCRIPTION_HOUR_MIN = 0;
export const SUBSCRIPTION_HOUR_MAX = 23;

/** JS `getUTCDay` Monday–Friday — the `weekdays` schedule's day set. */
const WEEKDAY_SET = new Set([1, 2, 3, 4, 5]);

/** The shape the due-ness check decides over (a row's schedule fields). */
export interface SubscriptionSchedule {
  schedule: SavedFilterSubscriptionSchedule;
  /** 0=Sun … 6=Sat (JS getUTCDay); meaningful only for `weekly`. */
  weekday: number | null;
  hour: number;
}

/** Whether `hour` is a valid 0–23 UTC hour. */
export function isValidHour(hour: number): boolean {
  return Number.isInteger(hour) && hour >= SUBSCRIPTION_HOUR_MIN && hour <= SUBSCRIPTION_HOUR_MAX;
}

/** Whether `weekday` is a valid 0–6 JS getUTCDay value. */
export function isValidWeekday(weekday: number): boolean {
  return Number.isInteger(weekday) && weekday >= 0 && weekday <= 6;
}

/**
 * Whether a subscription is DUE at `now` — the cron tick's per-row decision,
 * evaluated in UTC. `daily` fires when the UTC hour matches; `weekdays` adds a
 * Mon–Fri gate; `weekly` requires the UTC day-of-week to equal the row's
 * `weekday`. The tick runs hourly, so "the hour matches" is the per-tick gate;
 * delivery idempotency (one mail per scheduled occurrence) is enforced
 * separately by the per-occurrence email idempotency key.
 */
export function isSubscriptionDue(sub: SubscriptionSchedule, now: Date): boolean {
  if (now.getUTCHours() !== sub.hour) return false;
  const day = now.getUTCDay();
  switch (sub.schedule) {
    case 'daily':
      return true;
    case 'weekdays':
      return WEEKDAY_SET.has(day);
    case 'weekly':
      return sub.weekday !== null && day === sub.weekday;
    default: {
      // Exhaustiveness guard — a new schedule value without a branch is a
      // compile error, not a silent never-fires.
      const _exhaustive: never = sub.schedule;
      void _exhaustive;
      return false;
    }
  }
}

/**
 * A stable per-occurrence key — the email idempotency scope. Encodes the
 * subscription id + the UTC day + hour the delivery is FOR, so a tick that
 * retries (or double-fires inside the same hour) collapses to one mail per
 * scheduled occurrence (Inngest dedups same-key `email.send` events, the
 * 1.6.3 mechanism). `weekly`/`weekdays` never collide because each occurrence
 * lands on a distinct calendar day.
 */
export function subscriptionOccurrenceKey(subscriptionId: string, now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const h = String(now.getUTCHours()).padStart(2, '0');
  return `filter-sub:${subscriptionId}:${y}-${m}-${d}T${h}`;
}
