// The CONSUMING half of MOTIR-1817's boundary contract (MOTIR-1819): reading an
// `ask_project` job's ANSWER — and its REDIRECT — off a motir-ai job result.
//
// Same posture as `plannerTurn.ts` one file over, and for the same reason:
// motir-ai's envelope documents `ask` as "purely additive; core reads results
// loosely", the producer ships ahead of the consumer by design, and a result
// that carries nothing readable is not an error — it is a job with nothing to
// say. What this does NOT do is trust the shape: the field crosses a network
// boundary from a separately-deployed service and every branch of it becomes a
// persisted row, so each is checked and bounded on READ.
//
// ⚠️ THE ONE PLACE THE DEFAULT MATTERS. An unreadable result reads as an
// `ask` that produced no answer — NEVER as a `plan_change`. Getting this
// backwards would turn an unparseable envelope into a dispatched plan-edit job
// the person never asked for: the expensive half of the asymmetry
// `docs/decisions/conversation-turn-intent.md` §4 rests its default on.

/** What an `ask_project` result says, once read defensively. */
export interface AskOutcome {
  /** Which intent the turn RAN AS — `plan_change` is the redirect. */
  intent: 'ask' | 'plan_change';
  /** The answer body, or null on a redirect and on an empty utterance. */
  answer: string | null;
  /** Work-item keys the answer rests on. Always `[]` on a redirect. */
  citations: string[];
}

// Bounds applied on READ, not merely trusted from the producer — this text
// becomes a database row. The answer is allowed more room than a planner's
// findings report because it is the deliverable rather than a narration.
export const ASK_ANSWER_MAX_CHARS = 8000;
/** A defensive cap on how many citations one answer may carry. An answer resting
 *  on forty work items is not an answer a person can check, and the rail renders
 *  each as a chip. */
export const ASK_MAX_CITATIONS = 20;

/** A work-item identifier, as the boundary is allowed to name one. Anchored on
 *  both ends: a value that merely CONTAINS a key is not a key. */
const WORK_ITEM_KEY = /^[A-Z][A-Z0-9]{1,15}-\d+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

/** The citations, de-duplicated, key-shaped and bounded. A malformed entry is
 *  dropped rather than failing the read: the answer is still worth showing with
 *  the citations that ARE readable, and the service re-validates every survivor
 *  against the project's own work items before persisting one. */
function readCitations(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const key = entry.trim();
    if (!WORK_ITEM_KEY.test(key) || out.includes(key)) continue;
    out.push(key);
    if (out.length === ASK_MAX_CITATIONS) break;
  }
  return out;
}

/**
 * Read an `ask_project` job's outcome. Total over any input — an arbitrary JSON
 * value is a legitimate argument and yields the safe default rather than
 * throwing.
 *
 * `null` means the result carried no `ask` unit at all: an older engine, a
 * different job kind, or a job that failed before it produced one. That is
 * distinct from `{ intent: 'ask', answer: null }`, which is a job that RAN and
 * had nothing to say — the caller renders those differently, so the read keeps
 * them apart.
 */
export function readAskOutcome(result: unknown): AskOutcome | null {
  if (!isRecord(result)) return null;
  const ask = result['ask'];
  if (!isRecord(ask)) return null;

  // The redirect: no answer and no citations, whatever else the field carried.
  if (ask['intent'] === 'plan_change') {
    return { intent: 'plan_change', answer: null, citations: [] };
  }

  return {
    intent: 'ask',
    answer: boundedString(ask['answer'], ASK_ANSWER_MAX_CHARS),
    citations: readCitations(ask['citations']),
  };
}
