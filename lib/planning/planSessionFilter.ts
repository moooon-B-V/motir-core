import { PLAN_SESSION_STATE_VALUES, type PlanSessionStateDto } from '@/lib/dto/planSessions';

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
 * All is the default, not a state (§19.1): the story's first promise is that a
 * conversation that never proposed anything is findable, and the only default
 * that shows it without a click is All. It writes a CLEAN url.
 *
 * Unknown / absent / malformed → All, never an error: the value comes from a
 * URL a person can type.
 */
export function planStateFromParam(raw: string | null | undefined): PlanSessionStateDto | null {
  return (PLAN_SESSION_STATE_VALUES as readonly string[]).includes(raw ?? '')
    ? (raw as PlanSessionStateDto)
    : null;
}
