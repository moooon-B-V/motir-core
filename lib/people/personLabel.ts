// A person as a VISITOR may see them (Story MOTIR-6170 · MOTIR-6646;
// `role-model.md` Q3 — "read paths scrub person identities to display names").
//
// The real app's payloads were written for colleagues and carry email addresses
// for ordinary reasons: a member list behind the assignee column, a lane label's
// `name || email`, the `"Name <email>"` stored on every approval decision. A
// Visitor reads the same pages, so every reader that serves one maps its people
// through THIS shape — an id and a display name, and nothing else.

/** A person, name only. The `name` is never empty and never any part of an email. */
export interface PersonLabel {
  id: string;
  name: string;
}

/**
 * The neutral label for a person with no display name — the copy the Visitor
 * view's draft design settled (MOTIR-6641: "Project member"). The client renders
 * the `common.personFallback` message key; this constant is the server-side twin
 * for payloads that carry the label itself.
 */
export const PERSON_FALLBACK_LABEL = 'Project member';

/**
 * The trimmed display name, or {@link PERSON_FALLBACK_LABEL}. It NEVER falls back
 * to the email or its local part — that fallback is exactly what this exists to
 * stop.
 */
export function personName(name: string | null | undefined): string {
  const trimmed = name?.trim();
  return trimmed ? trimmed : PERSON_FALLBACK_LABEL;
}

/** A user row as a {@link PersonLabel}. Reads `id` and `name` only. */
export function toPersonLabel(user: { id: string; name: string | null }): PersonLabel {
  return { id: user.id, name: personName(user.name) };
}

/**
 * The name a CLIENT component draws for a person it was handed. It reads `name`
 * and nothing else: a member's list already fills `name` (the workspace mapper
 * never leaves it empty) and a Visitor's list is name-only, so an `email`
 * fallback could only ever show an address. `fallback` is the translated
 * `common.personFallback`.
 */
export function personDisplayName(
  person: { name?: string | null } | null | undefined,
  fallback: string = PERSON_FALLBACK_LABEL,
): string {
  const trimmed = person?.name?.trim();
  return trimmed ? trimmed : fallback;
}
