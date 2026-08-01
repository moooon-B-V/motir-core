// A minimal UTC cron evaluator (MOTIR-1970) — just enough to answer ONE
// question: "when should this scheduled job last have fired?"
//
// It exists because the schedule-health check (`jobScheduleHealthService`) has
// to compare a cron job's newest `job_run` row against the tick it was supposed
// to have. That comparison is period-relative — an hourly job missing two ticks
// and a monthly job missing two ticks are the same fault — so it needs real
// cron arithmetic, not a hardcoded staleness ceiling per job.
//
// It is deliberately NOT a general cron library. Inngest owns the actual
// scheduling; this only has to READ the same expressions back. So it supports
// exactly the standard 5-field grammar (`minute hour day-of-month month
// day-of-week`) with `*`, `a`, `a-b`, `*/n`, `a-b/n` and comma lists, and it
// THROWS on anything else rather than guessing — an exotic expression added to
// a future job surfaces as a failing test, never as a silently-skipped check.
//
// TIMEZONE: UTC, because Inngest evaluates unqualified cron expressions in UTC.
// Every date function below is the `getUTC*` family for that reason; using the
// local-time accessors would drift the check by the runner's offset.

/** Field bounds, in the order the five cron fields appear. */
const FIELD_BOUNDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dayOfMonth', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dayOfWeek', min: 0, max: 6 },
] as const;

/**
 * How far back `previousFireAtOrBefore` will look before giving up. Generous
 * enough to cover the longest cadence any Motir job uses (monthly) with room to
 * spare, bounded so a never-matching expression terminates instead of hanging.
 */
export const CRON_SEARCH_HORIZON_DAYS = 400;

/** A parsed cron expression: the set of legal values for each field. */
export interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  /** True when the day-of-month field is anything other than `*`. */
  dayOfMonthRestricted: boolean;
  /** True when the day-of-week field is anything other than `*`. */
  dayOfWeekRestricted: boolean;
}

/** Thrown when an expression is outside the supported subset. */
export class UnsupportedCronError extends Error {
  constructor(expr: string, detail: string) {
    super(`Unsupported cron expression "${expr}": ${detail}`);
    this.name = 'UnsupportedCronError';
  }
}

function parseField(
  expr: string,
  raw: string,
  index: number,
): { values: Set<number>; wildcard: boolean } {
  const bounds = FIELD_BOUNDS[index]!;
  const values = new Set<number>();
  let wildcard = false;

  for (const term of raw.split(',')) {
    const [rangePart, stepPart] = term.split('/');
    if (stepPart !== undefined && !/^\d+$/.test(stepPart)) {
      throw new UnsupportedCronError(expr, `bad step in ${bounds.name} term "${term}"`);
    }
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (step < 1)
      throw new UnsupportedCronError(expr, `zero step in ${bounds.name} term "${term}"`);

    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      wildcard = wildcard || stepPart === undefined;
      lo = bounds.min;
      hi = bounds.max;
    } else if (/^\d+$/.test(rangePart!)) {
      lo = Number(rangePart);
      // A bare number WITH a step (`5/10`) means "from 5 to the field max",
      // which is how cron reads it; without a step it is the single value.
      hi = stepPart === undefined ? lo : bounds.max;
    } else {
      const match = /^(\d+)-(\d+)$/.exec(rangePart!);
      if (!match) {
        throw new UnsupportedCronError(expr, `unrecognised ${bounds.name} term "${term}"`);
      }
      lo = Number(match[1]);
      hi = Number(match[2]);
    }

    // Cron's Sunday may be written as 7; normalise it onto 0 so the set the
    // matcher tests against is always 0..6.
    if (bounds.name === 'dayOfWeek') {
      if (lo === 7) lo = 0;
      if (hi === 7) hi = 0;
    }
    if (lo < bounds.min || hi > bounds.max || lo > hi) {
      throw new UnsupportedCronError(expr, `${bounds.name} term "${term}" out of range`);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }

  if (values.size === 0) throw new UnsupportedCronError(expr, `empty ${bounds.name} field`);
  return { values, wildcard };
}

/** Parse a 5-field UTC cron expression. Throws `UnsupportedCronError` outside the subset. */
export function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new UnsupportedCronError(expr, `expected 5 fields, got ${fields.length}`);
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields.map((raw, i) =>
    parseField(expr, raw, i),
  );
  return {
    minute: minute!.values,
    hour: hour!.values,
    dayOfMonth: dayOfMonth!.values,
    month: month!.values,
    dayOfWeek: dayOfWeek!.values,
    dayOfMonthRestricted: !dayOfMonth!.wildcard,
    dayOfWeekRestricted: !dayOfWeek!.wildcard,
  };
}

/**
 * Does this UTC date's DAY satisfy the expression's month / day-of-month /
 * day-of-week fields?
 *
 * The day-of-month ∧ day-of-week pair follows POSIX's odd-but-standard rule:
 * when BOTH are restricted the day matches if EITHER does (a union, not an
 * intersection); when only one is restricted, only that one is consulted.
 */
function dayMatches(cron: ParsedCron, date: Date): boolean {
  if (!cron.month.has(date.getUTCMonth() + 1)) return false;
  const domHit = cron.dayOfMonth.has(date.getUTCDate());
  const dowHit = cron.dayOfWeek.has(date.getUTCDay());
  if (cron.dayOfMonthRestricted && cron.dayOfWeekRestricted) return domHit || dowHit;
  if (cron.dayOfMonthRestricted) return domHit;
  if (cron.dayOfWeekRestricted) return dowHit;
  return true;
}

/** Does the expression fire at exactly this UTC minute? */
export function cronMatches(cron: ParsedCron, date: Date): boolean {
  return (
    cron.minute.has(date.getUTCMinutes()) &&
    cron.hour.has(date.getUTCHours()) &&
    dayMatches(cron, date)
  );
}

/**
 * The latest scheduled fire time at or before `at`, or null if the expression
 * has no fire inside `CRON_SEARCH_HORIZON_DAYS`.
 *
 * Walks backwards a DAY at a time and only descends into minutes on a day the
 * date fields admit — so a monthly expression costs ~30 day-checks plus one
 * day's worth of minute-checks, not 43,000 minute-checks.
 */
export function previousFireAtOrBefore(expr: string, at: Date): Date | null {
  const cron = parseCron(expr);
  // Truncate to the minute: cron fires on minute boundaries, and a partial
  // minute would make the "at or before" boundary depend on the seconds.
  const cursor = new Date(at.getTime());
  cursor.setUTCSeconds(0, 0);

  for (let day = 0; day <= CRON_SEARCH_HORIZON_DAYS; day++) {
    if (dayMatches(cron, cursor)) {
      // On the FIRST day we start from `at`'s own minute; on every earlier day
      // we start at 23:59 and scan the whole day.
      const startMinutes =
        day === 0 ? cursor.getUTCHours() * 60 + cursor.getUTCMinutes() : 24 * 60 - 1;
      for (let m = startMinutes; m >= 0; m--) {
        const candidate = new Date(cursor.getTime());
        candidate.setUTCHours(Math.floor(m / 60), m % 60, 0, 0);
        if (cronMatches(cron, candidate)) return candidate;
      }
    }
    // Step back one whole day, landing on 23:59 so the next iteration's scan
    // covers it end-to-end.
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    cursor.setUTCHours(23, 59, 0, 0);
  }
  return null;
}
