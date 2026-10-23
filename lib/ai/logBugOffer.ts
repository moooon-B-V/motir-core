import { InvalidAuthoredBugError, parseAuthoredBug, type AuthoredBug } from '@/lib/ai/authoredBug';
import { DEBUG_CRITERIA_MAX, DEBUG_TITLE_MAX } from '@/lib/ai/debugBug';

// THE LOG-A-BUG OFFER an answer carries (Story MOTIR-9220 · MOTIR-9322), as
// motir-core accepts it — the mirror of motir-ai's `AskLogBugOffer`
// (`src/envelope.ts`, MOTIR-9321).
//
// The posture of `debugBug.ts`, for the same reason: the offer is model output from a
// separately deployed service, and every field of it becomes a write on somebody's
// card once a person agrees. So this PARSES; it never casts. The draft is
// `authoredBug`'s exact shape and goes through `parseAuthoredBug` unchanged; the
// fields around it are bounded here the way `parseDebugBug` bounds a diagnosis. One
// failed field refuses the WHOLE offer with `InvalidAuthoredBugError` naming it, and
// the settle drops a refused offer while the answer still lands.
//
// The TARGET parsed here is a CLAIM. The settle re-resolves it under the sender's own
// access before anything is stored (`logBugOfferService.land`).

/** Where the offer's one write goes, as motir-ai named it. */
export type LogBugTargetKind = 'new' | 'anchored' | 'existing';
export const LOG_BUG_TARGET_KINDS: readonly LogBugTargetKind[] = ['new', 'anchored', 'existing'];

/** At most this many context refs ride an offer — motir-ai's own cap. */
export const LOG_BUG_CONTEXT_REFS_MAX = 20;

/** A work-item identifier as the boundary may name one — `askResult.ts`'s rule. */
const WORK_ITEM_KEY = /^[A-Z][A-Z0-9]{1,15}-\d+$/;

export interface LogBugOfferClaim {
  kind: 'log_bug';
  /** The title a NEW bug would carry. */
  title: string;
  acceptanceCriteria: string[];
  /** The draft — `parseAuthoredBug`'s validated shape. */
  draft: AuthoredBug;
  target: { kind: 'new'; key: null } | { kind: 'anchored' | 'existing'; key: string };
  /** The code files the answer read and cited (repository-relative paths). */
  contextRefs: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseTarget(raw: unknown): LogBugOfferClaim['target'] {
  if (!isRecord(raw)) throw new InvalidAuthoredBugError('target', 'is not an object');
  const kind = raw['kind'];
  if (kind === 'new') return { kind, key: null };
  if (kind !== 'anchored' && kind !== 'existing') {
    throw new InvalidAuthoredBugError('target', 'kind must be new | anchored | existing');
  }
  const key = raw['key'];
  if (typeof key !== 'string' || !WORK_ITEM_KEY.test(key)) {
    throw new InvalidAuthoredBugError('target', 'key must be a work-item key');
  }
  return { kind, key };
}

function parseContextRefs(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.some((r) => typeof r !== 'string' || r.trim().length === 0)) {
    throw new InvalidAuthoredBugError('contextRefs', 'must be a list of non-empty paths');
  }
  const refs = [...new Set((raw as string[]).map((r) => r.trim()))];
  if (refs.length === 0) {
    throw new InvalidAuthoredBugError('contextRefs', 'must name at least one code file');
  }
  if (refs.length > LOG_BUG_CONTEXT_REFS_MAX) {
    throw new InvalidAuthoredBugError('contextRefs', `exceeds ${LOG_BUG_CONTEXT_REFS_MAX} paths`);
  }
  return refs;
}

/**
 * Parse an answer's `offer` of kind `log_bug`, or THROW {@link InvalidAuthoredBugError}
 * naming the first field that failed.
 *
 * Checks, in order: the offer is an object of kind `log_bug`; `title` is non-empty and
 * within {@link DEBUG_TITLE_MAX}; `acceptanceCriteria` holds 1–{@link DEBUG_CRITERIA_MAX}
 * non-empty strings; the draft passes `parseAuthoredBug` and is grounded; `target` is
 * `new`, or `anchored` / `existing` with a work-item key; `contextRefs` names at least
 * one code file.
 */
export function parseLogBugOffer(raw: unknown): LogBugOfferClaim {
  if (!isRecord(raw) || raw['kind'] !== 'log_bug') {
    throw new InvalidAuthoredBugError('offer', 'is not a log_bug offer');
  }
  const rawTitle = raw['title'];
  if (typeof rawTitle !== 'string' || rawTitle.trim().length === 0) {
    throw new InvalidAuthoredBugError('title', 'must be a non-empty string');
  }
  const title = rawTitle.trim();
  if (title.length > DEBUG_TITLE_MAX || /\n/.test(title)) {
    throw new InvalidAuthoredBugError('title', `must be one line within ${DEBUG_TITLE_MAX}`);
  }
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
  const draft = parseAuthoredBug(raw['draft']);
  if (!draft.grounded) throw new InvalidAuthoredBugError('draft', 'is not grounded');
  return {
    kind: 'log_bug',
    title,
    acceptanceCriteria: (criteria as string[]).map((c) => c.trim()),
    draft,
    target: parseTarget(raw['target']),
    contextRefs: parseContextRefs(raw['contextRefs']),
  };
}

/** The offer, or null when it fails any check — the settle's total form. */
export function readLogBugOffer(raw: unknown): LogBugOfferClaim | null {
  try {
    return parseLogBugOffer(raw);
  } catch (err) {
    if (err instanceof InvalidAuthoredBugError) return null;
    throw err;
  }
}
