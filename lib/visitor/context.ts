import type { Project } from '@/generated/prisma/client';
import type { PermissionKey } from '@/lib/permissions/catalog';

// The VISITOR's read context (Story MOTIR-6170 · MOTIR-6642) — the ONE value
// every Visitor read takes: the collection reads, the rooms, the name-only person
// shape and the client data doors. `projectAccessService.resolveVisitor` is the
// only thing that builds one.
//
// It carries a `kind: 'visitor'` discriminant so a service can never mistake it
// for a member's workspace context: a Visitor has NO workspace of their own in
// this project, and nothing in it may be passed where a `WorkspaceContext` is
// expected.

/** A Visitor's standing on ONE public project. */
export interface VisitorReadContext {
  readonly kind: 'visitor';
  /** The public project being read — resolved and proved `public` already. */
  readonly project: Project;
  /** The session's user when signed in (another org, or a Limited non-entrant); `null` when anonymous. */
  readonly actorUserId: string | null;
  /** Always {@link VISITOR_PERMISSIONS} — the Viewer's set, nothing that writes. */
  readonly permissions: ReadonlySet<PermissionKey>;
  /**
   * The ids of every descendant of a PRIVATE epic (`epic-privacy.md` §3), read
   * once at resolution. Every Visitor read excludes these; the private epic's
   * own row is not in the set.
   */
  readonly hiddenIds: ReadonlySet<string>;
}

/**
 * The three answers {@link projectAccessService.resolveVisitor} gives for a
 * Visitor URL:
 *
 * - `not_found` — cloud off, no such project, or a project that is not public.
 *   ONE indistinguishable answer, so a stranger can never learn a private
 *   project exists.
 * - `enter` — the signed-in person can ENTER the project; they belong in their
 *   own in-app view, and the route tree redirects them there.
 * - `visitor` — everyone else, with the context every Visitor read takes.
 */
export type VisitorVerdict =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'enter'; readonly project: Project }
  | { readonly kind: 'visitor'; readonly ctx: VisitorReadContext };

/** The not-found verdict — one frozen value, so every refusal is deep-equal. */
export const VISITOR_NOT_FOUND: VisitorVerdict = Object.freeze({ kind: 'not_found' as const });
