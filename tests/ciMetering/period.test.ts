import { describe, expect, it } from 'vitest';
import { periodEndFor, periodStartFor } from '@/lib/ciMetering/period';

// The metering period key (Story MOTIR-1775 · MOTIR-1896) —
// `docs/decisions/ci-minutes-allowance.md` §4.5: the calendar month in UTC.

describe('periodStartFor', () => {
  it('keys a run to midnight UTC on the 1st of its calendar month', () => {
    expect(periodStartFor(new Date('2026-07-30T22:12:43.000Z')).toISOString()).toBe(
      '2026-07-01T00:00:00.000Z',
    );
  });

  it('is idempotent — a period start keys to itself', () => {
    const start = periodStartFor(new Date('2026-07-30T22:12:43.000Z'));
    expect(periodStartFor(start).toISOString()).toBe(start.toISOString());
  });

  it('places the first and last instants of a month in the SAME period', () => {
    const first = periodStartFor(new Date('2026-07-01T00:00:00.000Z'));
    const last = periodStartFor(new Date('2026-07-31T23:59:59.999Z'));
    expect(first.toISOString()).toBe(last.toISOString());
  });

  it('splits two instants milliseconds apart across a month boundary', () => {
    expect(periodStartFor(new Date('2026-07-31T23:59:59.999Z')).toISOString()).toBe(
      '2026-07-01T00:00:00.000Z',
    );
    expect(periodStartFor(new Date('2026-08-01T00:00:00.000Z')).toISOString()).toBe(
      '2026-08-01T00:00:00.000Z',
    );
  });

  it('keys by UTC, not by the server’s local timezone', () => {
    // 2026-08-01T00:30Z is 31 July in UTC-2 and 1 August in UTC. Building the
    // key from UTC components means the same run lands in the same period on
    // every host — the class of bug the `Intl`-now/timezone lesson records.
    const instant = new Date('2026-08-01T00:30:00.000Z');
    expect(periodStartFor(instant).toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(periodStartFor(instant).getUTCDate()).toBe(1);
    expect(periodStartFor(instant).getUTCHours()).toBe(0);
  });

  it('handles a leap-day run', () => {
    expect(periodStartFor(new Date('2028-02-29T13:00:00.000Z')).toISOString()).toBe(
      '2028-02-01T00:00:00.000Z',
    );
  });

  it('does not mutate its argument', () => {
    const at = new Date('2026-07-30T22:12:43.000Z');
    periodStartFor(at);
    expect(at.toISOString()).toBe('2026-07-30T22:12:43.000Z');
  });
});

describe('periodEndFor', () => {
  it('is the first instant of the NEXT month — the reset moment', () => {
    expect(periodEndFor(new Date('2026-07-01T00:00:00.000Z')).toISOString()).toBe(
      '2026-08-01T00:00:00.000Z',
    );
  });

  it('rolls the year over December', () => {
    expect(periodEndFor(new Date('2026-12-01T00:00:00.000Z')).toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });

  it('is exclusive: the end instant belongs to the NEXT period', () => {
    const start = periodStartFor(new Date('2026-07-15T00:00:00.000Z'));
    const end = periodEndFor(start);
    expect(periodStartFor(end).toISOString()).not.toBe(start.toISOString());
  });
});
