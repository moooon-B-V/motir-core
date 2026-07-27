// The plan-change conversation's SCOPE (7.12.3 · MOTIR-909) — the pure half of
// "which thread is this?", kept out of the service so it can be unit-tested and
// so the route, the service and the repository all derive the key the SAME way.
//
// A plan-change thread is anchored either at the PROJECT (the shipped 7.30
// conversation) or at a SET of work items (a contextual planning turn: "re-plan
// this story", "add work under these two"). The anchor set is the thread's
// identity, so it needs a canonical form: `{MOTIR-9, MOTIR-4}` and
// `{MOTIR-4, MOTIR-9, MOTIR-4}` are the SAME conversation and must resume the
// same row rather than fork a second one.

/** The project-wide thread's scope key — the shipped 7.30 conversation. */
export const PROJECT_SCOPE_KEY = '';

/**
 * How many anchors one contextual thread may carry. The bound exists because the
 * scope is pushed to motir-ai as the UNION of every anchor's
 * item + parent + siblings + children (7.12.2 · MOTIR-908): the grounding context
 * grows with the anchor count, and an unbounded set is a cheap way to blow the
 * planner's context window. It is also the DB-side sanity bound on `scope_key`,
 * which is an indexed text column.
 */
export const MAX_SCOPE_TARGETS = 20;

export interface PlanChangeScope {
  /** The canonical discriminator persisted on the session row. */
  scopeKey: string;
  /** The anchor set, deduped and sorted — the order `scopeKey` is built from. */
  targetKeys: string[];
}

/** The project-wide scope: no anchors, empty key. */
export const PROJECT_SCOPE: PlanChangeScope = { scopeKey: PROJECT_SCOPE_KEY, targetKeys: [] };

/**
 * Canonicalize an anchor set into a scope. Deduped (case-insensitively — work-item
 * identifiers are case-insensitive everywhere else in the API, so `motir-9` and
 * `MOTIR-9` are one anchor) and sorted, so the key is a pure function of the SET,
 * not of the order the caller happened to list it in.
 *
 * Callers pass ALREADY-RESOLVED identifiers — resolution and the per-target
 * permission gate happen in the service, because this module deliberately touches
 * no database. An empty set yields {@link PROJECT_SCOPE}.
 */
export function buildScope(targetKeys: readonly string[]): PlanChangeScope {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const raw of targetKeys) {
    const key = raw.trim().toUpperCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(key);
  }
  if (unique.length === 0) return PROJECT_SCOPE;
  unique.sort();
  return { scopeKey: unique.join(','), targetKeys: unique };
}
