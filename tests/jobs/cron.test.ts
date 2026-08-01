import { describe, expect, it } from 'vitest';
import {
  CRON_SEARCH_HORIZON_DAYS,
  UnsupportedCronError,
  cronMatches,
  parseCron,
  previousFireAtOrBefore,
} from '@/lib/jobs/cron';

// The cron evaluator behind the schedule-health check (MOTIR-1970). Pure — no
// DB, no clock. Every assertion below pins a property the health check's verdict
// depends on: getting the previous tick wrong in either direction turns the
// detector into either a false alarm or the same silence it exists to break.
//
// All expectations are UTC, because Inngest evaluates unqualified crons in UTC.

const utc = (iso: string) => new Date(iso);

describe('parseCron', () => {
  it('parses the expressions Motir actually schedules', () => {
    expect([...parseCron('0 9 * * *').hour]).toEqual([9]);
    expect([...parseCron('20 * * * *').minute]).toEqual([20]);
    expect([...parseCron('0 4 3 * *').dayOfMonth]).toEqual([3]);
  });

  it('expands steps, ranges and lists', () => {
    expect([...parseCron('*/15 * * * *').minute]).toEqual([0, 15, 30, 45]);
    expect([...parseCron('0 9-11 * * *').hour]).toEqual([9, 10, 11]);
    expect([...parseCron('0 1,13 * * *').hour]).toEqual([1, 13]);
    expect([...parseCron('0 0-23/6 * * *').hour]).toEqual([0, 6, 12, 18]);
    // A bare number WITH a step reads as "from N to the field max, every step".
    expect([...parseCron('0 6/6 * * *').hour]).toEqual([6, 12, 18]);
  });

  it('normalises day-of-week 7 onto 0 (Sunday)', () => {
    expect([...parseCron('0 9 * * 7').dayOfWeek]).toEqual([0]);
  });

  it('tracks whether the day fields are restricted', () => {
    const wildcard = parseCron('0 9 * * *');
    expect(wildcard.dayOfMonthRestricted).toBe(false);
    expect(wildcard.dayOfWeekRestricted).toBe(false);

    const restricted = parseCron('0 9 1 * 1');
    expect(restricted.dayOfMonthRestricted).toBe(true);
    expect(restricted.dayOfWeekRestricted).toBe(true);

    // `*/2` is a restriction even though it starts from `*`.
    expect(parseCron('0 9 */2 * *').dayOfMonthRestricted).toBe(true);
  });

  it('THROWS rather than guessing on anything outside the supported subset', () => {
    // Guessing is the dangerous behaviour: a misread expression yields a wrong
    // deadline, and a wrong deadline is a detector that lies. Failing loudly at
    // test time is the whole point.
    expect(() => parseCron('0 9 * *')).toThrow(UnsupportedCronError);
    expect(() => parseCron('0 9 * * * *')).toThrow(UnsupportedCronError);
    expect(() => parseCron('0 9 L * *')).toThrow(UnsupportedCronError);
    expect(() => parseCron('0 9 * * MON')).toThrow(UnsupportedCronError);
    expect(() => parseCron('99 9 * * *')).toThrow(UnsupportedCronError);
    expect(() => parseCron('0 9 * * 1-0')).toThrow(UnsupportedCronError);
    expect(() => parseCron('*/0 9 * * *')).toThrow(UnsupportedCronError);
    expect(() => parseCron('*/x 9 * * *')).toThrow(UnsupportedCronError);
  });
});

describe('cronMatches', () => {
  it('matches only on the exact minute', () => {
    const cron = parseCron('30 * * * *');
    expect(cronMatches(cron, utc('2026-08-01T22:30:00Z'))).toBe(true);
    expect(cronMatches(cron, utc('2026-08-01T22:31:00Z'))).toBe(false);
    expect(cronMatches(cron, utc('2026-08-01T22:29:00Z'))).toBe(false);
  });

  it('applies the POSIX day-of-month OR day-of-week rule', () => {
    // Both restricted → EITHER may satisfy the day. 2026-08-03 is a Monday, so
    // the 1st (a Saturday, matching the DOM term) and every Monday both fire.
    const both = parseCron('0 9 1 * 1');
    expect(cronMatches(both, utc('2026-08-01T09:00:00Z'))).toBe(true); // DOM hit
    expect(cronMatches(both, utc('2026-08-03T09:00:00Z'))).toBe(true); // DOW hit
    expect(cronMatches(both, utc('2026-08-04T09:00:00Z'))).toBe(false); // neither

    // Only DOM restricted → day-of-week is not consulted at all.
    const domOnly = parseCron('0 9 3 * *');
    expect(cronMatches(domOnly, utc('2026-08-03T09:00:00Z'))).toBe(true);
    expect(cronMatches(domOnly, utc('2026-08-04T09:00:00Z'))).toBe(false);

    // Only DOW restricted → day-of-month is not consulted.
    const dowOnly = parseCron('0 9 * * 1');
    expect(cronMatches(dowOnly, utc('2026-08-03T09:00:00Z'))).toBe(true);
    expect(cronMatches(dowOnly, utc('2026-08-04T09:00:00Z'))).toBe(false);
  });

  it('respects the month field', () => {
    const cron = parseCron('0 9 * 8 *');
    expect(cronMatches(cron, utc('2026-08-01T09:00:00Z'))).toBe(true);
    expect(cronMatches(cron, utc('2026-07-01T09:00:00Z'))).toBe(false);
  });
});

