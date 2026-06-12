import { describe, expect, it } from 'vitest';
import {
  isSubscriptionDue,
  isValidHour,
  isValidWeekday,
  subscriptionOccurrenceKey,
  type SubscriptionSchedule,
} from '@/lib/savedFilters/subscriptions';
import { signUnsubscribeToken, verifyUnsubscribeToken } from '@/lib/savedFilters/subscriptionToken';

// Story 6.2 · Subtask 6.2.5 — the PURE halves of the subscription feature: the
// frozen-clock due-ness rule (UTC, no DST), the per-occurrence idempotency key,
// and the HMAC unsubscribe token. No DB; complements the integration delivery
// suite.

const sub = (over: Partial<SubscriptionSchedule> = {}): SubscriptionSchedule => ({
  schedule: 'daily',
  weekday: null,
  hour: 9,
  ...over,
});

// A few fixed instants (UTC). 2026-06-08 is a Monday.
const MON_09 = new Date('2026-06-08T09:00:00.000Z'); // Monday 09:00
const MON_10 = new Date('2026-06-08T10:00:00.000Z'); // Monday 10:00
const SAT_09 = new Date('2026-06-13T09:00:00.000Z'); // Saturday 09:00
const SUN_09 = new Date('2026-06-14T09:00:00.000Z'); // Sunday 09:00

describe('isSubscriptionDue — UTC, hour-gated', () => {
  it('daily fires only on the matching UTC hour, every day', () => {
    expect(isSubscriptionDue(sub(), MON_09)).toBe(true);
    expect(isSubscriptionDue(sub(), SAT_09)).toBe(true);
    expect(isSubscriptionDue(sub(), SUN_09)).toBe(true);
    expect(isSubscriptionDue(sub(), MON_10)).toBe(false);
  });

  it('weekdays fires Mon–Fri only, on the hour', () => {
    const s = sub({ schedule: 'weekdays' });
    expect(isSubscriptionDue(s, MON_09)).toBe(true);
    expect(isSubscriptionDue(s, SAT_09)).toBe(false);
    expect(isSubscriptionDue(s, SUN_09)).toBe(false);
    expect(isSubscriptionDue(s, MON_10)).toBe(false);
  });

  it('weekly fires only on its weekday + hour', () => {
    const monday = sub({ schedule: 'weekly', weekday: 1 });
    expect(isSubscriptionDue(monday, MON_09)).toBe(true);
    expect(isSubscriptionDue(monday, SAT_09)).toBe(false);
    expect(isSubscriptionDue(monday, MON_10)).toBe(false);
    const saturday = sub({ schedule: 'weekly', weekday: 6 });
    expect(isSubscriptionDue(saturday, SAT_09)).toBe(true);
    expect(isSubscriptionDue(saturday, MON_09)).toBe(false);
  });

  it('weekly with a null weekday never fires (defensive — the service forbids it)', () => {
    expect(isSubscriptionDue(sub({ schedule: 'weekly', weekday: null }), MON_09)).toBe(false);
  });

  it('is DST-stable: a "daily at 09:00 UTC" sub fires at 09:00 UTC across a US DST shift', () => {
    // US "spring forward" was 2026-03-08. In a wall-clock-with-DST scheme the
    // 09:00 local trigger would shift by an hour around it; in UTC it does not.
    const beforeDst = new Date('2026-03-07T09:00:00.000Z');
    const afterDst = new Date('2026-03-09T09:00:00.000Z');
    expect(isSubscriptionDue(sub(), beforeDst)).toBe(true);
    expect(isSubscriptionDue(sub(), afterDst)).toBe(true);
    // The same instant at 08:00 UTC (what 09:00 local would become) is NOT due.
    expect(isSubscriptionDue(sub(), new Date('2026-03-09T08:00:00.000Z'))).toBe(false);
  });
});

describe('subscriptionOccurrenceKey — one key per scheduled tick', () => {
  it('is stable within the same UTC hour and distinct across hours/days/subs', () => {
    expect(subscriptionOccurrenceKey('sub-1', MON_09)).toBe(
      subscriptionOccurrenceKey('sub-1', new Date('2026-06-08T09:59:59.000Z')),
    );
    expect(subscriptionOccurrenceKey('sub-1', MON_09)).not.toBe(
      subscriptionOccurrenceKey('sub-1', MON_10),
    );
    expect(subscriptionOccurrenceKey('sub-1', MON_09)).not.toBe(
      subscriptionOccurrenceKey('sub-1', SAT_09),
    );
    expect(subscriptionOccurrenceKey('sub-1', MON_09)).not.toBe(
      subscriptionOccurrenceKey('sub-2', MON_09),
    );
  });
});

describe('hour / weekday validation', () => {
  it('accepts 0–23 hours and 0–6 weekdays, rejects out-of-range', () => {
    expect(isValidHour(0)).toBe(true);
    expect(isValidHour(23)).toBe(true);
    expect(isValidHour(24)).toBe(false);
    expect(isValidHour(-1)).toBe(false);
    expect(isValidHour(9.5)).toBe(false);
    expect(isValidWeekday(0)).toBe(true);
    expect(isValidWeekday(6)).toBe(true);
    expect(isValidWeekday(7)).toBe(false);
  });
});

describe('unsubscribe token — HMAC round-trip', () => {
  it('verifies a token it signed back to the subscription id', () => {
    const token = signUnsubscribeToken('sub-abc');
    expect(verifyUnsubscribeToken(token)).toBe('sub-abc');
  });

  it('rejects a tampered id, a tampered digest, and a malformed token', () => {
    const token = signUnsubscribeToken('sub-abc');
    const [id, digest] = token.split('.');
    expect(verifyUnsubscribeToken(`sub-XYZ.${digest}`)).toBeNull();
    expect(verifyUnsubscribeToken(`${id}.deadbeef`)).toBeNull();
    expect(verifyUnsubscribeToken('no-dot')).toBeNull();
    expect(verifyUnsubscribeToken('')).toBeNull();
  });
});
