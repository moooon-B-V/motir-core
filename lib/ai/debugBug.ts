import { InvalidAuthoredBugError, parseAuthoredBug, type AuthoredBug } from '@/lib/ai/authoredBug';

// The ONE diagnosis a `debug_bug` job returns (Story MOTIR-7042 · MOTIR-7046
// handler, MOTIR-7049 consumer), as motir-core accepts it — the mirror of
// motir-ai's `DebugBugResult` (`src/jobs/handlers/debugBug.ts`).
//
// The same posture as `authoredBug.ts`, and for the same reason: the result is
// model output from a separately-deployed service, and every field of it becomes
// a write on somebody's card. So this PARSES; it never casts. The diagnosis is
// FLAT and is `authoredBug`'s exact shape, so it goes through `parseAuthoredBug`
// unchanged; the fields around it are checked here. One failed field refuses the
// WHOLE result with `InvalidAuthoredBugError` naming it — a half-landed diagnosis
// is worse than none, because it looks authored.

/** The longest new-card title accepted — motir-ai's `DEBUG_BUG_TITLE_MAX`, and
 *  the triage intake's own cap (`MAX_TRIAGE_TITLE_LENGTH`) is no tighter. */
export const DEBUG_TITLE_MAX = 200;
/** The acceptance-criteria bounds motir-ai states (1–8). */
export const DEBUG_CRITERIA_MAX = 8;
/** A bound on the rail's one-line reply, applied on READ. */
export const DEBUG_REPLY_MAX = 2_000;
/** A bound on the duplicate search's one-sentence reason (motir-ai caps it at 500). */
export const DEBUG_MATCH_REASON_MAX = 500;

/** A work-item identifier as the boundary may name one — `askResult.ts`'s rule. */
const WORK_ITEM_KEY = /^[A-Z][A-Z0-9]{1,15}-\d+$/;

interface DebugBugCommon {
  /** The key the turn was anchored on, as motir-ai ECHOED it — a claim the
   *  landing re-resolves under the caller's access, never a fact. */
  anchorKey: string | null;
  /** The rail's one-line account of what happened. */
  replyMd: string;
  /** The title a NEW card would carry. */
  title: string;
  acceptanceCriteria: string[];
  /** The diagnosis — `parseAuthoredBug`'s validated shape. */
  diagnosis: AuthoredBug;
}

export type DebugBugOutcome =
  | (DebugBugCommon & {
      outcome: 'enrich_existing';
      /** The card the duplicate search READ and judged to cover the defect. */
      workItemKey: string;
      matchReason: string | null;
    })
  | (DebugBugCommon & { outcome: 'diagnose' });

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function boundedText(raw: Record<string, unknown>, key: string, max: number): string {
  const v = raw[key];
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new InvalidAuthoredBugError(key, 'must be a non-empty string');
  }
  const trimmed = v.trim();
  if (trimmed.length > max) throw new InvalidAuthoredBugError(key, `exceeds ${max} characters`);
  return trimmed;
}

function optionalKey(raw: Record<string, unknown>, key: string): string | null {
  const v = raw[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !WORK_ITEM_KEY.test(v)) {
    throw new InvalidAuthoredBugError(key, 'must be a work-item key or null');
  }
  return v;
}

/**
 * Parse a job result's `debugBug` into a typed outcome, or THROW
 * {@link InvalidAuthoredBugError} naming the first field that failed.
 *
 * Checks, in order: the unit is an object; `outcome` is one of the two; the
 * diagnosis passes `parseAuthoredBug` (every rule that parser states); `title`
 * is non-empty and within {@link DEBUG_TITLE_MAX}; `acceptanceCriteria` holds
 * 1–{@link DEBUG_CRITERIA_MAX} non-empty strings; `replyMd` is non-empty;
 * `anchorKey` is a key or null; and on `enrich_existing`, `workItemKey` is a key
 * that is not the anchor itself (motir-ai falls back to `diagnose` for that
 * case, so arriving here means the far side is wrong).
 */
export function parseDebugBug(raw: unknown): DebugBugOutcome {
  if (!isRecord(raw)) throw new InvalidAuthoredBugError('debugBug', 'is not an object');
  const outcome = raw['outcome'];
  if (outcome !== 'enrich_existing' && outcome !== 'diagnose') {
    throw new InvalidAuthoredBugError('outcome', 'must be enrich_existing | diagnose');
  }

  const diagnosis = parseAuthoredBug(raw);

  const title = boundedText(raw, 'title', DEBUG_TITLE_MAX);
  const criteria = raw['acceptanceCriteria'];
  if (
    !Array.isArray(criteria) ||
    criteria.length === 0 ||
    criteria.length > DEBUG_CRITERIA_MAX ||
    criteria.some((c) => typeof c !== 'string' || c.trim().length === 0)
  ) {
    throw new InvalidAuthoredBugError(
      'acceptanceCriteria',
      `must hold 1..${DEBUG_CRITERIA_MAX} non-empty strings`,
    );
  }
  const replyMd = boundedText(raw, 'replyMd', DEBUG_REPLY_MAX);
  const anchorKey = optionalKey(raw, 'anchorKey');
  const common: DebugBugCommon = {
    anchorKey,
    replyMd,
    title,
    acceptanceCriteria: (criteria as string[]).map((c) => c.trim()),
    diagnosis,
  };

  if (outcome === 'diagnose') return { ...common, outcome };

  const workItemKey = optionalKey(raw, 'workItemKey');
  if (!workItemKey) throw new InvalidAuthoredBugError('workItemKey', 'must be a work-item key');
  if (workItemKey === anchorKey) {
    throw new InvalidAuthoredBugError('workItemKey', 'must not be the anchor itself');
  }
  const reason = raw['matchReason'];
  const matchReason =
    typeof reason === 'string' && reason.trim().length > 0
      ? reason.trim().slice(0, DEBUG_MATCH_REASON_MAX)
      : null;
  return { ...common, outcome, workItemKey, matchReason };
}