describe('previousFireAtOrBefore', () => {
  it('returns the current minute when it is itself a fire', () => {
    expect(previousFireAtOrBefore('30 * * * *', utc('2026-08-01T22:30:00Z'))).toEqual(
      utc('2026-08-01T22:30:00Z'),
    );
  });

  it('ignores seconds — a fire at :30:00 counts from anywhere inside that minute', () => {
    expect(previousFireAtOrBefore('30 * * * *', utc('2026-08-01T22:30:59Z'))).toEqual(
      utc('2026-08-01T22:30:00Z'),
    );
  });

  it('walks back within the same day for an hourly schedule', () => {
    expect(previousFireAtOrBefore('20 * * * *', utc('2026-08-01T22:05:00Z'))).toEqual(
      utc('2026-08-01T21:20:00Z'),
    );
  });

  it('crosses the day boundary for a daily schedule', () => {
    expect(previousFireAtOrBefore('0 9 * * *', utc('2026-08-01T08:59:00Z'))).toEqual(
      utc('2026-07-31T09:00:00Z'),
    );
  });

  it('crosses the month boundary for a monthly schedule', () => {
    // `0 4 3 * *` — 04:00 on the 3rd. Asked on 1 Aug, the previous fire is 3 Jul.
    expect(previousFireAtOrBefore('0 4 3 * *', utc('2026-08-01T22:00:00Z'))).toEqual(
      utc('2026-07-03T04:00:00Z'),
    );
  });

  it('crosses the year boundary', () => {
    expect(previousFireAtOrBefore('0 9 1 1 *', utc('2026-08-01T22:00:00Z'))).toEqual(
      utc('2026-01-01T09:00:00Z'),
    );
  });

  it('handles a February 29th schedule by reaching back to the last leap year', () => {
    // Asked from Jan 2025, the previous 29 Feb was 2024 — 307 days back, inside
    // the horizon. (Asked from Aug 2026 the same expression is 884 days back and
    // correctly reads as null: see the horizon test below.)
    expect(previousFireAtOrBefore('0 9 29 2 *', utc('2025-01-01T00:00:00Z'))).toEqual(
      utc('2024-02-29T09:00:00Z'),
    );
    expect(previousFireAtOrBefore('0 9 29 2 *', utc('2026-08-01T00:00:00Z'))).toBeNull();
  });

  it('returns null when nothing fires inside the search horizon', () => {
    // 31 February never occurs, so the walk exhausts the horizon and gives up
    // rather than looping forever.
    expect(previousFireAtOrBefore('0 9 31 2 *', utc('2026-08-01T00:00:00Z'))).toBeNull();
  });

  it('bounds the search to CRON_SEARCH_HORIZON_DAYS', () => {
    // A schedule whose previous fire is JUST outside the horizon reads as null;
    // just inside it resolves. This pins the bound rather than leaving it
    // incidental — the health check treats null as "not judged", so a horizon
    // that silently shrank would start letting real faults through.
    expect(CRON_SEARCH_HORIZON_DAYS).toBe(400);
    const justInside = new Date(Date.UTC(2026, 7, 1));
    justInside.setUTCDate(justInside.getUTCDate() - (CRON_SEARCH_HORIZON_DAYS - 1));
    const cron = `0 0 ${justInside.getUTCDate()} ${justInside.getUTCMonth() + 1} *`;
    expect(previousFireAtOrBefore(cron, utc('2026-08-01T00:00:00Z'))).not.toBeNull();
  });

  it('propagates the parse error for an unsupported expression', () => {
    expect(() => previousFireAtOrBefore('0 9 L * *', utc('2026-08-01T00:00:00Z'))).toThrow(
      UnsupportedCronError,
    );
  });
});
