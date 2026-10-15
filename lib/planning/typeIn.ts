import type { PlanReviewItemDto } from '@/lib/dto/planReview';

// THE TYPEWRITER'S PURE HALF (Story MOTIR-8590 · Subtask MOTIR-8595; design
// `design/ai-planning/design-notes.md` Part XXVIII §28.6 Table C).
//
// Only in the overlay's proposal quick view while the plan is `generating`: a
// field that was UNWRITTEN when the quick view opened, and that then arrives on a
// later snapshot, types itself in. Table C decides which fields (title, then
// description, then explanation — the rail scalars simply appear), their order
// (one after another, in reading order), the pace and the cap. Everything here is
// pure, so the rules are tested without a DOM or a clock.

/** The fields that type, in READING ORDER — the order a snapshot's arrivals queue in. */
export const TYPED_FIELDS = ['title', 'descriptionMd', 'explanationMd'] as const;
export type TypedField = (typeof TYPED_FIELDS)[number];

/**
 * `--typewriter-char-interval` (app/globals.css): one character, in ms. Mirrored
 * here as the fallback a component uses where the computed token cannot be read;
 * `tests/planning/typeIn.test.ts` holds the two equal.
 */
export const TYPEWRITER_CHAR_INTERVAL_MS = 12;
/** `--transition-slow` at its base value (the design system's theme). */
export const TRANSITION_SLOW_MS = 250;
/** The per-field cap, `calc(var(--transition-slow) * 3)`. */
export const TYPEWRITER_CAP_MS = TRANSITION_SLOW_MS * 3;

/** Unwritten: `null`, `undefined`, or a string that is empty once trimmed. */
export function isUnwritten(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  return typeof value === 'string' && value.trim().length === 0;
}

/**
 * The typeable fields unwritten on the proposal — read from the REVIEW item, never
 * from the quick view's payload, which fills defaults (`priority ?? 'medium'`).
 */
export function unwrittenFields(item: Pick<PlanReviewItemDto, TypedField>): Set<TypedField> {
  return new Set(TYPED_FIELDS.filter((field) => isUnwritten(item[field])));
}

/**
 * How many of `total` characters are shown `elapsedMs` after typing began. Linear
 * at `paceMs` per character, sped up so the whole field always lands within
 * `capMs`; never more than `total`, never less than zero.
 */
export function typedLength(
  total: number,
  elapsedMs: number,
  paceMs: number = TYPEWRITER_CHAR_INTERVAL_MS,
  capMs: number = TYPEWRITER_CAP_MS,
): number {
  if (total <= 0) return 0;
  const durationMs = Math.min(total * paceMs, capMs);
  if (elapsedMs >= durationMs) return total;
  if (elapsedMs <= 0) return 0;
  return Math.min(total, Math.floor((elapsedMs / durationMs) * total));
}

/** A CSS time (`12ms`, `0.25s`) in ms; `null` for anything else. */
export function parseCssTime(value: string): number | null {
  const match = /^\s*(-?\d*\.?\d+)(ms|s)\s*$/.exec(value);
  if (!match) return null;
  const n = Number(match[1]);
  return match[2] === 's' ? n * 1000 : n;
}

/**
 * ONE OPEN's typing: which armed fields have not arrived yet (`pending`), and the
 * arrived ones waiting their turn (`queue` — its head is the one typing), with the
 * value each arrived AS, so a value that changes afterwards is shown final.
 */
export interface TypeInRun {
  pending: readonly TypedField[];
  queue: readonly TypedField[];
  arrived: Readonly<Partial<Record<TypedField, string>>>;
}

export const NO_TYPE_IN: TypeInRun = { pending: [], queue: [], arrived: {} };

/** A run armed on the fields unwritten when the quick view opened. */
export function startTypeIn(armed: ReadonlySet<TypedField> | null): TypeInRun {
  if (!armed || armed.size === 0) return NO_TYPE_IN;
  return { pending: TYPED_FIELDS.filter((f) => armed.has(f)), queue: [], arrived: {} };
}

/**
 * Folds the panel's CURRENT values into the run. Returns the SAME object when
 * nothing changed, so a caller can hold it with the derived-state pattern.
 *
 * - A pending field whose value is now written joins the queue (reading order).
 * - A queued or typing field whose value changed leaves the queue: shown final.
 * - `enabled` false (the plan finished, reduced motion, not a live proposal):
 *   everything stops, and every field shows at once.
 */
export function foldTypeIn(
  run: TypeInRun,
  values: Readonly<Partial<Record<TypedField, string | null | undefined>>>,
  enabled: boolean,
): TypeInRun {
  if (!enabled) return run.pending.length || run.queue.length ? NO_TYPE_IN : run;
  let pending = run.pending;
  let queue = run.queue;
  let arrived = run.arrived;
  for (const field of TYPED_FIELDS) {
    const value = values[field];
    if (pending.includes(field)) {
      if (isUnwritten(value)) continue;
      pending = pending.filter((f) => f !== field);
      queue = [...queue, field];
      arrived = { ...arrived, [field]: value as string };
    } else if (queue.includes(field) && value !== arrived[field]) {
      queue = queue.filter((f) => f !== field);
    }
  }
  return pending === run.pending && queue === run.queue ? run : { pending, queue, arrived };
}

/** The typing field landed: the next one in the queue starts. */
export function finishTypeIn(run: TypeInRun, field: TypedField): TypeInRun {
  return run.queue.includes(field) ? { ...run, queue: run.queue.filter((f) => f !== field) } : run;
}

/**
 * Where a field stands in the run: `pending` (armed, not arrived — the shipped
 * empty treatment), `queued` (arrived, waiting its turn — still the empty
 * treatment on screen), `typing`, or `final`.
 */
export type TypeInPhase = 'pending' | 'queued' | 'typing' | 'final';

export function typeInPhase(run: TypeInRun, field: TypedField): TypeInPhase {
  if (run.queue[0] === field) return 'typing';
  if (run.queue.includes(field)) return 'queued';
  if (run.pending.includes(field)) return 'pending';
  return 'final';
}
