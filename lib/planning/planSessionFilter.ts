import { PLAN_SESSION_FILTER_VALUES, type PlanSessionFilterDto } from '@/lib/dto/planSessions';

// WHICH PLAN STATE the Plans list is filtered to — the query parameter and its
// parser (MOTIR-6025, `design/ai-planning/design-notes.md` Part XIX §19.1).
//
// ⚠️ A PURE MODULE, NOT AN EXPORT OF THE `'use client'` FILTER COMPONENT, and
// that is a correctness constraint (MOTIR-3243): a Server Component that
// imports even a pure function through a client module gets a client REFERENCE
// that throws on call, and `/plans` 500s on every request. Both sides import
// from here.
//
// THE URL IS THE SINGLE SOURCE OF TRUTH for the filter in view: the page derives
// it on every render, so a deep link, a reload and Back/forward all agree.

/** The query parameter that carries the chosen plan state. */
export const PLAN_STATE_PARAM = 'planState';

/** The query parameter that names a session to land on (the overlay's notice). */
export const PLAN_SESSION_LANDING_PARAM = 'session';

/**
 * The filter a URL selects — a plan state, or `null` for ALL, the default.
 *
 * All is the default, not a state (§19.1): it writes a CLEAN url, and it opens on
 * everything the page can show. (The sessions spec's other reason — that a
 * conversation that never proposed anything is findable — was retired with
 * MOTIR-9217: such a conversation is no longer listed, which is why `none` left the
 * FILTER vocabulary while staying a row state.)
 *
 * Unknown / absent / malformed → All, never an error: the value comes from a
 * URL a person can type. `?planState=none` is one of those now (MOTIR-9301).
 */
export function planStateFromParam(raw: string | null | undefined): PlanSessionFilterDto | null {
  return (PLAN_SESSION_FILTER_VALUES as readonly string[]).includes(raw ?? '')
    ? (raw as PlanSessionFilterDto)
    : null;
}
